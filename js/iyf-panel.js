// iyf.tv 多集下载 —— popup 面板逻辑(选择视图 + 进度视图)
// 依赖:jQuery、js/iyf-common.js(IYF)、popup.js 的全局 Tips()。
// 入口 iyfPanelInit(tab) 由 popup.js 在 G 就绪后调用(iyf 播放页才显示面板)。
(function () {
    let iyfTab = null;          // 发起页 tab(取 id/url/title)
    let iyfSeriesKey = null;
    let iyfEpisodes = [];       // iyfPlayList 结果 [{key,name,index}]
    let iyfPollTimer = null;
    let iyfLastState = null;    // 最近一次 job 快照(重下失败集用)

    const STATUS_TEXT = { pending: '待下载', fetching: '取流中', downloading: '下载中', done: '✓', failed: '✗' };

    function iyfSend(msg) {
        return new Promise(function (resolve) {
            chrome.runtime.sendMessage(chrome.runtime.id, msg, function (res) {
                resolve(chrome.runtime.lastError ? null : res);
            });
        });
    }

    // 入口:命中 iyf 播放页才显示;有未完 job(或刚结束但有失败集,供补下)进进度视图,否则拉全集列表进选择视图
    window.iyfPanelInit = async function (tab) {
        if (!tab || !IYF.isIyfHost(tab.url)) { return; }
        const seriesKey = IYF.parseSeriesKey(tab.url);
        if (!seriesKey) { return; }
        iyfTab = tab;
        iyfSeriesKey = seriesKey;
        $("#iyfPanel").removeClass("hide");
        const res = await iyfSend({ Message: "iyfJobState" });
        const state = res && res.ok ? res.state : null;
        if (state && (!state.finished || state.restored || (state.progress && state.progress.failed > 0))) {
            showProgressView(state);
        } else {
            showSelectView();
        }
    };

    // ---- 选择视图 ----
    async function showSelectView() {
        stopPoll();
        $("#iyfProgressView").addClass("hide");
        $("#iyfSelectView").removeClass("hide");
        if (iyfEpisodes.length) { return; } // 已加载过,直接复用 DOM
        const $list = $("#iyfEpList").text("加载分集中…");
        const res = await iyfSend({ Message: "iyfPlayList", tabId: iyfTab.id, seriesKey: iyfSeriesKey });
        if (!res || !res.ok || !res.episodes || !res.episodes.length) {
            $list.text("取分集列表失败" + (res && res.err ? ":" + res.err : ""));
            return;
        }
        iyfEpisodes = res.episodes;
        renderEpList();
        loadQuality();
    }

    function renderEpList() {
        const $list = $("#iyfEpList").empty();
        iyfEpisodes.forEach(function (ep) {
            $('<label class="iyfEp"></label>')
                .append($('<input type="checkbox" checked/>').attr("data-index", ep.index))
                .append(document.createTextNode(ep.name))
                .appendTo($list);
        });
    }

    // 画质下拉:取第一集 clarity(background 已用 IYF.parsePlayInfo 解析),只列可下档,默认最高 bitrate;
    // 取不到则禁用下拉留空(留空 = 编排器逐集选最高可用)
    async function loadQuality() {
        const $q = $("#iyfQuality");
        const res = await iyfSend({ Message: "iyfPlay", tabId: iyfTab.id, episodeKey: iyfEpisodes[0].key });
        const list = (res && res.ok && Array.isArray(res.clarity) ? res.clarity : [])
            .filter(function (c) { return c && c.downloadable; });
        if (!list.length) { $q.prop("disabled", true); return; }
        list.forEach(function (c) {
            const label = c.title + (c.description ? " " + c.description : "") + (c.isVIP ? " [VIP]" : "");
            $q.append($("<option></option>").val(c.title).text(label));
        });
        // 默认选最高的【非 VIP】档:非会员请求 VIP 档,CDN 返回的是纯音频受限内容(真机实测),
        // 会下出没有视频轨的坏文件,故不能拿 VIP 档当默认;全是 VIP 档时才退回最高档。
        const free = list.filter(function (c) { return !c.isVIP; });
        const pool = free.length ? free : list;
        const best = pool.reduce(function (a, c) { return (c.bitrate || 0) > (a.bitrate || 0) ? c : a; });
        $q.val(best.title);
    }

    $("#iyfToggleAll").click(function () {
        const $boxes = $("#iyfEpList input");
        const allChecked = $boxes.length && $boxes.filter(":checked").length === $boxes.length;
        $boxes.prop("checked", !allChecked);
    });

    // 区间勾选:如 3-10(单集号也行),1-based → expandEpisodeRange 展开;区间即选择,区间外取消勾选
    $("#iyfRangeApply").click(function () {
        const m = $("#iyfRange").val().trim().match(/^(\d+)(?:-(\d+))?$/);
        if (!m) { Tips("区间格式如 3-10", 1500); return; }
        const from = parseInt(m[1]) - 1;
        const to = (m[2] ? parseInt(m[2]) : parseInt(m[1])) - 1;
        const set = new Set(IYF.expandEpisodeRange({ mode: "range", from: from, to: to }, iyfEpisodes.length));
        $("#iyfEpList input").each(function () {
            this.checked = set.has(parseInt(this.dataset.index));
        });
    });

    $("#iyfStart").click(function () {
        const eps = [];
        $("#iyfEpList input:checked").each(function () {
            const ep = iyfEpisodes[parseInt(this.dataset.index)];
            eps.push({ key: ep.key, name: ep.name });
        });
        startJob(eps, $("#iyfQuality").val() || "", IYF.cleanSeriesTitle(iyfTab.title));
    });

    async function startJob(eps, quality, seriesTitle) {
        if (!eps.length) { Tips("未选择任何集", 1500); return; }
        const res = await iyfSend({
            Message: "iyfStartJob",
            tabId: iyfTab.id,
            seriesKey: iyfSeriesKey,
            seriesTitle: seriesTitle,
            episodes: eps,
            quality: quality,
        });
        if (!res || !res.ok) { Tips("发起失败:" + ((res && res.err) || "无响应"), 2000); return; }
        showProgressView(res.state);
    }

    // ---- 进度视图 ----
    function showProgressView(state) {
        $("#iyfSelectView").addClass("hide");
        $("#iyfProgressView").removeClass("hide");
        renderState(state);
        if (!state || !state.finished) { startPoll(); }
    }

    function renderState(state) {
        if (!state) { return; }
        iyfLastState = state;
        $("#iyfRestoredTip").toggleClass("hide", !state.restored);
        const p = state.progress;
        let head = (state.seriesTitle || state.seriesKey) + ":完成 " + p.done + "/" + p.total + ",失败 " + p.failed;
        if (state.finished) { head += state.cancelled ? "(已取消)" : "(已结束)"; }
        $("#iyfProgressSummary").text(head);
        const $list = $("#iyfEpStatus").empty();
        state.episodes.forEach(function (ep) {
            let txt = STATUS_TEXT[ep.status] || ep.status;
            // 下载中显示切片进度/阶段(offscreen 下载器上报):下载 37% (80/215) → 转封装 → 落盘
            if (ep.status === "downloading" && ep.progress && ep.progress.total > 0) {
                const pr = ep.progress;
                if (pr.phase === "remux") { txt = "转封装中"; }
                else if (pr.phase === "save") { txt = "落盘中"; }
                else {
                    txt = "下载 " + Math.floor(pr.done * 100 / pr.total) + "% (" + pr.done + "/" + pr.total + ")";
                }
            }
            if (ep.status === "failed") {
                txt += "(已重试" + ep.retries + "次)";
                if (ep.err) { txt += " " + ep.err; }
            } else if (ep.retries > 0 && ep.status !== "done") {
                txt += "(第" + (ep.retries + 1) + "次)";
            }
            $('<div class="iyfEpRow"></div>')
                .append($("<span></span>").text("第" + ep.name + "集"))
                .append($("<span></span>").text(txt))
                .appendTo($list);
        });
        $("#iyfCancel").toggleClass("hide", !!state.finished);
        $("#iyfRetryFailed").toggleClass("hide", !(state.finished && p.failed > 0));
        $("#iyfReselect").toggleClass("hide", !state.finished);
        if (state.finished && p.failed > 0) {
            const names = state.episodes
                .filter(function (e) { return e.status === "failed"; })
                .map(function (e) { return e.name; }).join("、");
            $("#iyfFailedList").removeClass("hide").text("失败集:" + names);
        } else {
            $("#iyfFailedList").addClass("hide");
        }
        if (state.finished) { stopPoll(); }
    }

    function startPoll() {
        stopPoll();
        iyfPollTimer = setInterval(async function () {
            const res = await iyfSend({ Message: "iyfJobState" });
            if (res && res.ok && res.state) { renderState(res.state); }
        }, 1500);
    }

    function stopPoll() {
        if (iyfPollTimer) { clearInterval(iyfPollTimer); iyfPollTimer = null; }
    }

    $("#iyfCancel").click(async function () {
        const res = await iyfSend({ Message: "iyfCancelJob" });
        if (res && res.ok) { renderState(res.state); }
    });

    // 补下:把失败集作为新 job 重发,复用同画质
    $("#iyfRetryFailed").click(function () {
        const st = iyfLastState;
        if (!st) { return; }
        const eps = st.episodes
            .filter(function (e) { return e.status === "failed"; })
            .map(function (e) { return { key: e.key, name: e.name }; });
        startJob(eps, st.quality || "", st.seriesTitle || IYF.cleanSeriesTitle(iyfTab.title));
    });

    $("#iyfReselect").click(function () { showSelectView(); });
})();
