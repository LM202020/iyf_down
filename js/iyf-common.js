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

    return {
        IYF_HOSTS,
        isIyfHost,
        parseSeriesKey,
        cleanSeriesTitle,
        padEpisodeNo,
        expandEpisodeRange,
        sanitizeFilePart,
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

    console.log('iyf-common self-check: all assertions passed');
}
