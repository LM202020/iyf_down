// iyf.tv 多集下载 —— background 编排器(chrome 胶水层)
// 依赖加载顺序:iyf-common.js(IYF)、iyf-api.js(iyfFetchPlay)、iyf-job.js(IYF_JOB)先于本文件 importScripts。
// 职责:收 iyfStartJob/iyfCancelJob/iyfJobState 消息(挂接在 background.js 消息分发),
//       受背压逐集 iyfFetchPlay 取流 → pickQuality 选档 → 签名 → iyfDispatchDownload 派给 offscreen
//       单例文档(iyf-dl.html,不占标签栏)并行下载;它上报进度/交 blob,由本层落盘并按集索引结算。
// ponytail: 同一时刻只跑一个 job;service worker 重启只恢复快照展示、不续跑(恢复时标记取消),要续跑再加。

let iyfJob = null;              // 当前 job(内存态,快照同步写 storage)
let iyfJobTabId = null;         // 发起 job 的 iyf 页面 tabId(注入取数用)
let iyfJobInitiator = '';       // iyf 页面 url,传给解析器做 referer
// 下载跑在 offscreen 单例文档里(不占标签栏),集与集靠 index 区分,不再需要 tab 映射

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
    iyfResetAuth(message.tabId);   // 登录凭证也重读,避免换账号/重登后用旧凭证
    const probe = await iyfFetchPlay(message.tabId, eps[0].key);
    if (probe.rateLimited) { return { ok: false, err: probe.err }; } // 访问过量:透传友好提示,别当签名/结构问题
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
    iyfNextFetchAt = 0;   // 重置取数节流计时器,新 job 首集不受上个 job 残留延迟
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

// 取数节流:站点对短时并发 video/play 有「访问过量」频率风控(端到端实测:批量并发取数 →
// 播放页被重定向 iyf.tv/challenge?triggerindex=访问过量 → 后续集 empty clarity)。
// 逐集取数串成固定间隔的队列错开(下载走 CDN 不撞风控,不节流、并发照旧)。
// ponytail: 3s 是经验值(站点未公开阈值);仍撞就调大,或改成撞风控退避重试。
const IYF_FETCH_GAP_MS = 3000;
let iyfNextFetchAt = 0;
function iyfThrottleFetch() {
    const now = Date.now();
    const at = Math.max(now, iyfNextFetchAt);
    iyfNextFetchAt = at + IYF_FETCH_GAP_MS;
    return new Promise(function (r) { setTimeout(r, at - now); });
}

// 单集流程:取画质档 → 选档 → 开下载 tab
async function iyfRunEpisode(i) {
    const job = iyfJob;
    const ep = job.episodes[i];
    try {
        await iyfThrottleFetch();        // 取数前过节流闸,规避站点频率风控
        if (job !== iyfJob) { return; }  // 排队期间 job 被取消/替换 → 丢弃
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
        IYF_JOB.markDownloading(job, i);
        iyfSaveJob();
        iyfDispatchDownload({ url: signedUrl, filename: filename, index: i });
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

// 派单集下载任务给 offscreen 文档(MV3 单例后台页,不占标签栏)。多集并行都跑在这一个文档里。
async function iyfDispatchDownload(ep) {
    try {
        if (!(await chrome.offscreen.hasDocument())) {
            await chrome.offscreen.createDocument({
                url: '/iyf-dl.html',
                reasons: ['BLOBS'],
                justification: 'iyf 多集下载:拉 HLS 分片、转封装 MP4 并生成 blob 交后台落盘',
            });
        }
        chrome.runtime.sendMessage({
            Message: 'iyfDlStart',
            task: { index: ep.index, url: ep.url, filename: ep.filename },
        });
    } catch (e) {
        iyfEpisodeFailed(ep.index, '创建下载环境失败:' + String(e));
    }
}

// 幂等锚点:offscreen 内多集并行,靠集索引区分;已 done/failed 的集再来消息一律丢弃。
function iyfSettled(i) {
    const ep = iyfJob && iyfJob.episodes[i];
    return !ep || ep.status === IYF_JOB.STATUS.DONE || ep.status === IYF_JOB.STATUS.FAILED;
}

// 切片进度上报:只写快照供面板显示,不动状态机
function iyfHandleEpisodeProgress(index, done, total, phase) {
    if (!iyfJob || index == null || iyfSettled(index)) { return; }
    IYF_JOB.markProgress(iyfJob, index, done, total, phase);
    iyfSaveJob();
}

// offscreen 转封装完把 blob URL 交过来,由 background 落盘(offscreen 拿不到 chrome.downloads)。
// 等 state=complete 才算该集完成,随后通知 offscreen 回收 blob。
function iyfHandleEpisodeBlob(index, blobUrl, filename) {
    if (!iyfJob || index == null || iyfSettled(index)) { return; }
    chrome.downloads.download({ url: blobUrl, filename: filename, saveAs: false }, function (id) {
        if (chrome.runtime.lastError || !id) {
            chrome.runtime.sendMessage({ Message: 'iyfDlRevoke', blobUrl: blobUrl });
            iyfHandleEpisodeFailed(index, chrome.runtime.lastError ? chrome.runtime.lastError.message : '下载未启动');
            return;
        }
        const onChanged = function (delta) {
            if (delta.id !== id || !delta.state) { return; }
            if (delta.state.current === 'complete') {
                chrome.downloads.onChanged.removeListener(onChanged);
                chrome.runtime.sendMessage({ Message: 'iyfDlRevoke', blobUrl: blobUrl });
                iyfHandleEpisodeDone(index);
            } else if (delta.state.current === 'interrupted') {
                chrome.downloads.onChanged.removeListener(onChanged);
                chrome.runtime.sendMessage({ Message: 'iyfDlRevoke', blobUrl: blobUrl });
                iyfHandleEpisodeFailed(index, '落盘中断:' + (delta.error ? delta.error.current : 'unknown'));
            }
        };
        chrome.downloads.onChanged.addListener(onChanged);
    });
}

function iyfHandleEpisodeDone(index) {
    if (!iyfJob || index == null || iyfSettled(index)) { return; }
    IYF_JOB.markDone(iyfJob, index);
    iyfSaveJob();
    iyfPump();
    iyfCloseOffscreenIfIdle();
}

function iyfHandleEpisodeFailed(index, err) {
    if (!iyfJob || index == null || iyfSettled(index)) { return; }
    iyfEpisodeFailed(index, err || 'download failed');
    iyfCloseOffscreenIfIdle();
}

// job 收尾就关掉 offscreen,不常驻占资源
async function iyfCloseOffscreenIfIdle() {
    if (iyfJob && !IYF_JOB.isFinished(iyfJob)) { return; }
    try {
        if (await chrome.offscreen.hasDocument()) { await chrome.offscreen.closeDocument(); }
    } catch (e) { /* 已关闭 */ }
}
