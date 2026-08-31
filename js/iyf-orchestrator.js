// iyf.tv 多集下载 —— background 编排器(chrome 胶水层)
// 依赖加载顺序:iyf-common.js(IYF)、iyf-api.js(iyfFetchPlay)、iyf-job.js(IYF_JOB)先于本文件 importScripts。
// 职责:收 iyfStartJob/iyfCancelJob/iyfJobState 消息(挂接在 background.js 消息分发),
//       受背压逐集 iyfFetchPlay 取流 → pickQuality 选档 → openParser 开下载 tab,
//       下载 tab 关闭(autoClose 下完自关)即视为该集结束。
// ponytail: 同一时刻只跑一个 job;service worker 重启只恢复快照展示、不续跑(恢复时标记取消),要续跑再加。

let iyfJob = null;              // 当前 job(内存态,快照同步写 storage)
let iyfJobTabId = null;         // 发起 job 的 iyf 页面 tabId(注入取数用)
let iyfJobInitiator = '';       // iyf 页面 url,传给解析器做 referer
const iyfParserTabs = new Map();    // 下载 tab id -> 集索引

const iyfStorage = chrome.storage.session ?? chrome.storage.local;

function iyfSaveJob() {
    iyfStorage.set({ iyfJobSnapshot: iyfJob ? IYF_JOB.snapshot(iyfJob) : null });
}

// worker 启动:上次快照若未结束,标记取消+结束(tab→集 映射已丢,无法续跑;已开的下载 tab 不受影响会自行下完)
iyfStorage.get({ iyfJobSnapshot: null }, function (items) {
    const snap = items.iyfJobSnapshot;
    if (snap && !snap.finished) {
        snap.cancelled = true;
        snap.finished = true;
        snap.restored = true;
        iyfStorage.set({ iyfJobSnapshot: snap });
    }
});

// 发起任务。message: {tabId, seriesKey, seriesTitle, episodes:[{key,name}], quality}
async function iyfStartJob(message) {
    if (iyfJob && !IYF_JOB.isFinished(iyfJob)) { return { ok: false, err: 'job already running' }; }
    const eps = Array.isArray(message.episodes) ? message.episodes : [];
    if (!message.tabId || !eps.length) { return { ok: false, err: 'missing tabId/episodes' }; }
    // 启动签名探针:清旧密钥缓存 → 对第一集签名调一次 video/play。
    // code==1(用户签名错误)=> 签名规则已变,中止不建 job;code==0 或有 clarity => 继续。
    // pConfig 读取失败/网络失败 => 直接把 err 上抛,不建 job。
    iyfResetPConfig(message.tabId);
    const probe = await iyfFetchPlay(message.tabId, eps[0].key);
    if (probe.code == 1) { return { ok: false, err: '签名规则已变,需更新签名模块' }; }
    if (!probe.ok && probe.code != 0) { return { ok: false, err: probe.err || '签名探针失败' }; }
    // 并发上限:默认 3,可用 chrome.storage.local 的 iyfParallel 覆盖(无 options UI)
    const items = await chrome.storage.local.get({ iyfParallel: 3 });
    iyfJob = IYF_JOB.createJob({
        seriesKey: message.seriesKey,
        seriesTitle: message.seriesTitle,
        quality: message.quality,
        episodes: eps,
        concurrency: items.iyfParallel,
        maxRetries: 2,
    });
    iyfJobTabId = message.tabId;
    iyfJobInitiator = '';
    try {
        const tab = await chrome.tabs.get(message.tabId);
        iyfJobInitiator = (tab && tab.url) ? tab.url : '';
    } catch (e) { /* 拿不到就不带 referer */ }
    iyfParserTabs.clear();
    iyfSaveJob();
    iyfPump();
    return { ok: true, state: IYF_JOB.snapshot(iyfJob) };
}

// 取消:不再推进新集;已开的下载 tab 不强杀
function iyfCancelJob() {
    if (!iyfJob) { return { ok: false, err: 'no job' }; }
    IYF_JOB.cancel(iyfJob);
    iyfSaveJob();
    return { ok: true, state: IYF_JOB.snapshot(iyfJob) };
}

// 查询快照(worker 重启后内存无 job 时读 storage 里的最后快照)
async function iyfJobStateQuery() {
    if (iyfJob) { return { ok: true, state: IYF_JOB.snapshot(iyfJob) }; }
    const items = await iyfStorage.get({ iyfJobSnapshot: null });
    return { ok: true, state: items.iyfJobSnapshot };
}

// 编排循环:背压放行多少集就启动多少集
function iyfPump() {
    if (!iyfJob) { return; }
    for (const i of IYF_JOB.startable(iyfJob)) {
        IYF_JOB.markFetching(iyfJob, i);
        iyfRunEpisode(i);
    }
    iyfSaveJob();
}

// 单集流程:取画质档 → 选档 → 开下载 tab
async function iyfRunEpisode(i) {
    const job = iyfJob;
    const ep = job.episodes[i];
    try {
        const res = await iyfFetchPlay(iyfJobTabId, ep.key);
        if (job !== iyfJob) { return; } // job 已被替换,丢弃
        if (!res || !res.ok) { iyfEpisodeFailed(i, (res && res.err) || 'fetch play failed'); return; }
        const q = IYF.pickQuality(res.clarity, job.quality);
        if (!q) { iyfEpisodeFailed(i, 'no downloadable quality'); return; }
        // 给 chunklist(m3u8)URL 签名后喂 openParser。关键机制(端到端实测确认):
        //   CDN 收到带 vv/pub 的 chunklist 请求后,会把这份 vv/pub 回填进返回体里每个 ts 的绝对 URL
        //   (vendtime/vhash 等 CDN token 原样保留),m3u8.js 直接照用即可下成。
        // 因此【不用 tsAddArg】:m3u8.js 的 tsAddArg 会用 RegExp("([^?]*)") 截掉 ts 原有 query、
        //   只留 vv/pub,把 vendtime/vhash 冲掉 → CDN reset → 卡 0/215(这正是 T5 的真因)。
        // 只要 chunklist 本身签好,ts 就自带完整签名,无需再动。
        const pc = await iyfGetPConfig(iyfJobTabId);
        if (job !== iyfJob) { return; }
        if (!pc.ok) { iyfEpisodeFailed(i, pc.err); return; }
        const signedUrl = iyfSignUrl(q.url, pc.pConfig.publicKey, pc.pConfig.privateKey);
        const title = IYF.sanitizeFilePart(job.seriesTitle) || job.seriesKey;
        const epName = `${title}-第${IYF.padEpisodeNo(ep.name)}集`;
        const filename = `${title}/${epName}.mp4`;
        iyfWatchParserTab(filename, i);
        IYF_JOB.markDownloading(job, i);
        iyfSaveJob();
        openParser({
            url: signedUrl,
            title: epName,
            downFileName: filename,
            tabId: iyfJobTabId,
            initiator: iyfJobInitiator,
        }, { autoDown: true, autoClose: true, forceLocal: 1 });
    } catch (e) {
        if (job !== iyfJob) { return; }
        iyfEpisodeFailed(i, e);
    }
}

function iyfEpisodeFailed(i, err) {
    IYF_JOB.markFailed(iyfJob, i, err); // 未耗尽重试会自动回 pending,由下面 pump 再放行
    iyfSaveJob();
    iyfPump();
}

// 捕获 openParser 开出的下载 tab id:openParser 不回传 tab,靠 onCreated 按 filename 参数匹配。
// filename 用与 openParser 相同的 URLSearchParams 编码,保证子串匹配确定命中。
function iyfWatchParserTab(filename, epIndex) {
    const marker = new URLSearchParams({ filename: filename }).toString();
    const base = chrome.runtime.getURL('m3u8.html');
    const listener = function (tab) {
        const url = tab.pendingUrl || tab.url || '';
        if (url.startsWith(base) && url.includes(marker)) {
            chrome.tabs.onCreated.removeListener(listener);
            clearTimeout(timer);
            iyfParserTabs.set(tab.id, epIndex);
        }
    };
    // ponytail: 10 秒没等到 tab 就撤监听防泄漏,该集会停在下载中,靠取消收尾;真遇到再加超时转失败
    const timer = setTimeout(function () { chrome.tabs.onCreated.removeListener(listener); }, 10000);
    chrome.tabs.onCreated.addListener(listener);
}

// 集完成信号:下载 tab 关闭(autoClose 下完自关)即视为该集结束
// ponytail: 用户手动关 tab 也会计成完成,无法区分;要精确需改 m3u8.js 回报消息,本版不动核心
chrome.tabs.onRemoved.addListener(function (tabId) {
    if (!iyfParserTabs.has(tabId)) { return; }
    const i = iyfParserTabs.get(tabId);
    iyfParserTabs.delete(tabId);
    if (!iyfJob) { return; }
    IYF_JOB.markDone(iyfJob, i);
    iyfSaveJob();
    iyfPump();
});
