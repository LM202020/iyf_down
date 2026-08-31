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
- [~] **T5 命名 + 集成 + 端到端**:`<剧名>/<剧名>-第NN集.mp4` 零填充、`saveAs:false`;真实浏览器对短剧端到端。**因 B 方案签名墙受阻,端到端部分并入 T8**;命名/saveAs 逻辑已单独验证正确。
  - 验收:落盘文件数/命名正确、全程无弹框。

### 路线修正后新增(签名逆向重写,依据设计文档 §12)

- [x] **T6 签名层**:`js/iyf-sign.js`——自带 blueimp `md5` + query 归一化(去 vv/pub、值 decodeURIComponent 且 `+`→空格、保序、整串 toLowerCase)+ `sign(query,pub,priv)→{vv,pub}` + node assert 自检(用侦察实证的 md5 测试向量)。UMD、不依赖 chrome。
  - 验收:`node js/iyf-sign.js` 自检通过,对侦察样本 query 算出的 vv 精确等于 `bba708cd5c5df95d5bc6cd1ef0a0ac23`。
- [x] **T7 取数层加签名 + 探针**:`js/iyf-api.js` 取数前经 MAIN world `fetch(location.href)` 读 `pConfig`(每会话缓存)、给 `languagesplaylist`/`video/play` URL 加签名;`js/iyf-orchestrator.js` 加启动签名探针(code:1 报「签名规则已变」中止)+ 拿到 m3u8 后签名并作 `tsAddArg` 传 openParser;background.js importScripts 加 `iyf-sign.js`。
  - 验收:样本剧探针 `code:0`;`languagesplaylist` 返回 33 集;`video/play` 返回 576 档 m3u8。
- [x] **T8 端到端(吸收 T5)**:~~`tsAddArg` 后缀生效使 ts 下载成功~~ **实测裁决相反**:tsAddArg 截掉 ts 原有 vendtime/vhash 致 CDN reset(T5 卡 0/215 真因);CDN 会把 chunklist 的 vv/pub 回填进每个 ts URL → **只签 chunklist、去 tsAddArg**(42c57ba)。过渡版(forceLocal 走 m3u8.js 本地 mux)落盘 3 集可播 mp4(H264+AAC,41–44min,104–120MB)。
  - 验收:已达成(过渡版);过渡 hack 由 T9 撤销,最终验收归 T11。

### 方案2:自写精简下载页(依据设计文档 §13)

- [x] **T9 自写下载器**:`iyf-dl.html`+`js/iyf-dl.js`(chunklist 白名单 parser+最小并发器+mux.js remux+完成信号,parser 带 node 自检);orchestrator `openParser`→`iyfOpenDownloader`,完成信号消息化(幂等锚 iyfParserTabs,onRemoved 降级兜底);background +2 消息;撤销 m3u8.js forceLocal 3 行(核心恢复零改动)。实现 9cd1edb,评审修正 7b6d2b6(幂等结算 + 等落盘 complete 再自关)。
  - 验收:`node js/iyf-dl.js`、`node js/iyf-job.js` 自检过;触及文件 `node --check` 过。
- [~] **T10 仓库独立化 `iyf_down`**:已完成——非-fork 仓库 `LM202020/iyf_down` 建立、origin 已指向、upstream 已删、manifest homepage_url 已指(c5e4b57)。待做——README/CLAUDE.md 身份改造(cat-catch/猫抓表述改 iyf_down,**保留 LICENSE + 注明基于 cat-catch (GPL-3.0) 二开**);端到端过后 push(c5e4b57 起尚未 push)。
- [ ] **T11 端到端(方案2 最终验收)**:样本剧前 3 集经 iyf-dl 路径落盘。
  - 验收:3 个 mp4 落盘、ffprobe H264+AAC 可播、命名 `这一秒过火/这一秒过火-第NN集.mp4` 零填充、状态机全 done(靠消息)、全程无 m3u8.html/ffmpeg tab、无弹框。

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
- 2026-08-31:**签名逆向侦察完成(只读,实证 md5 精确匹配)。用户拍板走逆向重写。** 结论:
  - `vv = md5(publicKey + "&" + 归一化query + "&" + privateKey[0])`,`pub = publicKey`。
  - 归一化:去掉 vv/pub 两参 → 每值 decodeURIComponent 且 `+`→空格 → 保持原顺序 → 整串 toLowerCase;path 不参与,只签 query。
  - 密钥对 `pConfig:{publicKey,privateKey:[...]}` 在 **play 页服务器返回的 HTML 内联 JSON** 里,每次页面加载换一对;扩展 `fetch(location.href)` 正则 `"pConfig":\{"publicKey":"([^"]+)","privateKey":(\[[^\]]*\])\}` 读一次即可。Fallback:cert 未加载时 `pub=Date.now()`、privateKey 用硬编码 8 元素数组、索引 `ts%8`。
  - CDN 段**批量复用同一签名**:m3u8 签一次,每个 `media_N.ts` **照抄** m3u8 的 `&vv=...&pub=...` 后缀即可(这正是 T5 卡 `0/215` 的原因:openParser 重发 ts 没带后缀)。
  - 站点签名器(Angular DI 服务 `uriSignature`/`get_query`)闭包私有、不挂 window,**形态 B(MAIN world 直接调)不可行**;**形态 A(md5 独立重写)推荐**,无 wasm/无动态密钥,难度易。
  - 侦察脚本在 scratchpad(`verify_final.py`/`verify_vv.py`/`verify_cdn.py`/`sig_recon2.py`),含可复现测试向量。
  - **待面谈拍板的实现分歧**:给每个 ts 拼 vv/pub 后缀这一步,如何在**不改猫抓核心 m3u8.js** 前提下落地(候选:自己 fetch+改写 playlist 后喂 openParser / DNR 动态给 ts 请求加 query / 其他)。走 `/grill-with-docs` 敲定后进入实现(改 T2 取数层加签名、新写签名纯函数模块 TDD)。→ **后续实测证明分歧本身不存在**:CDN 回填使 ts 无需拼任何参数,见 T8/42c57ba。
- 2026-08-31:T6/T7 完成提交(f227349、18ad2c6)。**T8 端到端(过渡版)跑通并固化 42c57ba**——tsAddArg 判废(截 vendtime/vhash 致 CDN reset),改「只签 chunklist,CDN 回填 ts 签名」;`video/play` 取分集需 `a=0`;m3u8.js 临时加 forceLocal 3 行走本地 mux。3 个可播 mp4 证据留存上轮 scratchpad `downloads/`。用户拍板**方案2**(自写下载页替代 openParser 通道)+ **仓库独立化 iyf_down**。c5e4b57:建非-fork 仓库 `LM202020/iyf_down`、origin 迁移、upstream 删除、homepage_url 改指;iyf-dl.html/js 新文件同车。
- 2026-08-31:**交接事故记录**:上轮 session 交接卡声称方案2改动已提交为 `43ba95d`、交接卡自身提交为 `6a1e3f8`——两 SHA 经 reflog 核实**从不存在**,改动实际悬在工作树、卡也未落盘(草稿在上轮 scratchpad RESUME.md)。本轮接手后按 git 现读重建:方案2原样固化 9cd1edb。
- 2026-08-31:T9 完成——评审 9cd1edb 发现两处问题并修正提交 7b6d2b6:①done/failed 消息结算不查 iyfParserTabs 且信任消息 index,与 onRemoved 兜底有双结算竞态 → 幂等锚定 map、索引取 map 值;②iyf-dl 落盘启动 800ms 后即 window.close,blob URL 随页面销毁会掐断大文件写盘 → 等 downloads.onChanged state=complete(同 m3u8.js:912 时机)再报再关。设计文档 §13 + 本计划 T9–T11 补齐。T11 端到端进行中。
