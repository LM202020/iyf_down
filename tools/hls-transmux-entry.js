// 从 hls.js 源码抽出 TS→fMP4 转封装能力,打成扩展可用的 IIFE。
// 与 mux.js 的区别:hls.js 的 TSDemuxer 支持 HEVC(H.265) in M2TS,mux.js 只支持 H.264。
// hls.js 原生为 MSE 服务,音视频轨分开产出;这里用 MP4.initSegment([video,audio]) 合成
// 单个含双 trak 的 moov,再把两轨的 moof+mdat 依序拼接 —— 得到单文件 fMP4。
import TSDemuxer from './node_modules/hls.js/src/demux/tsdemuxer';
import MP4Remuxer from './node_modules/hls.js/src/remux/mp4-remuxer';
import MP4 from './node_modules/hls.js/src/remux/mp4-generator';
import { logger } from './node_modules/hls.js/src/utils/logger';

// demuxer/remuxer 只用 observer 发 ERROR 事件,给个最小 emitter 即可
const observer = { on() {}, off() {}, once() {}, emit() {}, removeAllListeners() {} };
const typeSupported = { mpeg: false, mp3: false, ac3: false };
// 内联 demuxer/remuxer 实际读到的那几项(值同 config),避免拖进整个 src/config 依赖树
const config = {
    progressive: false,
    forceKeyFrameOnDiscontinuity: true,
    maxAudioFramesDrift: 1,
    maxBufferHole: 0.1,
    stretchShortVideoTrack: false,
};
const PlaylistLevelType = { MAIN: 'main' };

// hls.js 为 MSE 设计:moof 的 tfdt 写的是 TS 的绝对 PTS,靠 SourceBuffer.timestampOffset 对齐。
// 离线文件没有这一层,时间轴会从原始 PTS 起点开始(实测某流起点在 2^33 边界 ≈95443 秒),
// 播放器会当成一个 26 小时长的视频。这里把每个 moof 的 tfdt 减去基准 —— 音视频用同一时间基准
// (各按自己 timescale 换算),保留原有的音画相对偏移。
function shiftTfdt(box, baseTicks) {
    const dv = new DataView(box.buffer, box.byteOffset, box.byteLength);
    // moof > traf > tfdt,逐层扫子 box(size:4 + type:4 + payload)
    function walk(start, end) {
        let p = start;
        while (p + 8 <= end) {
            const size = dv.getUint32(p);
            if (size < 8 || p + size > end) { return; }
            const type = String.fromCharCode(
                box[p + 4], box[p + 5], box[p + 6], box[p + 7]);
            if (type === 'traf' || type === 'moof') {
                walk(p + 8, p + size);
            } else if (type === 'tfdt') {
                const ver = box[p + 8];
                const off = p + 12;
                if (ver === 1) {
                    const hi = dv.getUint32(off), lo = dv.getUint32(off + 4);
                    const v = Math.max(0, hi * 4294967296 + lo - baseTicks);
                    dv.setUint32(off, Math.floor(v / 4294967296));
                    dv.setUint32(off + 4, v >>> 0);
                } else {
                    dv.setUint32(off, Math.max(0, dv.getUint32(off) - baseTicks) >>> 0);
                }
            }
            p += size;
        }
    }
    walk(0, box.byteLength);
}

// 读第一个 tfdt 的值,用来定基准
function readTfdt(box) {
    const dv = new DataView(box.buffer, box.byteOffset, box.byteLength);
    let found = null;
    (function walk(start, end) {
        let p = start;
        while (p + 8 <= end && found === null) {
            const size = dv.getUint32(p);
            if (size < 8 || p + size > end) { return; }
            const type = String.fromCharCode(
                box[p + 4], box[p + 5], box[p + 6], box[p + 7]);
            if (type === 'traf' || type === 'moof') {
                walk(p + 8, p + size);
            } else if (type === 'tfdt') {
                found = box[p + 8] === 1
                    ? dv.getUint32(p + 12) * 4294967296 + dv.getUint32(p + 16)
                    : dv.getUint32(p + 12);
            }
            p += size;
        }
    })(0, box.byteLength);
    return found;
}

// duration:整集总秒数(由 m3u8 的 EXTINF 累加得来)。不传则 moov 里时长为 0,
// 离线播放器会显示时长未知、拖不动进度条。
function createRemuxer(duration) {
    const demuxer = new TSDemuxer(observer, config, typeSupported, logger);
    const remuxer = new MP4Remuxer(observer, config, typeSupported, logger);
    demuxer.resetInitSegment(undefined, undefined, undefined, duration || 0);
    remuxer.resetInitSegment(undefined, undefined, undefined, null);
    demuxer.resetTimeStamp(null);
    remuxer.resetTimeStamp(null);
    let initEmitted = false;
    let sawVideo = false;
    let baseSec = null;   // 统一时间基准(秒),由首个出现的轨定下

    // 一片 TS → 若干 mp4 片段。timeOffset 恒 0:remuxer 内部靠 nextAvcDts 连续推进
    function run(data, flush) {
        const out = [];
        const res = flush ? demuxer.flush(0) : demuxer.demux(data, 0, false, false);
        const list = Array.isArray(res) ? res : [res];
        list.forEach(function (r) {
            if (!r) { return; }
            const rr = remuxer.remux(
                r.audioTrack, r.videoTrack, r.id3Track, r.textTrack,
                0, false, !!flush, PlaylistLevelType.MAIN,
            );
            // 首个 init:此时 remux 已给 track 补好 timescale/codec/sps-pps,可安全合轨
            if (!initEmitted && rr.initSegment) {
                const tracks = [];
                if (rr.initSegment.tracks && rr.initSegment.tracks.video) { tracks.push(r.videoTrack); }
                if (rr.initSegment.tracks && rr.initSegment.tracks.audio) { tracks.push(r.audioTrack); }
                if (tracks.length) {
                    out.push(MP4.initSegment(tracks));
                    initEmitted = true;
                }
            }
            if (rr.video) {
                const ts = r.videoTrack.inputTimeScale || 90000;
                if (baseSec === null) {
                    const t = readTfdt(rr.video.data1);
                    if (t !== null) { baseSec = t / ts; }
                }
                shiftTfdt(rr.video.data1, Math.round(baseSec * ts));
                sawVideo = true;
                out.push(rr.video.data1, rr.video.data2);
            }
            if (rr.audio) {
                const ts = r.audioTrack.timescale || r.audioTrack.samplerate || 90000;
                if (baseSec === null) {
                    const t = readTfdt(rr.audio.data1);
                    if (t !== null) { baseSec = t / ts; }
                }
                shiftTfdt(rr.audio.data1, Math.round(baseSec * ts));
                out.push(rr.audio.data1, rr.audio.data2);
            }
        });
        return out;
    }

    return {
        push: function (uint8) { return run(uint8, false); },
        flush: function () { return run(null, true); },
        hasVideo: function () { return sawVideo; },
        destroy: function () { demuxer.destroy(); remuxer.destroy(); },
    };
}

export { createRemuxer };
