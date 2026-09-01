// iyf.tv 多集下载 —— API 客户端(background 侧)
// 取数必须在 iyf 页面上下文里 fetch(带该页 cookie + 跨子域 CORS 才成立),不能在 background 直接 fetch。
// 用 chrome.scripting.executeScript({world:'MAIN'}) 注入执行,把裸响应 JSON 传回 background 再由 IYF.* 纯函数解析。
// 依赖:importScripts("/js/iyf-common.js") 先于本文件加载(提供全局 IYF)。

// API 域名兜底:m10 拿不到时试 rankv21
const IYF_API_HOSTS = ['m10.iyf.tv', 'rankv21.iyf.tv'];

// 密钥对缓存:tabId -> {publicKey, privateKey}(单 job 单 tab,job 起始 iyfResetPConfig 清一次保新鲜)
const iyfPConfigCache = new Map();

// 纯函数:给一个 API/m3u8 URL 拼签名后缀。sign 归一化只认 vv/pub 以外的参数,故追加末尾即可。
// vv 为十六进制、pub 为明文 publicKey(样本纯字母数字)→ 原样追加,不 encode(与站点一致)。
function iyfSignUrl(url, publicKey, privateKey) {
    const s = IYF_SIGN.sign(url, publicKey, privateKey);
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'vv=' + s.vv + '&pub=' + s.pub;
}

// 注入到 MAIN world 读密钥对:先从当前 DOM 抠——pConfig 就内联在播放页 HTML 里,页面已经
// 带着它了,不必再问一次网络。原实现只走 fetch(location.href),而那一步会被站点自己的
// Service Worker、HTTP 缓存、其它扩展拦截或喂旧内容(真机实测有环境因此读不到)。
// DOM 里没有(SPA 客户端路由进来的页面可能不含)才 fetch 兜底,并绕开缓存。
// 序列化限制:不能引用任何外部闭包变量。拿不到返回 null。
async function iyfMainReadPConfig() {
    const re = /"pConfig":\{"publicKey":"([^"]+)","privateKey":(\[[^\]]*\])\}/;
    function pick(text) {
        const m = text && text.match(re);
        if (!m) { return null; }
        try {
            const priv = JSON.parse(m[2]);
            return (Array.isArray(priv) && priv.length) ? { publicKey: m[1], privateKey: priv } : null;
        } catch (e) { return null; }
    }
    try {
        const fromDom = pick(document.documentElement.innerHTML);
        if (fromDom) { return fromDom; }
    } catch (e) { /* DOM 读不了就走下面的 fetch */ }
    try {
        const resp = await fetch(location.href, { credentials: 'include', cache: 'reload' });
        return pick(await resp.text());
    } catch (e) { return null; }
}

// 读密钥对(每 tab 缓存一次)→ {ok, pConfig} | {ok:false, err}。拿不到 pConfig 直接报错,不做站点 fallback。
async function iyfGetPConfig(tabId) {
    if (!tabId) { return { ok: false, err: 'missing tabId' }; }
    if (iyfPConfigCache.has(tabId)) { return { ok: true, pConfig: iyfPConfigCache.get(tabId) }; }
    let res;
    try {
        res = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: 'MAIN',
            func: iyfMainReadPConfig,
        });
    } catch (e) { return { ok: false, err: '读取密钥对失败:' + String(e) }; }
    const pConfig = res && res[0] ? res[0].result : null;
    if (!pConfig || !pConfig.publicKey || !Array.isArray(pConfig.privateKey) || !pConfig.privateKey.length) {
        // 别再把这里归因成「没登录」:实测未登录裸请求播放页同样返回 pConfig,它与登录态无关。
        return { ok: false, err: '未读到密钥对——页面里没找到 pConfig。请刷新播放页后重试;仍失败则可能是站点页面结构已变' };
    }
    iyfPConfigCache.set(tabId, pConfig);
    return { ok: true, pConfig: pConfig };
}

// 清一个 tab 的密钥对缓存(job 起始调,避免上次 job / 页面重载后的旧密钥被误判成「签名规则已变」)
function iyfResetPConfig(tabId) {
    iyfPConfigCache.delete(tabId);
}

// 登录账号凭证缓存:tabId -> {uid, expire, gid, sign, token}
const iyfAuthCache = new Map();

// 注入 MAIN world 读登录凭证:cookie dn_temp 里的 __t JSON 含 {uid,expire,gid,sign,token}。
// 真机抓包实证(2026-09-01):站点调 video/play 是「账号凭证 + vv/pub」两套一起带;只带 vv/pub
// (游客签名)去要登录内容,站点回 {"data":{"code":5,"msg":"访问过量"}}——那不是频率限制,是拒绝话术。
// 序列化限制:不能引用任何外部闭包变量。未登录返回 null。
function iyfMainReadAuth() {
    try {
        let dn = '';
        document.cookie.split(';').forEach(function (s) {
            const i = s.indexOf('=');
            if (i < 0) { return; }
            if (s.slice(0, i).trim() === 'dn_temp') {
                try { dn = decodeURIComponent(s.slice(i + 1)); } catch (e) { dn = s.slice(i + 1); }
            }
        });
        const m = dn.match(/__t=(\{.*\})/);
        if (!m) { return null; }
        const t = JSON.parse(m[1]);
        if (!t || !t.uid || !t.sign || !t.token) { return null; }
        return { uid: t.uid, expire: t.expire, gid: t.gid, sign: t.sign, token: t.token };
    } catch (e) { return null; }
}

// 读登录凭证(每 tab 缓存)→ {ok, auth} | {ok:false, err, needLogin}
async function iyfGetAuth(tabId) {
    if (!tabId) { return { ok: false, err: 'missing tabId' }; }
    if (iyfAuthCache.has(tabId)) { return { ok: true, auth: iyfAuthCache.get(tabId) }; }
    let res;
    try {
        res = await chrome.scripting.executeScript({
            target: { tabId: tabId }, world: 'MAIN', func: iyfMainReadAuth,
        });
    } catch (e) { return { ok: false, err: '读取登录凭证失败:' + String(e) }; }
    const auth = res && res[0] ? res[0].result : null;
    if (!auth) { return { ok: false, err: '未登录 iyf 账号——请先在页面登录后重试(取流需要登录态凭证)', needLogin: true }; }
    iyfAuthCache.set(tabId, auth);
    return { ok: true, auth: auth };
}

function iyfResetAuth(tabId) { iyfAuthCache.delete(tabId); }

// 账号凭证拼成 query 片段。必须在算 vv/pub 之前拼上——vv 是对「含账号参数的完整 query」算的 md5。
function iyfAuthQuery(auth) {
    return `&uid=${auth.uid}&expire=${auth.expire}&gid=${auth.gid}&sign=${auth.sign}&token=${auth.token}`;
}

// 注入到 MAIN world 的取数函数:依次试各 url,返回首个成功的 JSON;全失败返回 null。
// executeScript 序列化限制:此函数不能引用任何外部闭包变量,一切走 args。
async function iyfMainFetch(urls) {
    for (const u of urls) {
        try {
            const resp = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } });
            if (!resp.ok) { continue; }
            return await resp.json();
        } catch (e) { /* 试下一个域名 */ }
    }
    return null;
}

// 在 tabId(iyf 页面)MAIN world 执行 iyfMainFetch,拿回裸 JSON(失败返回 null)
async function iyfInjectFetch(tabId, urls) {
    const res = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: iyfMainFetch,
        args: [urls],
    });
    return res && res[0] ? res[0].result : null;
}

// 拿全集列表 → {ok, episodes:[{key,name,index}], err?}
async function iyfFetchPlayList(tabId, seriesKey) {
    if (!tabId || !seriesKey) { return { ok: false, err: 'missing tabId/seriesKey', episodes: [] }; }
    const pc = await iyfGetPConfig(tabId);
    if (!pc.ok) { return { ok: false, err: pc.err, episodes: [] }; }
    const ac = await iyfGetAuth(tabId);
    if (!ac.ok) { return { ok: false, err: ac.err, episodes: [], needLogin: ac.needLogin }; }
    // ponytail: cid=0,1,4,146 等参数可能因剧而异——待端到端核实(能否从页面已有请求/全局拿真实参数)
    const vid = encodeURIComponent(seriesKey);
    const urls = IYF_API_HOSTS.map(function (h) {
        const u = `https://${h}/v3/video/languagesplaylist?cinema=1&vid=${vid}&lsk=1&taxis=0&cid=0,1,4,146` + iyfAuthQuery(ac.auth);
        return iyfSignUrl(u, pc.pConfig.publicKey, pc.pConfig.privateKey);
    });
    try {
        const json = await iyfInjectFetch(tabId, urls);
        if (IYF.detectRateLimit(json)) { return { ok: false, err: 'iyf 回「访问过量」——通常是登录凭证缺失/失效,请重新登录后重试', episodes: [], rateLimited: true }; }
        const episodes = IYF.parsePlayList(json);
        if (!episodes.length) { return { ok: false, err: 'empty playlist', episodes: [] }; }
        return { ok: true, episodes: episodes };
    } catch (e) {
        return { ok: false, err: String(e), episodes: [] };
    }
}

// 拿单集画质档+流地址 → {ok, clarity:[{title,description,bitrate,isVIP,isEnabled,downloadable,url}], err?}
async function iyfFetchPlay(tabId, episodeKey) {
    if (!tabId || !episodeKey) { return { ok: false, err: 'missing tabId/episodeKey', clarity: [] }; }
    const pc = await iyfGetPConfig(tabId);
    if (!pc.ok) { return { ok: false, err: pc.err, clarity: [] }; }
    const ac = await iyfGetAuth(tabId);
    if (!ac.ok) { return { ok: false, err: ac.err, clarity: [], needLogin: ac.needLogin }; }
    // video/play 必须「账号凭证 + vv/pub」两套签名一起带(真机抓包照抄站点;只带 vv/pub 会被回
    // code:5「访问过量」)。region 实测可省。vv/pub 由 iyfSignUrl 对含账号参数的完整 query 计算。
    // a=0 表示按「具体分集 key」取流;a=1 是「系列聚合」模式,只认剧集页 key、对分集 key 返回「视频不存在」。
    const id = encodeURIComponent(episodeKey);
    const urls = IYF_API_HOSTS.map(function (h) {
        const u = `https://${h}/v3/video/play?cinema=1&id=${id}&a=0&usersign=1&device=1&isMasterSupport=1` + iyfAuthQuery(ac.auth);
        return iyfSignUrl(u, pc.pConfig.publicKey, pc.pConfig.privateKey);
    });
    try {
        const json = await iyfInjectFetch(tabId, urls);
        // code:5「访问过量」= 登录凭证缺失/失效的拒绝话术(非频率限制,真机对照实证)
        if (IYF.detectRateLimit(json)) { return { ok: false, err: 'iyf 回「访问过量」——通常是登录凭证缺失/失效,请重新登录后重试', clarity: [], rateLimited: true }; }
        const clarity = IYF.parsePlayInfo(json);
        // code 透传给启动探针判「签名规则已变」(code==1=用户签名错误)
        const code = json && typeof json.code !== 'undefined' ? json.code : undefined;
        if (!clarity.length) { return { ok: false, err: 'empty clarity', clarity: [], code: code }; }
        return { ok: true, clarity: clarity, code: code };
    } catch (e) {
        return { ok: false, err: String(e), clarity: [] };
    }
}

// ---- 自检:node js/iyf-api.js 退出码 0 即通过(只测纯函数 iyfSignUrl,不依赖 chrome)----
if (typeof require !== 'undefined' && require.main === module) {
    const assert = require('assert');
    global.IYF_SIGN = require('./iyf-sign.js');
    // 站点真实向量(scratchpad verify_*.py 实证 getPaymentInfo):签名后缀拼接正确,vv 精确匹配站点
    assert.strictEqual(
        iyfSignUrl('https://m10.iyf.tv/api/payment/getPaymentInfo?isPromotion=3&region=DE', '1788194763980', ['vcrsion001']),
        'https://m10.iyf.tv/api/payment/getPaymentInfo?isPromotion=3&region=DE&vv=b2491a91b01a7cb39595806efae8eebc&pub=1788194763980'
    );
    // 无 query 的 URL 用 ? 起头(m3u8 URL 兜底)
    assert.strictEqual(iyfSignUrl('https://x/a', 'P', ['k']).indexOf('https://x/a?vv='), 0);
    console.log('iyf-api self-check: all assertions passed');
}
