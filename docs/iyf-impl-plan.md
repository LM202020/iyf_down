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
- [~] **T11 端到端(方案2 最终验收)**:样本剧经 iyf-dl 路径落盘。**代码通路验证通过,批量全绿受阻于站点风控。**
  - **已验证(2026-08-31 headful 实测)**:第 01 集经 iyf-dl.html 完整走通——fetch chunklist → 并发下 ts → mux.js remux → chrome.downloads 落盘,ffprobe 确认 H264+AAC、43min、120MB 可播;完成信号双向都验(01 靠消息标 done、02/03 靠消息标 failed);全程 `legacyTabs=0`(证明彻底不走 m3u8.js);无重复计(幂等 OK)。
  - ~~**未达/缺口**:①02/03 `empty clarity`,真因=站点「访问过量」频率风控。②真机命名未验。~~
    **【2026-09-01 两项均已解决,①的归因是错的】**:①「访问过量」不是频率限制,是**没带账号凭证**的拒绝话术
    (决定性对照见下方 2026-09-01 进度);补上凭证后多集连续取数无阻。②改用 `chrome.downloads.search`
    读真实落盘路径(Playwright 会劫持下载改名),命名 `剧名/剧名-第NN集.mp4` 已实测正确。
- 验收证据:`scratchpad/downloads_plan2/*.mp4`(01 集,勿删)。

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
- 2026-09-01:**真机调试三项修正,1080/4K 端到端均自验通过(设计文档 §14)。**
  - **①登录凭证(6cddce1)**:`video/play` 必须同时带账号凭证(cookie `dn_temp` 的 `__t` JSON 里的
    uid/expire/gid/sign/token)与 vv/pub 两套签名,且 `vv` 要对**已含账号参数的完整 query** 算 md5。
    **推翻此前「访问过量=频率风控」的归因**——同一时刻同一接口,带凭证回「用户签名错误」、只带 vv/pub 才回
    「访问过量」,它是拒绝话术不是限流。补上凭证后连续取数无阻。
  - **②offscreen(ad21bff)**:下载从「新开 tab」改为 MV3 offscreen 单例文档(不占标签栏),幂等锚从 tabId
    换成集索引;offscreen 拿不到 `chrome.downloads`,故转封装完把 blob 交 background 落盘等 complete。
    面板加切片级实时进度。
  - **③4K/HEVC**:2160 档是 H.265,mux.js 只认 H.264、静默丢视频轨(旧的 28.6MB 纯音频坏文件即此因)。
    改用自建 hls.js bundle(`lib/hls-transmux.min.js`,60KB,无 wasm/无 CSP 改动),另需自己合轨 +
    把 moof 的 tfdt 归零(hls.js 为 MSE 写,时间戳是绝对 PTS)。详见设计 §14.3。
  - **验收证据(自驱端到端,非用户手测)**:
    - 1080 两集并发:`下载tab=0`、offscreen 自动开关、进度 9/105→105/105、done 2/2、303MB+332MB、
      `h264 1920x1080 + aac`。
    - 2160 单集:默认档自动选 2160、105/105、落盘 515MB、`hevc 3840x2160 + aac`、时长 1188s、
      `start_time≈0`(时间轴归零生效)、5s/600s/1150s 三点 seek 均抽出 3840x2160 真帧、全片解码无错误。
    - **注**:Playwright `connect_over_cdp` 会劫持下载改名到 `/var/folders/**/playwright-artifacts-*/<UUID>`,
      真实路径要用 `chrome.downloads.search` 读,别信 `download.suggested_filename`。
  - **4K 内存(已处理,9221f7b)**:单集峰值约 1GB(540MB ts + 515MB mp4 同时驻 offscreen),
    并发 3 就是 3GB → 选中 2160 及以上档时并发强制压到 1(quality 留空按 `pickQuality` 实选档判定)。
    实测:2160 → concurrency 1,1080 → concurrency 3。

## 真机调试环境与踩坑(2026-09-01 实战总结)

调试窗口 = headful Google Chrome for Testing,`--user-data-dir` 指向一个常驻 profile(登录态存在里面)、
`--load-extension` + `--disable-extensions-except` 指向仓库根、`--remote-debugging-port=9222`,
再用 Playwright `connect_over_cdp` 驱动。踩过的坑,按代价排序:

1. **绝不用 `chrome.runtime.reload()`** —— 会把扩展搞成禁用态且 SW 唤不醒,只能重启窗口。改完代码**重启整个窗口**。
2. **改了 SW 代码必须清 profile 的 SW 缓存**:`rm -rf "$PROFILE/Default/Service Worker" "$PROFILE/Default/Code Cache"`,
   否则 `--load-extension` 指向新代码、跑的却是旧字节码。脚本里必须加**新符号断言**(`typeof iyfXxx === 'function'`)fail-fast。
3. **抓 SW 要遍历,不能 `next()` 取第一个** —— 窗口里往往不止一个扩展有 `background.js`,
   取错了就一直卡在错的那个上(症状:`chrome.tabs.query` 返回空、`t.url` undefined)。遍历全部 SW 逐个测项目符号才对。
4. **Playwright `connect_over_cdp` 会劫持下载**:文件被改名挪到 `/var/folders/**/playwright-artifacts-*/<UUID>`。
   这不是扩展 bug。验证真实落盘路径要用 `chrome.downloads.search`,别信 `download.suggested_filename`。
5. **CDP `page.on("response")` 对已打开的页面挂不上**(抓不到任何网络)。要抓站点请求得**注入 fetch/XHR hook**。
6. **抓包别截断 URL** —— 曾 `slice(0,240)` 把 `token=` 后面的 `vv/pub` 截掉,直接导致误判签名机制。
7. **端到端别派 subagent**,自己写阻塞脚本用后台任务跑,日志落文件。
8. 窗口刚重启时页面还在导航,`chrome.tabs.query` 查不到播放页 → `Error: No tab with id`。
   发起 job 前要**轮询等到 SW 侧真能查到播放页 tab**,再多等几秒。
9. 连着发两个 job 之间要等上一个 `finished`(cancel 只置 `cancelled`,在途集还要收尾),
   否则第二个会被「已有未完 job」拒掉。
- 2026-08-31:**T11 端到端(方案2)——代码通路验证通过,批量全绿受站点风控阻断。** headful 实测:第 01 集经 iyf-dl.html 全程走通(fetch chunklist→并发下 ts→mux remux→chrome.downloads 落盘,ffprobe H264+AAC/43min/120MB 可播),完成信号双向验证(done/failed 均靠消息),`legacyTabs=0` 证不走 m3u8.js,幂等无重复计。02/03 集 `empty clarity` 追因=站点「访问过量」频率风控(播放页转 `iyf.tv/challenge?triggerindex=访问过量`),风控在取数阶段,非下载器 bug。**踩坑**:Playwright 拷贝 profile 缓存旧 SW,首轮实际跑旧 m3u8 通道(legacyTabs=3、文件大小与 forceLocal 版吻合),删 `Default/Service Worker` 缓存 + SW 侧 `typeof iyfOpenDownloader` 断言后才跑到新代码。真机命名 Playwright 抓不到(chrome.downloads filename 退化成 UUID),命名逻辑代码正确待换验法。**待用户决策**:取数节流(规避风控)+ 是否 push(c5e4b57 起未 push)。设计 §13.5 补风控上限。
