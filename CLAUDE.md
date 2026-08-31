# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概况

Fork 自 [xifangczy/cat-catch](https://github.com/xifangczy/cat-catch)（猫抓，Chrome MV3 资源嗅探扩展），在其底座上开发 **iyf.tv 连续剧多集自动下载模块**（分支 `feat/iyf-multi-download`，自用不分发）。纯 JS，无打包/转译步骤，仓库根目录可直接作为"已解压的扩展程序"加载调试。

代码注释与文档使用中文。

## 常用命令

- `node js/iyf-common.js` — iyf 纯函数层的 assert 自检（唯一的自动化测试入口）
- `just quick` — 构建 ZIP 包；`just build` — CRX + ZIP；`just validate` / `just lint` — manifest 与必需文件检查
- `node tools/sync-locales.js` — 同步 `_locales/` 多语言文件
- 日常开发不需要构建：Chrome 扩展页开发者模式直接加载仓库根目录，改完刷新扩展即可

## 架构

### 猫抓底座（不改核心）

三段主链路：

1. **嗅探**：`js/background.js`（MV3 service worker，经 `importScripts` 加载 `polyfill.js`、`function.js`、`templates.js`、`init.js`、`iyf-common.js`、`iyf-api.js`）。`findMedia()` 挂在 `chrome.webRequest.onResponseStarted` 上捕获媒体请求，状态存 `chrome.storage.session`。
2. **展示**：`popup.html` + `js/popup.js` 列出捕获的资源；`options.html` 配置项。
3. **下载**：`js/function.js` 的 `openParser(data, {autoDown, autoClose, filename})` 打开后台 tab 载入 `m3u8.html` + `js/m3u8.js`，下分片 → mux.js 合并 → `chrome.downloads` 落盘。

其他：`catch-script/` 是注入页面的抓取脚本（深度嗅探、录制等）；`lib/` 为 vendored 第三方库（hls.js、mux.js、StreamSaver 等，见 `lib/third-party-libraries.md`）；`manifest.firefox.json` 是 Firefox 变体。

### iyf 多集下载模块（本 fork 新增）

**硬约束**：只新增 iyf 文件 + 对 popup/background 的最小挂接；不改猫抓核心嗅探/下载逻辑；下载 100% 复用 `openParser()`。

- `js/iyf-common.js` — 纯函数层（UMD：浏览器挂 `window.IYF`/`self.IYF`，node 走 `module.exports`），不依赖 chrome API。域名家族 `IYF_HOSTS`、剧 key 解析、集范围展开、画质挑选等。文件尾部带 `node` 可跑的 assert 自检——改这个文件必须跑 `node js/iyf-common.js`。
- `js/iyf-api.js` — background 侧 API 客户端。**关键约束**：iyf API 必须在页面上下文（MAIN world）里 fetch（依赖页面 cookie + 跨子域 CORS），不能在 background 直接 fetch；用 `chrome.scripting.executeScript({world:'MAIN'})` 注入，注入函数不能引用外部闭包变量。API 域名兜底 `m10.iyf.tv` → `rankv21.iyf.tv`。
- `js/background.js` 消息挂接：`iyfPlayList`（取全集列表）、`iyfPlay`（取单集画质+流地址）。
- `popup.html` 的 `#iyfPanel` — 命中 iyf 域名家族才显示的专属面板。

### iyf 文档（改模块前先读）

- `docs/iyf-multi-download-design.md` — 设计定稿：真播放切集取流（不逆向 vv/pub 签名）、背压并行（默认 3）、集级重试/补下等 10 项决策，及实测确认的站点事实（m3u8 无加密、流地址带 vendtime/vhash/IP 绑定所以必须同会话内即抓即下）。
- `docs/iyf-impl-plan.md` — T1–T5 任务分解与进度 ledger，含 API 响应结构等关键事实；完成任务后更新进度段。
- `docs/GLOSSARY.md` — 领域术语表（剧/集/剧key/集key/切集/已鉴权流地址/背压等），沟通与命名以此为准。
