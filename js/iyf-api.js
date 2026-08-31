// iyf.tv 多集下载 —— API 客户端(background 侧)
// 取数必须在 iyf 页面上下文里 fetch(带该页 cookie + 跨子域 CORS 才成立),不能在 background 直接 fetch。
// 用 chrome.scripting.executeScript({world:'MAIN'}) 注入执行,把裸响应 JSON 传回 background 再由 IYF.* 纯函数解析。
// 依赖:importScripts("/js/iyf-common.js") 先于本文件加载(提供全局 IYF)。

// API 域名兜底:m10 拿不到时试 rankv21
const IYF_API_HOSTS = ['m10.iyf.tv', 'rankv21.iyf.tv'];

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
    // ponytail: cid=0,1,4,146 等参数可能因剧而异——待端到端核实(能否从页面已有请求/全局拿真实参数)
    const vid = encodeURIComponent(seriesKey);
    const urls = IYF_API_HOSTS.map(function (h) {
        return `https://${h}/v3/video/languagesplaylist?cinema=1&vid=${vid}&lsk=1&taxis=0&cid=0,1,4,146`;
    });
    try {
        const json = await iyfInjectFetch(tabId, urls);
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
    // video/play 裸调:带 cookie、无需 vv/pub 签名
    const id = encodeURIComponent(episodeKey);
    const urls = IYF_API_HOSTS.map(function (h) {
        return `https://${h}/v3/video/play?cinema=1&id=${id}&a=1&lang=none&usersign=1&device=1&isMasterSupport=1`;
    });
    try {
        const json = await iyfInjectFetch(tabId, urls);
        const clarity = IYF.parsePlayInfo(json);
        if (!clarity.length) { return { ok: false, err: 'empty clarity', clarity: [] }; }
        return { ok: true, clarity: clarity };
    } catch (e) {
        return { ok: false, err: String(e), clarity: [] };
    }
}
