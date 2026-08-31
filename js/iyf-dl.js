// iyf.tv 多集下载 —— 精简下载器页面脚本(跑在编排器新开的普通 tab,非 m3u8.js/service worker)
// 数据流:orchestrator 签好 chunklist URL → 本页 fetch chunklist → 抽 ts URL 数组
//   → 并发下载(ts 已自带 CDN 完整签名,直接 fetch,不拼参数)→ mux.js TS→MP4 remux
//   → chrome.downloads.download 落盘 → 主动 sendMessage(iyfEpisodeDone/Failed) → window.close。
// 依赖:lib/mux.min.js(提供全局 muxjs)先于本文件加载。
// ponytail: 只服务 iyf 一种流(标准 media m3u8 + H264/AAC TS,无加密/无 init-segment/无 byteRange),
//   故不搬 m3u8.downloader.js 整个 Downloader 类(pipeline/events/range 都用不上),就地写最小并发器。

const IYF_DL = {
    THREAD: 6,        // 每集内 ts 并发线程数
    MAX_RETRIES: 3,   // 单切片最大重试次数
};

// ---- chunklist 解析:标准 HLS media playlist,抽 ts URL 数组 + 累计时长 ----
// 只认安全 tag;见 EXT-X-KEY(加密)/EXT-X-MAP(init 段)/EXT-X-BYTERANGE/master 或任何未知 EXT tag → 抛错,
// 绝不静默产坏文件(承重决策:iyf chunklist 为无加密 6 标准 tag 结构)。
const IYF_SAFE_TAGS = new Set([
    'EXTM3U', 'EXT-X-VERSION', 'EXT-X-TARGETDURATION',
    'EXT-X-MEDIA-SEQUENCE', 'EXT-X-PLAYLIST-TYPE', 'EXT-X-ENDLIST',
]);

function iyfParseChunklist(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const urls = [];
    const durations = [];
    let pendingDuration = 0;
    for (let raw of lines) {
        const line = raw.trim();
        if (!line) { continue; }
        if (line[0] === '#') {
            if (line.startsWith('#EXTINF:')) {
                pendingDuration = parseFloat(line.slice(8)) || 0;
                continue;
            }
            const tag = line.slice(1).split(':')[0];
            if (tag === 'EXT-X-KEY') { throw new Error('chunklist 含 EXT-X-KEY(加密流),本下载器不支持'); }
            if (tag === 'EXT-X-MAP') { throw new Error('chunklist 含 EXT-X-MAP(init 段),本下载器不支持'); }
            if (tag === 'EXT-X-BYTERANGE') { throw new Error('chunklist 含 EXT-X-BYTERANGE,本下载器不支持'); }
            if (tag === 'EXT-X-STREAM-INF') { throw new Error('这是 master playlist,不是 media chunklist'); }
            if (!IYF_SAFE_TAGS.has(tag)) { throw new Error('chunklist 含未预期 tag #' + tag + ',拒绝下载以免产坏文件'); }
            continue;
        }
        // 非 # 行 = ts URL(相对则按 chunklist URL 解析为绝对)
        urls.push(new URL(line, baseUrl).href);
        durations.push(pendingDuration);
        pendingDuration = 0;
    }
    if (!urls.length) { throw new Error('chunklist 未解析出任何 ts 切片'); }
    return { urls, durations };
}

// ---- 最小并发下载器:多线程 fetch + 重试,按 index 顺序收 ArrayBuffer ----
// 返回 Promise<ArrayBuffer[]>(下标即切片序号);任一切片重试耗尽 → reject。
function iyfDownloadAll(urls, onProgress) {
    return new Promise((resolve, reject) => {
        const buffers = new Array(urls.length);
        let next = 0;       // 下一个待取切片
        let done = 0;       // 已完成数
        let failed = false;

        function fetchOne(i, attempt) {
            fetch(urls[i])
                .then(resp => {
                    if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                    return resp.arrayBuffer();
                })
                .then(buf => {
                    if (failed) { return; }
                    buffers[i] = buf;
                    done++;
                    onProgress && onProgress(done, urls.length);
                    if (done === urls.length) { resolve(buffers); return; }
                    pump();
                })
                .catch(err => {
                    if (failed) { return; }
                    if (attempt < IYF_DL.MAX_RETRIES) {
                        setTimeout(() => fetchOne(i, attempt + 1), 500 * (attempt + 1));
                        return;
                    }
                    failed = true;
                    reject(new Error('切片 ' + i + ' 下载失败:' + err.message));
                });
        }
        // 有空闲线程且有未派发切片就继续派发
        function pump() {
            while (!failed && next < urls.length && (next - done) < IYF_DL.THREAD) {
                fetchOne(next++, 0);
            }
        }
        pump();
    });
}

// ---- mux.js remux:按序 push+flush 每段,head 段拼 initSegment+data 并写入总时长 ----
// 序列同 m3u8.js:1595-1617。fixFileDuration 从 m3u8.js:2219 原样搬入(修 moov 总时长,保证播放器可 seek)。
function iyfRemux(buffers, totalDuration) {
    const out = [];
    let head = true;
    let tempBuffer = null;
    const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false, remux: true });
    transmuxer.on('data', function (segment) {
        if (head) {
            const data = new Uint8Array(segment.initSegment.byteLength + segment.data.byteLength);
            data.set(segment.initSegment, 0);
            data.set(segment.data, segment.initSegment.byteLength);
            tempBuffer = fixFileDuration(data, totalDuration);
            return;
        }
        tempBuffer = new Uint8Array(segment.data);
    });
    for (let i = 0; i < buffers.length; i++) {
        head = (i === 0);
        tempBuffer = null;
        transmuxer.push(new Uint8Array(buffers[i]));
        transmuxer.flush();
        if (tempBuffer) { out.push(tempBuffer); }
    }
    if (!out.length) { throw new Error('mux.js 未产出任何 mp4 数据'); }
    return out;
}

// fixFileDuration:改写 mp4 头 mvhd/tkhd/mdhd 的 duration 为整片总时长(搬自 m3u8.js:2219,逻辑未改)
function fixFileDuration(data, duration) {
    let mvhdBoxDuration = duration * 90000;
    function getBoxDuration(data, duration, index) {
        let boxDuration = "";
        index += 16;    // 偏移量 16 为 timescale
        boxDuration += data[index].toString(16);
        boxDuration += data[++index].toString(16);
        boxDuration += data[++index].toString(16);
        boxDuration += data[++index].toString(16);
        boxDuration = parseInt(boxDuration, 16);
        boxDuration *= duration;
        return boxDuration;
    }
    for (let i = 0; i < data.length; i++) {
        if (data[i] == 0x6D && data[i + 1] == 0x76 && data[i + 2] == 0x68 && data[i + 3] == 0x64) { // mvhd
            mvhdBoxDuration = getBoxDuration(data, duration, i);
            data[i + 11] = 0;   // 删除创建日期
            i += 20;            // mvhd 偏移 20 为 duration
            data[i] = (mvhdBoxDuration & 0xFF000000) >> 24;
            data[++i] = (mvhdBoxDuration & 0xFF0000) >> 16;
            data[++i] = (mvhdBoxDuration & 0xFF00) >> 8;
            data[++i] = mvhdBoxDuration & 0xFF;
            continue;
        }
        if (data[i] == 0x74 && data[i + 1] == 0x6B && data[i + 2] == 0x68 && data[i + 3] == 0x64) { // tkhd
            i += 24;            // tkhd 偏移 24 为 duration
            data[i] = (mvhdBoxDuration & 0xFF000000) >> 24;
            data[++i] = (mvhdBoxDuration & 0xFF0000) >> 16;
            data[++i] = (mvhdBoxDuration & 0xFF00) >> 8;
            data[++i] = mvhdBoxDuration & 0xFF;
            continue;
        }
        if (data[i] == 0x6D && data[i + 1] == 0x64 && data[i + 2] == 0x68 && data[i + 3] == 0x64) { // mdhd
            let mdhdBoxDuration = getBoxDuration(data, duration, i);
            i += 20;            // mdhd 偏移 20 为 duration
            data[i] = (mdhdBoxDuration & 0xFF000000) >> 24;
            data[++i] = (mdhdBoxDuration & 0xFF0000) >> 16;
            data[++i] = (mdhdBoxDuration & 0xFF00) >> 8;
            data[++i] = mdhdBoxDuration & 0xFF;
            continue;
        }
    }
    return data;
}

// ---- 完成信号:主动消息给编排器,再自关 ----
function iyfReport(message, index, extra) {
    try {
        chrome.runtime.sendMessage(Object.assign({ Message: message, index: index }, extra || {}));
    } catch (e) { /* SW 可能已休眠,重发无意义 */ }
}

// ---- 主流程 ----
async function iyfDlMain() {
    const p = new URL(location.href).searchParams;
    const chunklistUrl = p.get('url');
    const filename = p.get('filename');
    const index = parseInt(p.get('index'), 10);
    const status = document.getElementById('status');
    const setStatus = t => { if (status) { status.textContent = t; } };

    try {
        if (!chunklistUrl || !filename) { throw new Error('缺少 url/filename 参数'); }
        setStatus('拉取 chunklist…');
        const resp = await fetch(chunklistUrl);
        if (!resp.ok) { throw new Error('chunklist HTTP ' + resp.status); }
        const text = await resp.text();
        const { urls, durations } = iyfParseChunklist(text, chunklistUrl);
        const totalDuration = durations.reduce((a, b) => a + b, 0);

        setStatus('下载切片 0/' + urls.length);
        const buffers = await iyfDownloadAll(urls, (done, total) => setStatus('下载切片 ' + done + '/' + total));

        setStatus('转封装 MP4…');
        const mp4Buffers = iyfRemux(buffers, totalDuration);

        setStatus('落盘…');
        const blob = new Blob(mp4Buffers, { type: 'video/mp4' });
        const objUrl = URL.createObjectURL(blob);
        await new Promise((resolve, reject) => {
            chrome.downloads.download({ url: objUrl, filename: filename, saveAs: false }, id => {
                if (chrome.runtime.lastError || !id) {
                    reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : '下载未启动'));
                } else { resolve(id); }
            });
        });

        setStatus('完成');
        iyfReport('iyfEpisodeDone', index);
    } catch (e) {
        setStatus('失败:' + (e && e.message ? e.message : String(e)));
        iyfReport('iyfEpisodeFailed', index, { err: e && e.message ? e.message : String(e) });
    } finally {
        // 给消息一点发送时间再自关(下完/失败都关,编排器已收到信号)
        setTimeout(() => window.close(), 800);
    }
}

// ---- node 自检:node js/iyf-dl.js 退出码 0 即通过(只测纯函数 iyfParseChunklist,不依赖 chrome/mux)----
if (typeof window === 'undefined' && typeof require !== 'undefined' && require.main === module) {
    const assert = require('assert');
    const base = 'https://cdn.example.com/hls/720/chunklist.m3u8';
    const good = [
        '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:11',
        '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXTINF:10.0,', 'seg0.ts?vendtime=1&vhash=a&vv=b&pub=c',
        '#EXTINF:9.5,', 'https://cdn.example.com/hls/720/seg1.ts?vv=b',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const r = iyfParseChunklist(good, base);
    assert.strictEqual(r.urls.length, 2, 'ts 数量');
    assert.strictEqual(r.urls[0], 'https://cdn.example.com/hls/720/seg0.ts?vendtime=1&vhash=a&vv=b&pub=c', '相对 URL 解析');
    assert.strictEqual(r.durations[0], 10.0, 'EXTINF 时长');
    assert.strictEqual(r.durations.reduce((a, b) => a + b, 0), 19.5, '总时长');
    // 加密/init/master/未知 tag 必须抛错
    for (const [snippet, why] of [
        ['#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\nseg.ts', 'EXT-X-KEY'],
        ['#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nseg.ts', 'EXT-X-MAP'],
        ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhi.m3u8', 'master'],
        ['#EXTM3U\n#EXT-X-DISCONTINUITY\nseg.ts', '未知 tag'],
    ]) {
        assert.throws(() => iyfParseChunklist(snippet, base), '应拒绝:' + why);
    }
    // 空列表抛错
    assert.throws(() => iyfParseChunklist('#EXTM3U\n#EXT-X-ENDLIST', base), '空列表应抛错');
    console.log('iyf-dl self-check: all assertions passed');
}

// 页面环境才跑主流程
if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', iyfDlMain);
}
