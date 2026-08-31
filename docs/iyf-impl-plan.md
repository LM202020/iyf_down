# iyf 多集下载模块 — 实现计划 & 进度 ledger

依据 `iyf-multi-download-design.md`(决策定稿,B 方案)。逐任务派 subagent 实现,主 session 评审+提交。分支 `feat/iyf-multi-download`。

约束:只新增 iyf 相关文件 + 对 popup/background 的最小挂接改动;**不改猫抓核心下载/嗅探逻辑**;下载 100% 复用 `openParser()`。

## 任务分解(有依赖,顺序执行)

- [ ] **T1 基础层**:`js/iyf-common.js`——`IYF_HOSTS`、`isIyfHost(url)`、`parseSeriesKey(url)`、`cleanSeriesTitle(title)`、`expandEpisodeRange(sel,total)` 等纯函数 + `assert` 自检;popup 命中 iyf 域名才显示的空面板骨架。
  - 验收:`node js/iyf-common.js` 自检通过;iyf 页面 popup 显示空面板、非 iyf 不显示。
- [ ] **T2 API 客户端**:页面上下文取数——`languagesplaylist` 拿全集 `{key,name}`;`video/play?id=<key>` 拿 `clarity[]`+m3u8。经 `chrome.scripting.executeScript`(MAIN world)或消息通道,`credentials:include`。
  - 验收:对样本剧返回 33 集列表 + 某集可用画质档与 m3u8。
- [ ] **T3 编排器(background)**:`DownloadJob` 状态机——背压队列(默认 3,设置项)、集级重试 N 次、取消、状态存 `chrome.storage.session`;逐集选画质档→`openParser` 下载。纯逻辑(背压/重试/失败收集)TDD。
  - 验收:纯函数测试通过;能对选中集批量起下载 tab、遵守并发上限。
- [ ] **T4 popup 面板 UI**:集列表(勾选/全选/区间)、画质下拉(动态按 `clarity` `isEnabled&&path`,默认最高可用)、下载/取消、集级状态。发 `startJob`/`cancelJob`,读回状态。
  - 验收:面板可选集/选画质/发起/取消/看到集级进度。
- [ ] **T5 命名 + 集成 + 端到端**:`<剧名>/<剧名>-第NN集.mp4` 零填充、`saveAs:false`;真实浏览器对短剧(3–5 集)端到端跑通。
  - 验收:落盘文件数/命名正确、全程无弹框。

## 关键常量/事实(供各 subagent)
- `IYF_HOSTS = [iyf.tv, aiyifan.tv, dnvod.tv, ifsp.tv, jssp.tv, kubb.tv, lgsp.tv, flyv.tv]`
- 剧名清洗:标题 `<剧名>-NN-免费在线观看-爱壹帆`,正则 `/-\d+-免费在线观看-爱壹帆$/` 剥离
- API 域名 `m10.iyf.tv`(或 `rankv21.iyf.tv`);`video/play` 裸调(带 cookie、无需 vv/pub 签名)即返回 m3u8
- 画质档在 `data.info[0].clarity[]`:`{title:"1080",description:"蓝光",isVIP,isEnabled,path:{isHls,result}}`;可下=`isEnabled&&path!=null`
- 分集在 `languagesplaylist` 的 `data.info[0].playList[]`:`{key,name:"01"}`
- 下载复用:`openParser(data,{autoDown:true,autoClose:true,filename})`(`js/function.js`)

## 进度
- 2026-08-31:计划建立。T1 已派 subagent。
