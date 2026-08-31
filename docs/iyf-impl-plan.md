# iyf 多集下载模块 — 实现计划 & 进度 ledger

依据 `iyf-multi-download-design.md`(决策定稿,B 方案)。逐任务派 subagent 实现,主 session 评审+提交。分支 `feat/iyf-multi-download`。

约束:只新增 iyf 相关文件 + 对 popup/background 的最小挂接改动;**不改猫抓核心下载/嗅探逻辑**;下载 100% 复用 `openParser()`。

## 任务分解(有依赖,顺序执行)

- [x] **T1 基础层**:`js/iyf-common.js`——`IYF_HOSTS`、`isIyfHost(url)`、`parseSeriesKey(url)`、`cleanSeriesTitle(title)`、`expandEpisodeRange(sel,total)` 等纯函数 + `assert` 自检;popup 命中 iyf 域名才显示的空面板骨架。
  - 验收:`node js/iyf-common.js` 自检通过;iyf 页面 popup 显示空面板、非 iyf 不显示。
- [x] **T2 API 客户端**(代码已提交;实测验收待确认):页面上下文取数——`languagesplaylist` 拿全集 `{key,name}`;`video/play?id=<key>` 拿 `clarity[]`+m3u8。经 `chrome.scripting.executeScript`(MAIN world)或消息通道,`credentials:include`。
  - 验收:对样本剧返回 33 集列表 + 某集可用画质档与 m3u8。
- [x] **T3 编排器(background)**:`DownloadJob` 状态机——背压队列(默认 3,设置项)、集级重试 N 次、取消、状态存 `chrome.storage.session`;逐集选画质档→`openParser` 下载。纯逻辑(背压/重试/失败收集)TDD。
  - 验收:纯函数测试通过;能对选中集批量起下载 tab、遵守并发上限。
- [x] **T4 popup 面板 UI**:集列表(勾选/全选/区间)、画质下拉(动态按 `clarity` `isEnabled&&path`,默认最高可用)、下载/取消、集级状态。发 `startJob`/`cancelJob`,读回状态。
  - 验收:面板可选集/选画质/发起/取消/看到集级进度。
- [ ] **T5 命名 + 集成 + 端到端**:`<剧名>/<剧名>-第NN集.mp4` 零填充、`saveAs:false`;真实浏览器对短剧(3–5 集)端到端跑通。
  - 验收:落盘文件数/命名正确、全程无弹框。

## 关键常量/事实(供各 subagent)
- `IYF_HOSTS = [iyf.tv, aiyifan.tv, dnvod.tv, ifsp.tv, jssp.tv, kubb.tv, lgsp.tv, flyv.tv]`
- 剧名清洗:标题 `<剧名>-NN-免费在线观看-爱壹帆`,正则 `/-\d+-免费在线观看-爱壹帆$/` 剥离
- ~~API 域名 `m10.iyf.tv`(或 `rankv21.iyf.tv`);`video/play` 裸调(带 cookie、无需 vv/pub 签名)即返回 m3u8~~ **【2026-08-31 T5 实测证伪】** 裸调 `languagesplaylist`/`video/play` 均回 `{"code":1,"msg":"用户签名错误"}`,API 端点需运行时 vv/pub 签名;且**每个 .ts 分段也需 vv/pub**(去签名 CDN 直接 reset)。B 方案(调 API 拿 URL→openParser 重新 fetch)对当前站点整体失效,详见进度段。
- 画质档在 `data.info[0].clarity[]`:`{title:"1080",description:"蓝光",isVIP,isEnabled,path:{isHls,result}}`;可下=`isEnabled&&path!=null`
- 分集在 `languagesplaylist` 的 `data.info[0].playList[]`:`{key,name:"01"}`
- 下载复用:`openParser(data,{autoDown:true,autoClose:true,filename})`(`js/function.js`)

## 进度
- 2026-08-31:计划建立。T1 已派 subagent。
- 2026-08-31:T1 完成并提交(72a2e53),`node js/iyf-common.js` 自检通过。T2 完成并提交(cf3f0f3),对样本剧的实测验收(33 集列表+画质档)待确认。T3 已派 subagent。
- 2026-08-31:T3 完成——`js/iyf-job.js`(状态机纯函数+自检)、`js/iyf-orchestrator.js`(胶水层),background 挂 `iyfStartJob`/`iyfCancelJob`/`iyfJobState` 三消息。已知妥协(代码内有 `ponytail:` 注):集完成信号=下载 tab 关闭(手动关 tab 误计完成;失败 tab 不自关则悬停靠取消收尾);worker 重启只恢复快照展示不续跑。供 T4 对接的消息形状见 iyf-orchestrator.js 注释。
- 2026-08-31:T4 完成——`js/iyf-panel.js`(选择/进度双视图、区间勾选、画质下拉、取消、补下),popup.html/css 增量。顺带修 T1 bug:`#iyfPanel` 误带 `container` 类会错位 popup 的 tab 序号映射,已去掉。待 T5 端到端。
- 2026-08-31:**T5 端到端失败——站点签名墙,非模块 bug。阻塞待用户就"决策 1"重新拍板。** 真实浏览器(headful,headless 被 CF 挡)加载扩展、注入、编排链路全通,但两道墙均需运行时 vv/pub 签名(硬约束禁绕过):①API 裸调回"用户签名错误"(证伪 §2 前提);②每个 .ts 分段也需 vv/pub,openParser 重发的请求不带签名 → 卡在 `0/215` 段。命名逻辑单独验证正确(`这一秒过火/这一秒过火-第01集.mp4` 零填充对)。三条路线:**(1)转 A 方案真播放嗅探**(复用猫抓 webRequest 抓 hls.js 已带签名的请求,不碰签名,最稳,但 T2/T3 取数层要大改)/(2)MAIN world 挂钩站点签名器给 URL 补签(脆,站点改即失效)/(3)暂缓。子 agent 与主 session 均推荐 (1)。次要缺口(被墙2掩盖,未修):`iyfRunEpisode` 调 openParser 未传 `requestHeaders`,缺 DNR 改 Referer 规则。**代码未 merge,分支 feat/iyf-multi-download 保留 T1–T4 成果待路线定夺。**
