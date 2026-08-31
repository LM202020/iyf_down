// iyf.tv 多集下载 —— DownloadJob 状态机纯函数(不依赖 chrome API,浏览器/node 通用)
// UMD 挂载:浏览器挂到 self.IYF_JOB,node 走 module.exports。
// 状态迁移:pending(待下载) → fetching(取流中) → downloading(下载中) → done(已完成)
//           失败时未耗尽重试回 pending 并计数,耗尽标 failed(已失败)。
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.IYF_JOB = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    const STATUS = {
        PENDING: 'pending',
        FETCHING: 'fetching',
        DOWNLOADING: 'downloading',
        DONE: 'done',
        FAILED: 'failed',
    };

    // 创建 job。opts: {seriesKey, seriesTitle, episodes:[{key,name}], quality, concurrency, maxRetries}
    function createJob(opts) {
        opts = opts || {};
        const episodes = (Array.isArray(opts.episodes) ? opts.episodes : []).map(function (ep) {
            return { key: ep && ep.key, name: ep && ep.name, status: STATUS.PENDING, retries: 0, err: '' };
        });
        return {
            seriesKey: opts.seriesKey || '',
            seriesTitle: opts.seriesTitle || '',
            quality: opts.quality || '',
            concurrency: opts.concurrency > 0 ? opts.concurrency : 3,
            maxRetries: opts.maxRetries >= 0 ? opts.maxRetries : 2,
            cancelled: false,
            episodes: episodes,
        };
    }

    // 在途(取流中+下载中)数量
    function activeCount(job) {
        return job.episodes.filter(function (e) {
            return e.status === STATUS.FETCHING || e.status === STATUS.DOWNLOADING;
        }).length;
    }

    // 背压判定:返回本轮可启动的集索引数组(在途数补足到并发上限为止;已取消返回空)
    function startable(job) {
        if (!job || job.cancelled) { return []; }
        const room = job.concurrency - activeCount(job);
        if (room <= 0) { return []; }
        const out = [];
        for (let i = 0; i < job.episodes.length && out.length < room; i++) {
            if (job.episodes[i].status === STATUS.PENDING) { out.push(i); }
        }
        return out;
    }

    function markFetching(job, i) { job.episodes[i].status = STATUS.FETCHING; }
    function markDownloading(job, i) { job.episodes[i].status = STATUS.DOWNLOADING; }
    function markDone(job, i) { job.episodes[i].status = STATUS.DONE; job.episodes[i].err = ''; }

    // 集失败:未耗尽重试 → 计数+回待下载,返回 true(将重试);耗尽 → 标失败,返回 false
    function markFailed(job, i, err) {
        const ep = job.episodes[i];
        ep.err = String(err || 'failed');
        if (ep.retries < job.maxRetries) {
            ep.retries++;
            ep.status = STATUS.PENDING;
            return true;
        }
        ep.status = STATUS.FAILED;
        return false;
    }

    // 取消:不再推进新集(在途集不动,等它们自然收尾)
    function cancel(job) { job.cancelled = true; }

    // 失败集清单 [{key,name,err}]
    function failedList(job) {
        return job.episodes.filter(function (e) { return e.status === STATUS.FAILED; })
            .map(function (e) { return { key: e.key, name: e.name, err: e.err }; });
    }

    // 整体结束:全部 done/failed;或已取消且无在途
    function isFinished(job) {
        if (!job) { return true; }
        if (job.cancelled) { return activeCount(job) === 0; }
        return job.episodes.every(function (e) {
            return e.status === STATUS.DONE || e.status === STATUS.FAILED;
        });
    }

    // 可序列化快照(供 popup 渲染 / storage.session 存储)
    function snapshot(job) {
        if (!job) { return null; }
        const count = function (s) { return job.episodes.filter(function (e) { return e.status === s; }).length; };
        return {
            seriesKey: job.seriesKey,
            seriesTitle: job.seriesTitle,
            quality: job.quality,
            cancelled: job.cancelled,
            finished: isFinished(job),
            progress: {
                total: job.episodes.length,
                done: count(STATUS.DONE),
                failed: count(STATUS.FAILED),
                active: activeCount(job),
                pending: count(STATUS.PENDING),
            },
            episodes: job.episodes.map(function (e) {
                return { key: e.key, name: e.name, status: e.status, retries: e.retries, err: e.err };
            }),
        };
    }

    return {
        STATUS,
        createJob,
        activeCount,
        startable,
        markFetching,
        markDownloading,
        markDone,
        markFailed,
        cancel,
        failedList,
        isFinished,
        snapshot,
    };
});

// ---- 自检:node js/iyf-job.js 退出码 0 即通过 ----
if (typeof require !== 'undefined' && require.main === module) {
    const assert = require('assert');
    const J = module.exports;

    const eps = [{ key: 'K1', name: '01' }, { key: 'K2', name: '02' }, { key: 'K3', name: '03' }, { key: 'K4', name: '04' }, { key: 'K5', name: '05' }];

    // 创建:默认并发 3、重试 2、全部待下载
    let job = J.createJob({ seriesKey: 'S', seriesTitle: '剧', quality: '1080', episodes: eps });
    assert.strictEqual(job.concurrency, 3);
    assert.strictEqual(job.maxRetries, 2);
    assert.strictEqual(job.episodes.length, 5);
    assert.ok(job.episodes.every(e => e.status === J.STATUS.PENDING));
    assert.strictEqual(J.isFinished(job), false);

    // 背压:不超并发上限
    assert.deepStrictEqual(J.startable(job), [0, 1, 2]);
    J.markFetching(job, 0); J.markFetching(job, 1); J.markFetching(job, 2);
    assert.strictEqual(J.activeCount(job), 3);
    assert.deepStrictEqual(J.startable(job), []); // 满载不再放行
    J.markDownloading(job, 0); // fetching→downloading 仍算在途
    assert.deepStrictEqual(J.startable(job), []);
    J.markDone(job, 0); // 一集完成腾出一个坑
    assert.deepStrictEqual(J.startable(job), [3]);

    // 重试:2 次内回 pending 计数,耗尽转 failed
    assert.strictEqual(J.markFailed(job, 1, 'net err'), true);
    assert.strictEqual(job.episodes[1].status, J.STATUS.PENDING);
    assert.strictEqual(job.episodes[1].retries, 1);
    assert.strictEqual(J.markFailed(job, 1, 'net err'), true);
    assert.strictEqual(job.episodes[1].retries, 2);
    assert.strictEqual(J.markFailed(job, 1, 'net err final'), false); // 耗尽
    assert.strictEqual(job.episodes[1].status, J.STATUS.FAILED);
    // maxRetries:0 → 首败即 failed
    const job0 = J.createJob({ episodes: eps.slice(0, 1), maxRetries: 0 });
    assert.strictEqual(J.markFailed(job0, 0, 'x'), false);
    assert.strictEqual(job0.episodes[0].status, J.STATUS.FAILED);

    // 失败清单
    assert.deepStrictEqual(J.failedList(job), [{ key: 'K2', name: '02', err: 'net err final' }]);

    // 取消:不再推进新集;在途集收尾后判结束
    assert.ok(J.startable(job).length > 0);
    J.cancel(job);
    assert.deepStrictEqual(J.startable(job), []);
    assert.strictEqual(J.isFinished(job), false); // 第 2(idx 2)集仍在途
    J.markDone(job, 2);
    assert.strictEqual(J.isFinished(job), true); // 取消且无在途 → 结束(idx 3/4 保持 pending)
    assert.strictEqual(job.episodes[3].status, J.STATUS.PENDING);

    // 未取消时的自然结束 + 快照
    const job2 = J.createJob({ episodes: eps.slice(0, 2), concurrency: 1 });
    assert.deepStrictEqual(J.startable(job2), [0]); // 并发 1 只放一个
    J.markFetching(job2, 0); J.markDownloading(job2, 0); J.markDone(job2, 0);
    J.markFetching(job2, 1);
    const snap = J.snapshot(job2);
    assert.deepStrictEqual(snap.progress, { total: 2, done: 1, failed: 0, active: 1, pending: 0 });
    assert.strictEqual(snap.finished, false);
    assert.strictEqual(snap.episodes[0].status, J.STATUS.DONE);
    J.markDone(job2, 1);
    assert.strictEqual(J.isFinished(job2), true);
    assert.strictEqual(J.snapshot(job2).finished, true);

    // 空 job
    assert.strictEqual(J.isFinished(null), true);
    assert.strictEqual(J.snapshot(null), null);
    assert.deepStrictEqual(J.startable(null), []);

    console.log('iyf-job self-check: all assertions passed');
}
