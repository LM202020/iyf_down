// iyf.tv 多集下载 —— 基础层纯函数(不依赖 chrome API,浏览器/node 通用)
// UMD 挂载:浏览器挂到 window.IYF,node 走 module.exports。
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.IYF = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    // 镜像域名家族;匹配时允许任意子域前缀(如 www.iyf.tv)
    const IYF_HOSTS = ['iyf.tv', 'aiyifan.tv', 'dnvod.tv', 'ifsp.tv', 'jssp.tv', 'kubb.tv', 'lgsp.tv', 'flyv.tv'];

    // 从 url 或裸 host 提取 host(小写)
    function toHost(urlOrHost) {
        if (!urlOrHost || typeof urlOrHost !== 'string') { return ''; }
        let s = urlOrHost.trim().toLowerCase();
        try {
            s = new URL(s).hostname;
        } catch (e) {
            // 不是完整 url,当作裸 host,去掉可能的端口/路径
            s = s.replace(/^\/\//, '').split('/')[0].split(':')[0];
        }
        return s;
    }

    // 命中镜像家族任一域名(含子域)
    function isIyfHost(urlOrHost) {
        const host = toHost(urlOrHost);
        if (!host) { return false; }
        return IYF_HOSTS.some(d => host === d || host.endsWith('.' + d));
    }

    // 从 /play/<剧key> 提取剧 key,取不到返回 null
    function parseSeriesKey(url) {
        if (!url || typeof url !== 'string') { return null; }
        const m = url.match(/\/play\/([^/?#]+)/);
        return m ? m[1] : null;
    }

    // 剥离标题尾巴,返回纯剧名。标题格式 <剧名>-NN-免费在线观看-爱壹帆
    function cleanSeriesTitle(title) {
        if (!title || typeof title !== 'string') { return ''; }
        let t = title.trim();
        t = t.replace(/-\d+-免费在线观看-爱壹帆$/, '');
        // 兜底:无集号时去掉结尾 -免费在线观看-爱壹帆
        t = t.replace(/-免费在线观看-爱壹帆$/, '');
        return t.trim();
    }

    // 集号零填充两位("1"→"01","10"→"10","100"→"100")
    function padEpisodeNo(n) {
        return String(n).padStart(2, '0');
    }

    // 把选择归一成有序、去重的集索引(0-based)数组。
    // selection: {mode:'all'} | {mode:'range',from,to} | {mode:'pick',indexes:[...]}
    // total: 总集数,用于越界钳制
    function expandEpisodeRange(selection, total) {
        total = Math.max(0, total | 0);
        if (total === 0) { return []; }
        const all = () => Array.from({ length: total }, (_, i) => i);
        if (!selection || selection.mode === 'all') { return all(); }
        if (selection.mode === 'range') {
            let from = selection.from | 0;
            let to = selection.to | 0;
            if (from > to) { [from, to] = [to, from]; }
            from = Math.max(0, from);
            to = Math.min(total - 1, to);
            if (from > total - 1 || to < 0) { return []; }
            const out = [];
            for (let i = from; i <= to; i++) { out.push(i); }
            return out;
        }
        if (selection.mode === 'pick') {
            const idx = Array.isArray(selection.indexes) ? selection.indexes : [];
            const set = new Set();
            for (const v of idx) {
                const i = v | 0;
                if (i >= 0 && i < total) { set.add(i); }
            }
            return Array.from(set).sort((a, b) => a - b);
        }
        return [];
    }

    // 去掉文件名/目录名非法字符(跟随猫抓 reFilterFileName 的字符集,另去路径分隔符)
    function sanitizeFilePart(s) {
        if (s === undefined || s === null) { return ''; }
        return String(s).replace(/[<>:"|?*~/\\]/g, '').replace(/\s+/g, ' ').trim();
    }

    // 解析 v3/video/languagesplaylist 响应 → [{key,name,index}](0-based)。空/异常返回 []
    function parsePlayList(json) {
        const list = json && json.data && json.data.info && json.data.info[0] && json.data.info[0].playList;
        if (!Array.isArray(list)) { return []; }
        return list.map(function (it, i) {
            return { key: it && it.key, name: it && it.name, index: i };
        });
    }

    // 解析 v3/video/play 响应 clarity[] → 画质档数组。空/异常返回 []
    // downloadable = isEnabled && path.result 存在;url = path.result
    function parsePlayInfo(json) {
        const list = json && json.data && json.data.info && json.data.info[0] && json.data.info[0].clarity;
        if (!Array.isArray(list)) { return []; }
        return list.map(function (c) {
            c = c || {};
            const url = c.path && c.path.result ? c.path.result : '';
            return {
                title: c.title,
                description: c.description,
                bitrate: c.bitrate,
                isVIP: c.isVIP,
                isEnabled: c.isEnabled,
                downloadable: !!(c.isEnabled && url),
                url: url,
            };
        });
    }

    // mux.js 只支持 H.264+AAC。真机实测(2026-09-01,ffprobe 实拉切片):
    //   576=h264 896x504 / 720=h264 1280x720 / 1080=h264 1920x1080 / 2160=hevc 3840x2160
    // 2160 是 H.265(HEVC),mux.js 转封装会丢掉视频轨、只剩音频(下出 28MB 纯音频坏文件),
    // 故默认选最高的【非 HEVC】档(=1080)。与 VIP 无关——会员账号同样如此。
    const IYF_HEVC_TITLES = ['2160', '4K'];

    // 从 parsePlayInfo 的档数组里选目标档:
    // preferred(如 "1080")命中且可下就选它(用户明确指定 2160 也给,由下载端在转封装时报错提示);
    // 否则在可转封装的档里选 bitrate 最高的;都不可下返回 null。
    function pickQuality(clarityList, preferred) {
        if (!Array.isArray(clarityList)) { return null; }
        const dl = clarityList.filter(function (c) { return c && c.downloadable; });
        if (!dl.length) { return null; }
        if (preferred) {
            const hit = dl.find(function (c) { return c.title === preferred; });
            if (hit) { return hit; }
        }
        const usable = dl.filter(function (c) { return IYF_HEVC_TITLES.indexOf(c.title) === -1; });
        const pool = usable.length ? usable : dl;
        return pool.reduce(function (best, c) {
            return (c.bitrate || 0) > (best.bitrate || 0) ? c : best;
        });
    }

    // iyf 页面"当前页面"资源列表噪音判定:iyf 播放页正片是 HLS/DASH,真正能下成一集的入口是
    // m3u8/mpd playlist;占位/广告 mp4(如 empty2.mp4)、裸 ts 分片、图片、json 等对用户是噪音。
    // 返回 true = 该条应在"当前页面"列表隐藏。只认 iyf 域名资源(靠 data.webUrl),非 iyf 页面一律
    // false,绝不影响猫抓在其它站点的原有列表。ponytail: 只留 playlist 是最贴合"只看真正剧集"的白名单;
    // 万一某剧正片是裸 mp4(iyf 实测均 HLS,暂无此例)再放宽。
    function isEpisodeNoise(data) {
        if (!data || !isIyfHost(data.webUrl)) { return false; }
        return data.parsing !== 'm3u8' && data.parsing !== 'mpd';
    }

    // 站点「访问过量」判定:响应体 data.code==5 且 data.msg="访问过量"
    // (实测原文 {"data":{"code":5,"info":[],"msg":"访问过量"},"ret":200})。
    // 真机对照实证(2026-09-01):这不是频率限制——同一时刻同一接口,带账号凭证调回「用户签名错误」、
    // 只带 vv/pub(游客签名)才回「访问过量」,故它是「拿游客签名要登录内容」的拒绝话术。
    // 命中即返回 true,上层提示重新登录,而非误导成 empty clarity / 签名规则已变。
    function detectRateLimit(json) {
        const d = json && json.data;
        if (!d) { return false; }
        return d.code === 5 || (typeof d.msg === 'string' && d.msg.indexOf('访问过量') !== -1);
    }

    return {
        IYF_HOSTS,
        isIyfHost,
        parseSeriesKey,
        cleanSeriesTitle,
        padEpisodeNo,
        expandEpisodeRange,
        sanitizeFilePart,
        parsePlayList,
        parsePlayInfo,
        pickQuality,
        isEpisodeNoise,
        detectRateLimit,
    };
});

// ---- 自检:node js/iyf-common.js 退出码 0 即通过 ----
if (typeof require !== 'undefined' && require.main === module) {
    const assert = require('assert');
    const IYF = module.exports;

    // isIyfHost:命中/子域/大小写/不命中/裸host/非法输入
    assert.strictEqual(IYF.isIyfHost('https://www.iyf.tv/play/ABC'), true);
    assert.strictEqual(IYF.isIyfHost('https://IYF.TV/play/ABC'), true);
    assert.strictEqual(IYF.isIyfHost('https://m10.aiyifan.tv/x'), true);
    assert.strictEqual(IYF.isIyfHost('iyf.tv'), true);
    assert.strictEqual(IYF.isIyfHost('www.flyv.tv'), true);
    assert.strictEqual(IYF.isIyfHost('https://notiyf.tv.example.com/'), false);
    assert.strictEqual(IYF.isIyfHost('https://youtube.com/'), false);
    assert.strictEqual(IYF.isIyfHost('badiyf.tv'), false); // 非子域,不误命中
    assert.strictEqual(IYF.isIyfHost(''), false);
    assert.strictEqual(IYF.isIyfHost(null), false);

    // parseSeriesKey
    assert.strictEqual(IYF.parseSeriesKey('https://www.iyf.tv/play/G3D93jBLAY4'), 'G3D93jBLAY4');
    assert.strictEqual(IYF.parseSeriesKey('https://www.iyf.tv/play/G3D93jBLAY4?x=1#t'), 'G3D93jBLAY4');
    assert.strictEqual(IYF.parseSeriesKey('https://www.iyf.tv/'), null);
    assert.strictEqual(IYF.parseSeriesKey(''), null);

    // cleanSeriesTitle:正常/无集号兜底/空
    assert.strictEqual(IYF.cleanSeriesTitle('这一秒过火-01-免费在线观看-爱壹帆'), '这一秒过火');
    assert.strictEqual(IYF.cleanSeriesTitle('这一秒过火-免费在线观看-爱壹帆'), '这一秒过火');
    assert.strictEqual(IYF.cleanSeriesTitle('纯剧名'), '纯剧名');
    assert.strictEqual(IYF.cleanSeriesTitle(''), '');

    // padEpisodeNo
    assert.strictEqual(IYF.padEpisodeNo('1'), '01');
    assert.strictEqual(IYF.padEpisodeNo(1), '01');
    assert.strictEqual(IYF.padEpisodeNo(10), '10');
    assert.strictEqual(IYF.padEpisodeNo(100), '100');

    // expandEpisodeRange:全选/区间/越界钳制/倒序/勾选去重排序/空
    assert.deepStrictEqual(IYF.expandEpisodeRange({ mode: 'all' }, 3), [0, 1, 2]);
    assert.deepStrictEqual(IYF.expandEpisodeRange(undefined, 3), [0, 1, 2]);
    assert.deepStrictEqual(IYF.expandEpisodeRange({ mode: 'range', from: 1, to: 2 }, 5), [1, 2]);
    assert.deepStrictEqual(IYF.expandEpisodeRange({ mode: 'range', from: 3, to: 99 }, 5), [3, 4]); // 上界钳制
    assert.deepStrictEqual(IYF.expandEpisodeRange({ mode: 'range', from: -5, to: 1 }, 5), [0, 1]); // 下界钳制
    assert.deepStrictEqual(IYF.expandEpisodeRange({ mode: 'range', from: 2, to: 0 }, 5), [0, 1, 2]); // 倒序归正
    assert.deepStrictEqual(IYF.expandEpisodeRange({ mode: 'pick', indexes: [2, 0, 2, 9] }, 5), [0, 2]); // 去重+去越界+排序
    assert.deepStrictEqual(IYF.expandEpisodeRange({ mode: 'all' }, 0), []);

    // sanitizeFilePart
    assert.strictEqual(IYF.sanitizeFilePart('a/b:c*?"<>|~\\d'), 'abcd');
    assert.strictEqual(IYF.sanitizeFilePart('这一秒过火'), '这一秒过火');
    assert.strictEqual(IYF.sanitizeFilePart(null), '');

    // ---- 解析层 fixture(照 design §11 真实响应结构造)----
    // languagesplaylist:data.info[0].playList[] = [{id,key,name}]
    const playlistJson = {
        data: { info: [{ playList: [
            { id: 111, key: 'EP01KEY', name: '01' },
            { id: 112, key: 'EP02KEY', name: '02' },
            { id: 113, key: 'EP03KEY', name: '03' },
        ] }] }
    };
    assert.deepStrictEqual(IYF.parsePlayList(playlistJson), [
        { key: 'EP01KEY', name: '01', index: 0 },
        { key: 'EP02KEY', name: '02', index: 1 },
        { key: 'EP03KEY', name: '03', index: 2 },
    ]);
    assert.deepStrictEqual(IYF.parsePlayList({}), []);
    assert.deepStrictEqual(IYF.parsePlayList(null), []);
    assert.deepStrictEqual(IYF.parsePlayList({ data: { info: [] } }), []);

    // video/play:未登录样本——仅 576 可下,720/1080/4K 均 isVIP & isEnabled:false & path:null
    const playJson = {
        data: { info: [{ clarity: [
            { bitrate: 800, title: '576', description: '标清', isVIP: false, isEnabled: true, path: { isHls: true, result: 'https://x.iyf.tv/576.m3u8' } },
            { bitrate: 2000, title: '720', description: '高清', isVIP: true, isEnabled: false, path: null },
            { bitrate: 4000, title: '1080', description: '蓝光', isVIP: true, isEnabled: false, path: null },
            { bitrate: 8000, title: '4K', description: '超清', isVIP: true, isEnabled: false, path: null },
        ] }] }
    };
    const clarity = IYF.parsePlayInfo(playJson);
    assert.strictEqual(clarity.length, 4);
    assert.deepStrictEqual(clarity[0], { title: '576', description: '标清', bitrate: 800, isVIP: false, isEnabled: true, downloadable: true, url: 'https://x.iyf.tv/576.m3u8' });
    assert.strictEqual(clarity[2].downloadable, false);
    assert.strictEqual(clarity[2].url, '');
    assert.deepStrictEqual(IYF.parsePlayInfo({}), []);
    assert.deepStrictEqual(IYF.parsePlayInfo(null), []);

    // pickQuality:未登录只有 576 可下 → preferred 1080 落空退回最高可下(=576)
    assert.strictEqual(IYF.pickQuality(clarity, '1080').title, '576');
    assert.strictEqual(IYF.pickQuality(clarity, '576').title, '576');
    assert.strictEqual(IYF.pickQuality(clarity).title, '576');
    // 多档可下:preferred 命中选它;落空选 bitrate 最高
    const multi = IYF.parsePlayInfo({ data: { info: [{ clarity: [
        { bitrate: 800, title: '576', isEnabled: true, path: { result: 'a' } },
        { bitrate: 4000, title: '1080', isEnabled: true, path: { result: 'b' } },
    ] }] } });
    assert.strictEqual(IYF.pickQuality(multi, '1080').title, '1080');
    assert.strictEqual(IYF.pickQuality(multi, 'nope').title, '1080'); // 落空→最高
    // HEVC(2160)不当默认:mux.js 不支持 H.265,转封装会丢视频轨 → 默认选最高的 H.264 档(1080)
    const tiers = IYF.parsePlayInfo({ data: { info: [{ clarity: [
        { bitrate: 9000, title: '2160', isVIP: true, isEnabled: true, path: { result: 'hevc4k' } },
        { bitrate: 4000, title: '1080', isVIP: true, isEnabled: true, path: { result: 'h264_1080' } },
        { bitrate: 800, title: '576', isVIP: false, isEnabled: true, path: { result: 'h264_576' } },
    ] }] } });
    assert.strictEqual(IYF.pickQuality(tiers).title, '1080');          // 默认跳过 HEVC,取最高 H.264
    assert.strictEqual(IYF.pickQuality(tiers, '2160').title, '2160');  // 用户明确指定 HEVC 仍给
    assert.strictEqual(IYF.pickQuality(tiers, '576').title, '576');
    // 只有 HEVC 档时退回它(转封装阶段会明确报错,而不是这里静默什么都不给)
    const onlyHevc = IYF.parsePlayInfo({ data: { info: [{ clarity: [
        { bitrate: 9000, title: '2160', isEnabled: true, path: { result: 'h' } },
    ] }] } });
    assert.strictEqual(IYF.pickQuality(onlyHevc).title, '2160');

    // 全不可下 → null
    const noneDl = IYF.parsePlayInfo({ data: { info: [{ clarity: [
        { title: '1080', isEnabled: false, path: null },
    ] }] } });
    assert.strictEqual(IYF.pickQuality(noneDl, '1080'), null);
    assert.strictEqual(IYF.pickQuality([], '1080'), null);
    assert.strictEqual(IYF.pickQuality(null, '1080'), null);

    // isEpisodeNoise:iyf 页面只留 m3u8/mpd,滤掉其余;非 iyf 页面/无 webUrl 一律不滤
    const iyfPage = 'https://www.iyf.tv/play/ABC';
    assert.strictEqual(IYF.isEpisodeNoise({ webUrl: iyfPage, parsing: 'm3u8' }), false); // 正片 playlist 保留
    assert.strictEqual(IYF.isEpisodeNoise({ webUrl: iyfPage, parsing: 'mpd' }), false);
    assert.strictEqual(IYF.isEpisodeNoise({ webUrl: iyfPage, parsing: false }), true);   // empty2.mp4/裸 ts 隐藏
    assert.strictEqual(IYF.isEpisodeNoise({ webUrl: iyfPage, parsing: 'json' }), true);
    assert.strictEqual(IYF.isEpisodeNoise({ webUrl: 'https://youtube.com/x', parsing: false }), false); // 非 iyf 不滤
    assert.strictEqual(IYF.isEpisodeNoise({ parsing: false }), false); // 无 webUrl 不滤
    assert.strictEqual(IYF.isEpisodeNoise(null), false);

    // detectRateLimit:data.code==5 或 msg 含"访问过量"→ true;正常响应/空 → false
    assert.strictEqual(IYF.detectRateLimit({ data: { code: 5, info: [], msg: '访问过量' } }), true);
    assert.strictEqual(IYF.detectRateLimit({ data: { code: 0, msg: '访问过量' } }), true); // 只看 msg 也算
    assert.strictEqual(IYF.detectRateLimit({ data: { code: 5 } }), true);
    assert.strictEqual(IYF.detectRateLimit({ data: { code: 0, info: [{ clarity: [] }] } }), false);
    assert.strictEqual(IYF.detectRateLimit({ data: {} }), false);
    assert.strictEqual(IYF.detectRateLimit({}), false);
    assert.strictEqual(IYF.detectRateLimit(null), false);

    console.log('iyf-common self-check: all assertions passed');
}
