# RESUME 交接卡 — iyf_down 4K/HEVC 支持（2026-09-01，compact 兜底，自包含）

## 任务与授权
在 **iyf_down**（`/Users/ll/Claude/Chrome_iyv_plug`，cat-catch 二开的 MV3 扩展）上继续开发 iyf.tv 多集下载。
用户授权：改核心、改架构、真机调试（用户已提供登录态调试窗口，要求**我自己把流程跑通再汇报**，别让他一步步测）。

## 当前状态（git 现读为准）
- 分支 `feat/iyf-page-cleanup`（从 master 建），主 checkout = `/Users/ll/Claude/Chrome_iyv_plug`
- 提交链：`f87bc06`(列表过滤) → `6cddce1`(登录凭证修复) → `ad21bff`(offscreen+进度) → `62d19c7`(默认1080/HEVC防护)
- master 已含更早的方案2 全部工作并 push 到 `origin`(github.com/LM202020/iyf_down)
- 本分支尚未合并/push

## ✅ 已完成并真机验证通过（我自己驱动跑通，非用户测）
端到端实测（2 集并发，登录态）：
```
默认画质 1080 | 全程 下载tab=0 | offscreen=True 跑完自动关
进度 9/105 → 105/105（download/remux/save 三阶段）
结果: done 2/2 failed 0
文件: 303MB & 332MB | 19.8分钟 | video h264 1920x1080 + audio aac（两集内容各异）
```
1. **登录凭证修复**：`video/play` 必须带账号凭证 + vv/pub 两套签名
2. **offscreen 架构**：下载不再弹 tab
3. **面板进度**：切片级实时进度
4. **默认 1080**：避开 HEVC
5. **列表过滤**：iyf 页面只留 m3u8/mpd 正片入口

## 🔒 承重事实（实证过，别推翻别重查）

### 1. 登录凭证机制（`6cddce1`）
- 站点调 `video/play` 是**两套签名一起带**：`uid/expire/gid/sign/token`（账号）+ `vv/pub`（游客）
- 账号凭证来源：**cookie `dn_temp` 里的 `__t` JSON**（含 uid/expire/gid/sign/token）
- **`vv` 必须对「含账号参数的完整 query」算 md5** —— 先拼账号参数，再 `iyfSignUrl`
- 只带 vv/pub → 站点回 `{"data":{"code":5,"msg":"访问过量"}}`。**这不是频率限制，是拒绝话术**
  （决定性对照：同一时刻同一接口，带账号凭证→「用户签名错误」，只带vv/pub→「访问过量」）
- `region` 参数可省；`lang=none` 站点没有，已去掉
- 实现：`js/iyf-api.js` 的 `iyfMainReadAuth/iyfGetAuth/iyfResetAuth/iyfAuthQuery`

### 2. 编码事实（ffprobe 实拉切片验证，与 VIP 无关——用户是会员）
```
576  = h264 896x504      720 = h264 1280x720
1080 = h264 1920x1080    2160 = hevc 3840x2160   ← 只有这档是 H.265
```
- **mux.js 只支持 H.264+AAC**，喂 HEVC 只吐音频轨 → 产出 28.6MB 纯音频坏文件（旧 bug 现象）
- `IYF.pickQuality` 默认在非 HEVC 档里选最高（=1080）；`iyfRemux` 检测无视频轨即报错

### 3. offscreen 架构（`ad21bff`）
- 下载跑在 **MV3 offscreen 单例文档**（`iyf-dl.html`，不占标签栏），多集并行都在这一个文档里
- **offscreen 拿不到 `chrome.downloads`** → 转封装完把 blob URL 交 background 落盘，
  等 `downloads.onChanged state=complete` 才算完成，再通知 offscreen `revoke`
- 幂等锚 = **集索引**（不再是 tabId）；已 done/failed 的集再来消息一律丢弃（`iyfSettled`）
- job 收尾自动 `chrome.offscreen.closeDocument()`
- manifest 已加 `"offscreen"` 权限
- 取数节流仍在：`IYF_FETCH_GAP_MS = 3000`（集间 video/play 错开）

### 4. 取数依赖页面 tab
`iyfFetchPlay` 走 `chrome.scripting.executeScript` 到 iyf 页面 MAIN world。
**iyf 页面 tab 关闭/未稳定 → `Error: No tab with id`**（下载会失败）。测试时务必等页面 load 完再发起。

## 🎯 立即下一步：支持 4K / HEVC

用户明确要求：**1080 已调通，现在把 4K 支持起来**。用户问「mp4box.js 还是 ffmpeg.wasm」。

### 选型调研（已做的部分）
| 方案 | 判断 |
|---|---|
| **mp4box.js** | ❌ 不推荐。它是 **MP4 容器工具，读不了 MPEG-TS**。走它必须自写 HEVC TS demuxer（PAT/PMT/PES 解析、NALU 提取、VPS/SPS/PPS、时间戳对齐），几百行高风险代码 |
| **ffmpeg.wasm** | ✅ 主推。`-i in.ts -c copy out.mp4` 一条命令 remux（不转码），HEVC 现成支持。代价：core ~25-32MB、MV3 需 CSP 加 `'wasm-unsafe-eval'`、必须本地打包（CSP 禁 CDN）、大文件内存压力（4K 一集可能 1-2GB） |
| **复用已 vendored 的 hls.js** | ⚠️ 待查。`lib/hls.min.js` 已存在（543KB），自带 TS demuxer，新版支持 HEVC 且内部 transmuxer 会产出 fMP4。**零新增体积**，但要 hack 内部 API，且**版本未确认**（grep 'hvc1|hev1|HEVC' 只命中 1 次，疑似老版本不支持 HEVC）→ **接手第一步就查它的版本** |
| **零依赖兜底** | 4K 直接拼 `.ts` 输出（不 remux）。VLC/IINA/mpv 可播，QuickTime 不行。作为大文件降级方案 |

### 推荐实施路线
1. **先查 `lib/hls.min.js` 版本与 HEVC 支持**（`grep -o 'hls\.js v[0-9.]*'` 或找 version 字段）。若 ≥1.5 且支持 HEVC，优先走它（零新增体积）
2. 否则用 **ffmpeg.wasm，按需加载 + 只用于 HEVC 档**：H.264 档继续走 mux.js（轻快、已验证），用户选 2160 时才加载那 ~30MB
3. manifest 需加：`"content_security_policy": {"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"}`
4. 大文件内存风险若撞上 → 降级 `.ts` 直出，或分段处理
5. 改完必须**自己在调试窗口跑通 4K 一集**（ffprobe 验 `video hevc 3840x2160`）再汇报

## 🛠 调试环境（重要，接手直接用）
- **调试窗口**：headful Chrome（Google Chrome for Testing），已加载扩展、**用户已登录 iyf**
  - profile: `<SCRATCH>/udata_debug`，CDP 端口 **9222**
  - 启动命令见下（窗口若被关，重启即可，登录态在 profile）
- **SCRATCH** = `/private/tmp/claude-501/-Users-ll-orca-workspaces-Chrome-iyv-plug-charybdis/c6753249-5c2b-4aa3-bfa7-f59b41da4224/scratchpad`
- **venv**（有 playwright）= `/private/tmp/claude-501/-Users-ll-Claude-Chrome-iyv-plug/b73e18c7-767c-4b64-9b03-99ca9771b551/scratchpad/venv/bin/python3`
- **ffprobe** = `/opt/homebrew/bin/ffprobe`
- 重启窗口：
```bash
pkill -f udata_debug; sleep 3
CHROME="/Users/ll/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
EXT=/Users/ll/Claude/Chrome_iyv_plug
"$CHROME" --user-data-dir="$SCRATCH/udata_debug" --load-extension="$EXT" --disable-extensions-except="$EXT" \
  --remote-debugging-port=9222 --no-first-run --no-default-browser-check "https://www.iyf.tv/play/hu2ZNzw9VT4"
```
- **现成脚本**（都在 SCRATCH）：`full_e2e.py`(完整端到端+ffprobe验证)、`verify_simple.py`(取数验证)、
  `probe_ts.py`/`probe_codecs.py`(拉切片验编码)、`inject_sniff.py`+`read_sniff.py`(注入hook抓站点请求)、
  `check_dl.py`(查 chrome.downloads 真实落盘路径)
- 样本剧：`https://www.iyf.tv/play/hu2ZNzw9VT4`（重案六组:消失的警号，12集）

## ⚠️ 踩坑教训（别重踩）
1. **绝不用 `chrome.runtime.reload()`** —— 会把扩展搞成禁用/SW 唤不醒，得重启窗口。改代码后**重启整个调试窗口**
2. **改了 SW 代码必须清 profile 的 SW 缓存**：`rm -rf "$PROFILE/Default/Service Worker" "$PROFILE/Default/Code Cache"`，
   否则跑的是旧代码（症状：新符号 `typeof iyfXxx === 'function'` 为 false）。脚本里要加**新代码符号断言** fail-fast
3. **Playwright connect_over_cdp 会劫持下载**：文件被改名挪到 `/var/folders/.../playwright-artifacts-*/`（UUID 名）。
   不是扩展 bug。验证落盘路径要用 `chrome.downloads.search`（见 `check_dl.py`），别用 Playwright 的 suggested_filename
4. **CDP `page.on("response")` 对已打开页面抓不到网络**（挂不上）。抓站点请求要**注入 fetch/XHR hook**（`inject_sniff.py`）
5. 抓包别截断 URL —— 我曾 `slice(0,240)` 把 `token=` 后面的 `vv/pub` 截掉，导致误判
6. 端到端验证**别派 subagent**，自己写阻塞脚本用 `Bash run_in_background`

## 📚 持久底座
- `docs/iyf-multi-download-design.md`（§12 签名逆向、§13 方案2 自写下载页 —— **注意 §13 的 tab 架构已被 offscreen 取代，待更新**）
- `docs/iyf-impl-plan.md`（任务 ledger，T11 端到端结论 —— **待补本轮 offscreen/登录凭证/HEVC 三项**）
- `docs/GLOSSARY.md`、`CLAUDE.md`
- mem0（项目 `github.com-lm202020-iyf_down` + 全局教训）

## 📋 待办（按优先级）
1. **4K/HEVC 支持**（用户当前要求，见上面选型）
2. docs 更新：设计 §13 改 offscreen 架构、impl-plan 补本轮三项修复
3. 本分支合并回 master 并 push
4. 用户目录里 `~/Downloads/重案六组消失的警号/` 那两个 28.6MB 是旧代码的纯音频坏文件，可删
