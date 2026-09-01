# iyf.tv 连续剧多集自动下载模块 — 设计文档

- 日期:2026-08-31
- 项目:Chrome_iyv_plug(fork 自 xifangczy/cat-catch,Chrome MV3,自用不分发)
- 状态:**路线已修正(2026-08-31)——原 B 方案(真播放切集嗅探)经端到端实测被站点签名墙否决,改走「签名逆向重写」。§3–§7 为历史方案,进入实现以 §12 为准。**
- 领域术语:见 `GLOSSARY.md`

## 1. 目标

在猫抓底座上新增一个功能:在 iyf.tv(及其镜像域名)的连续剧播放页,一键把整部剧(或选定的若干集)自动、批量、静默地下载到本地,每集合并成一个 mp4。

非目标(本版不做):非 iyf 站点的多集下载;单集下载(猫抓原生已覆盖,用户可直接用);账号/VIP 内容的绕过(登录状态由用户自己的浏览器会话决定)。

## 2. 关键前提(2026-08-31 真实浏览器实测确认)

- 样本页 `https://www.iyf.tv/play/G3D93jBLAY4`(《这一秒过火》)。URL 里的 key 是**整部剧**的 key,不是分集。
- m3u8 **无 AES 加密**(无 `#EXT-X-KEY`),TS 明文分段,**不需要解密**。
- 视频用 hls.js 播放;流地址带 `vendtime`(过期)+ `vhash`(防盗链签名),ts 还带出口 **IP 绑定**(`vCustomParameter`)。→ 必须在浏览器内、同一会话、过期前下载。
- API 请求带 `vv`(32hex,疑 md5)+ `pub`(长串)签名,前端 JS 运行时生成。**本模块不逆向签名**。
- headless 直接可播放,未触发 Cloudflare Turnstile。
- 站点有一组同构镜像域名(iyf.tv / aiyifan.tv / dnvod.tv / ifsp.tv / jssp.tv / kubb.tv / lgsp.tv / flyv.tv …)。

## 3. 设计决策(定稿)

| # | 决策点 | 定论 |
|---|---|---|
| 1 | 取流策略 | **真播放切集**:注入脚本驱动页面切集 → hls.js 发请求 → 猫抓 webRequest 抓到已鉴权 m3u8。不逆向 vv/pub 签名 |
| 2 | 全集列表来源 | **DOM 抓**分集按钮为主;DOM 拿不全(懒加载/分页)时退回 `v3/video/languagesplaylist` API 补列表 |
| 3 | 切集/下载时序 | **流水线并行**:抓到 m3u8 不等下完就切下一集;**背压**控制(活跃下载数 < 上限才切下一集),保证流地址取到即下、不因排队过期 |
| — | 并行数 | 默认 **3**,设置项可调 |
| 4 | 下载范围 | **全部 + 区间/勾选**,默认全选 |
| 5 | UI 入口 | **popup 专属面板**,命中 iyf 域名家族才显示;popup 关闭不影响后台下载 |
| 6 | 命名/落点 | `<剧名>/<剧名>-第NN集.mp4`,集号零填充,**静默不弹另存为**(`saveAs:false`) |
| 7 | 画质 | **popup 统一选一档**,应用全剧 |
| 8 | 失败处理 | **集级自动重试 N 次 → 仍败则跳过标记 → 末尾一键补下**;与猫抓分片级重试两层独立 |
| 9 | 进度/控制 | **集级状态**(待/切集/下载中/✓/✗),**只做取消**不做暂停;状态存 background,popup 关闭再开可见 |
| 10 | 域名范围 | 认**整个镜像家族**,`IYF_HOSTS` 常量数组集中管理 |

## 4. 领域模型(实体与关系)

- **Series(剧)** 1 — N **Episode(集)**:一个下载任务面向一部剧。
- **DownloadJob(下载任务)** 1 — N **EpisodeDownload(集下载单元)**:任务持有整体进度、并行上限、取消标志、失败集清单。
- **EpisodeDownload** 有 **EpisodeStatus**(待/切集/下载中/完成/失败)与重试计数。
- **DownloadJob** 受 **Backpressure(背压)** 约束:活跃 EpisodeDownload 数 < 并行上限时才推进切集。

## 5. 架构与数据流

复用猫抓既有的三段主链路,只在最前面加"iyf 编排层":

```
[popup iyf 面板]                    [background: iyf 编排器]            [页面: iyf 切集脚本(注入)]
 选画质/选集/点下载 ─ startJob ─▶  建 DownloadJob
                                    循环(受背压):
                                      ├ 令切集脚本切到第 N 集 ──────▶ 点分集按钮/触发路由
                                      │                               hls.js 发 m3u8/ts 请求
                                      │  ◀─ 猫抓 webRequest 抓到已鉴权 m3u8(background.js findMedia)
                                      ├ openParser(该集 m3u8,{autoDown,autoClose,filename})
                                      │      └▶ [m3u8.html 后台 tab] 下分片→mux.js 合并→chrome.downloads 落盘
                                      └ 更新 EpisodeStatus,推进下一集
 ◀─ 集级状态回传(popup 打开时渲染) ┘
```

- **切集 ⇄ 抓流的配对**:编排器令脚本切到第 N 集后,监听 webRequest 新出现的 m3u8(按当前 tab + 时间窗 + 是否 iyf 流域名匹配),把它认作"第 N 集的流地址"。此配对判定是待实测的关键 fact(见 §8)。
- **下载与切集解耦**:拿到第 N 集 m3u8 即交给 `openParser` 开后台 tab 下载,不等下完;由背压(活跃 tab 数)决定何时切第 N+1 集。

## 6. 组件划分

**直接复用猫抓(不改核心)**
- 网络嗅探:`chrome.webRequest.onResponseStarted` + `findMedia()`(`js/background.js`)。
- 单集下载→合并→落盘:`openParser()`(`js/function.js`)→ `m3u8.html` + `js/m3u8.js`(mux.js 合并、`chrome.downloads`/StreamSaver 落盘)。
- 批量开后台 tab 的编排范式:参照 `js/popup.js` 的 `#DownFile` 循环 + 错峰 setTimeout。
- tabId 状态管理范式:参照 `G.featAutoDownTabId` + `chrome.storage.session`。

**新写**
- **iyf 切集控制脚本**:注入 iyf 页面(仿 `catch-script/catch.js` 的 `chrome.scripting.executeScript` 注入方式,但为 iyf 专用、由编排器主动调用而非走猫抓通用按钮注册)。职责:枚举分集元素、按序号切集、上报"切集完成/失败"。
- **iyf 编排器(background)**:管理 DownloadJob 生命周期——建任务、背压推进切集、配对 m3u8、调 openParser、集级重试、取消、失败集清单、状态存储。
- **popup iyf 面板**:命中 `IYF_HOSTS` 时显示;渲染集列表 + 勾选/区间 + 画质下拉 + 下载/取消按钮 + 集级进度;向 background 发起 `startJob`/`cancelJob`,读回状态。
- **常量**:`IYF_HOSTS` 镜像域名数组;iyf 流地址域名匹配规则(dudupro.com / pipecdn.vip 等,用于 m3u8 配对)。

## 7. 错误处理与生命周期

- **集级重试**:切集失败或该集下载最终失败 → 重试至多 N 次 → 仍败标 `失败`,任务继续。
- **补下**:任务结束后 popup 列出失败集,可一键对失败集重发一个新 DownloadJob。
- **取消**:置停止标志 → 不再切下一集;已在后台下载的集可选择让其下完(实现从简)。
- **过期兜底**:背压保证取到即下;若某集下载报防盗链/过期错误,归入集级重试(重试会重新切集取新地址)。
- **popup 关闭**:任务与状态在 background,继续运行;popup 重开读回状态。

## 8. 进入实现前待实测的 fact

1. 程序化切集的可靠方式:点 DOM 分集按钮 vs 改 `?key=` URL,哪个能触发 Angular 路由并让 hls.js 重发 m3u8。
2. 分集按钮 DOM 选择器;集数多时是否懒加载/分页(决定决策2是否需退 API)。
3. master playlist 结构 + 切档机制(决定决策7画质怎么实现)。
4. 切集后画质是否保持(不保持则每集需重设画质)。
5. 剧名清洗正则(从标题剥离集号与"-免费在线观看-爱壹帆"尾巴)。
6. 切集与新 m3u8 请求的配对判定(时间窗/流域名白名单)是否可靠区分"当前集"的流。

## 9. 测试策略

- 领域逻辑(背压推进、集级重试计数、失败集收集、区间选集展开)抽成不依赖 Chrome API 的纯函数,配 `assert` 自检。
- 端到端:真实浏览器对一部短剧(3–5 集)全流程跑通,验证落盘文件数、命名、无弹框。

## 10. 超出本版范围

单集下载(用猫抓原生);非 iyf 站点多集;暂停/续跑;实时单集百分比聚合;并行流水线之外的画质/字幕/多音轨处理。

## 11. 实测结果(2026-08-31 第二轮浏览器探查)

对样本页抓到三个 API 的真实响应体,若干 §8 fact 有结果,并牵出对决策 1、7 的**待重新确认项**。

### 已验证
- **分集列表(fact 2)**:`GET /v3/video/languagesplaylist` 响应 `data.info[0].playList` 直接给出全剧分集数组(样本 33 集),每项 `{id, key, name:"01"}`。→ **API 拿列表干净可靠,建议直接作首选**,而非"DOM 为主、拿不全再退 API"。本轮 headless 下 DOM 分集点击未命中(选择器未定位准),更佐证优先用 API。
- **剧名清洗(fact 5)**:页面标题格式为 `<剧名>-<NN>-免费在线观看-爱壹帆`(样本 `这一秒过火-01-免费在线观看-爱壹帆`)。剥离正则:`/-\d+-免费在线观看-爱壹帆$/`。
- **画质档结构(fact 3)**:`GET /v3/video/play` 响应 `data.info[0].clarity[]` 是画质档数组,每档 `{bitrate, title:"1080", description:"蓝光", isVIP, isEnabled, path}`。切档不靠 master playlist,靠这个档位数组(实测未抓到 MASTER,只有 MEDIA level m3u8)。
- **每集流地址来源**:`video/play` 响应 `clarity[<可用档>].path.result` 与 `flvPathList[]` 直接含该集 m3u8(HLS)/mpd(DASH)/mp4 地址。

### 新发现的硬约束(冲击决策 7)
- 样本(未登录会话)下,`clarity` 四档中 **720/1080/4K 全部 `isVIP:true` 且 `isEnabled:false`、`path:null`**——非 VIP 取不到高画质流;**只有 576(标清)`isEnabled:true` 且有 `path`**。
- 含义:能下哪些画质**取决于用户自己的登录/VIP 态**。决策 7"popup 统一选画质"应改为:画质下拉**动态按 `clarity` 里 `isEnabled && path!=null` 的档展示**;未登录只有 576。

### 牵出的待重新确认项(冲击决策 1)
- `video/play` 响应直接返回每集 m3u8,意味着**逐集调 `video/play?id=<episodeKey>` 即可拿地址,理论上无需"真播放切集"**。这提高了原问题 1 选项 B(页面内调 API)的吸引力:更快(不必等每集加载播放)。
- **但**关键 fact 仍未验证:能否在页面上下文里复用页面运行时生成的 `vv/pub` 签名去发起 `video/play` 请求。这是 A(真播放切集,稳)vs B(页面调 API,快)的决胜点,**留待用户重新拍板决策 1 后再定是否验证**。

### 仍未验证(取决于决策 1 走向)
- fact 1/4/6(程序化切集方式、切集后画质是否保持、切集与新 m3u8 的配对)——仅当保留 A 方案时才需要;若转 B 方案则大部分作废。

## 12. 路线修正:签名逆向重写(2026-08-31 端到端实测 + 面谈拍板)

§3–§7 的方案(真播放切集 + webRequest 嗅探)经 T5 真实浏览器端到端实测被否决,改走本节方案。**本节取代 §3–§7 中与之冲突的部分**;背压/重试/补下/命名/UI/域名家族等决策(§3 #3–#10)不受影响,继续有效。

### 12.1 为何废弃 B 方案(实测证据)
两道站点签名墙,均需运行时 `vv`/`pub` 签名(A/B 对照实证):
- **API 墙**:`languagesplaylist`/`video/play` 裸调(不带 vv/pub)→ `{"code":1,"msg":"用户签名错误"}`;带签名 → `code:0`。**证伪 §2「video/play 裸调即返回 m3u8」前提。**
- **分段墙**:每个 `.ts` 也需 vv/pub。带签名 → `200/533732 bytes`,去签名 → CDN reset。原方案靠 `openParser` 重新 fetch 下载,重发的请求**不带签名**,故卡在 `0/215` 段。

### 12.2 逆向结论(只读侦察,md5 精确匹配实证)
- `vv = md5(publicKey + "&" + 归一化query + "&" + privateKey[0])`;`pub = publicKey`(明文回填,服务器据此选私钥验签)。
- **归一化**:去掉 vv/pub 两参 → 每个值 `decodeURIComponent` 且 `+`→空格 → 保持原参数顺序 → 整串 `toLowerCase`;URL path 不参与,只签 query。
- **密钥对来源**:play 页服务器返回的 HTML 内联 JSON `"pConfig":{"publicKey":"...","privateKey":[...]}`,每次页面加载换一对。扩展 `fetch(location.href)` 正则读一次即可。
- **CDN 段批量复用一个签名**:chunklist.m3u8 签一次,每个 `media_N.ts` 照抄同一份 `&vv=&pub=` 后缀(实测 ts 共用同一 vv)。
- 站点签名器是 Angular DI 服务、闭包私有不挂 window → **形态 B(MAIN world 直接调站点函数)不可行**;**形态 A(md5 独立重写)可行、难度低**(无 wasm/无动态密钥)。

### 12.3 新决策(面谈 2026-08-31 拍板)
| # | 决策点 | 定论 | 理由 |
|---|---|---|---|
| 1' | 取流策略(重拍决策1) | **签名逆向重写**:自算 vv/pub 直接调 API 取流,不真播放、不嗅探 | 逆向已实证难度低;真播放慢且切集机制未验证 |
| 11 | 真播放方案去留 | **彻底弃**,不留 fallback | 养两套取流架构不划算(YAGNI);失效靠 §12.3-#13 探针暴露 |
| 12 | 站点 fallback(pub=Date.now()+硬编码私钥) | **不实现**,拿不到 pConfig 直接报错 | 那是页面为自身竞态设计,主动取数用不上;硬编码数组同样会随站点变 |
| 13 | 失效检测 | **启动前签名探针**:发一次已签 `video/play`,`code:1` 即判「签名规则已变」并中止任务 | 失败信号明确,不逐集失败误导排查 |
| 14 | ts 加签名后缀 | **复用 m3u8.js 现成 `tsAddArg`**(`openParser(data,{tsAddArg:"vv=..&pub=.."})`),零核心改动 | 该机制语义正是「给每个 ts 拼同一份 query」,与批量复用签名完美吻合 |

### 12.4 新数据流
```
[popup 面板] ─ startJob ─▶ [background 编排器]
                            1. 注入 MAIN world:fetch(location.href) 读 pConfig{pub,priv}(每会话一次)
                            2. 签名探针:签一个 video/play 探 → code:1 则报「签名规则已变」中止
                            循环(受背压,默认3):
                              3. 对 video/play?id=<集key> 签名 → 注入 MAIN world fetch → clarity
                              4. pickQuality 选档 → 得该集 m3u8 URL
                              5. 对 m3u8 URL 的 query 签名 → 得 vv/pub
                              6. openParser(签好的 m3u8, {autoDown,autoClose,filename,
                                            tsAddArg:"vv=<v>&pub=<p>"})
                                   └▶ [m3u8.html] hls.js 拉 playlist → 每个 ts 拼 tsAddArg → fetch 下载 → 合并落盘
```
- **签名计算在 background 侧纯函数**(可 TDD、复用侦察测试向量);**读 pConfig 与 API fetch 在 MAIN world**(页面已过 Cloudflare、同源;background 直接 fetch 播放页有被 CF 挑战挡住的风险)。

### 12.5 组件划分(增量)
**新写**
- `js/iyf-sign.js`:md5(自带 blueimp 实现,仓库与 MV3 SubtleCrypto 均无 md5)+ query 归一化 + `sign()` + node 自检(侦察 md5 向量)。UMD,不依赖 chrome。
**改**
- `js/iyf-api.js`:取数前经 MAIN world 读 pConfig;给 `languagesplaylist`/`video/play` URL 加签名。
- `js/iyf-orchestrator.js`:加启动探针;拿到 m3u8 后签名并作 `tsAddArg` 传给 openParser。
- `js/background.js`:importScripts 追加 `iyf-sign.js`。
**不碰**:`m3u8.js`/`function.js`/popup 下载与嗅探核心(切集控制脚本 §6「新写」不再需要)。

### 12.6 实现坑(实测确认项,非决策)
- `tsAddArg` 在 m3u8.js 侧被 decode 两次、`openParser` 只 encode 一次;且 `pub` 为 base64-ish 可能含 `+`(在 query 里会被当空格)。→ **对 vv/pub 值 `encodeURIComponent` 再拼 tsAddArg**,端到端确认。
- master vs media 多层 m3u8 是否都需签名 → 端到端确认(样本 576 档实测为 MEDIA level,无 master)。

## 13. 方案2:自写精简下载页(2026-08-31 拍板)

§12 的「签 m3u8 + `tsAddArg` 喂 openParser」下载通道被端到端实测否决,**本节取代 §12.3-#14、§12.4 第 6 步与 §12.6 第一条**;签名逆向(§12.2)、探针(§12.3-#13)、取数层(§12.5 的 iyf-sign/iyf-api)不受影响,继续有效。

### 13.1 为何弃 openParser/m3u8.js 通道(实测证据,42c57ba 裁决)
- **CDN 回填**:带 vv/pub 请求 chunklist,返回体里每个 ts 绝对 URL 已自带完整签名(vendtime/vhash/vv/pub)。→ ts **不需要**再拼参数。
- **tsAddArg 反而致死**:它用 `RegExp("([^?]*)")` 截掉 ts 原有 query 再拼 vv/pub,把 vendtime/vhash 冲掉 → CDN reset → 卡 `0/215`(T5 真因)。
- 只签 chunklist 走 m3u8.js 虽在过渡版(forceLocal)跑通,但要改猫抓核心 3 行且完成信号只能靠 tab 关闭猜(flake)。→ 自写下载页,m3u8.js 恢复零改动。

### 13.2 数据流(替换 §12.4 第 6 步起)
```
6. 对 chunklist URL 的 query 签名(只签这一次,不动 ts)
7. iyfOpenDownloader:tabs.create 打开 iyf-dl.html?url=<签好chunklist>&filename=<剧名/剧名-第NN集.mp4>
     └▶ [iyf-dl.html 普通 tab] fetch chunklist → 白名单 parser 抽 ts URL(原样,自带签名)
        → 最小并发器(6 线程,单片重试 3)fetch 全部 ts → mux.js Transmuxer TS→MP4 remux
        → chrome.downloads.download(saveAs:false) 落盘,等 onChanged state=complete
        → sendMessage(iyfEpisodeDone/Failed) → window.close
```

### 13.3 完成信号协议(根治 tab-close flake)
- 下载页**主动消息**报结果;background 转 orchestrator 结算。
- **幂等锚 = `iyfParserTabs`(tabId→集索引)**:tabs.create 回调直接记 id(不再 onCreated 猜);每 tab 只结算一次——消息按 `sender.tab.id` 查 map,不在 map 即丢弃,集索引取 map 值不信消息字段。
- `tabs.onRemoved` 降级为兜底:tab 意外关闭(崩溃/手动关)且未收到消息 → 判该集失败(走集级重试)。
- 下载页等 `downloads.onChanged state=complete` 才报/关:blob URL 属于页面,写盘未完就 close 会掐断下载(m3u8.js:912 同款时机)。

### 13.4 组件(增量)
**新写**:`iyf-dl.html` + `js/iyf-dl.js`(chunklist 白名单 parser + 最小并发器 + mux.js remux + 完成信号;parser 纯函数带 node 自检)。
**改**:`js/iyf-orchestrator.js`(openParser→iyfOpenDownloader、消息结算、onRemoved 兜底)、`js/background.js`(+iyfEpisodeDone/Failed 两消息)。
**恢复不碰**:`m3u8.js`(42c57ba 的 forceLocal 过渡 3 行已撤销)。

### 13.5 安全护栏与已知上限
- chunklist parser 只认 6 个标准 tag 白名单;见 `EXT-X-KEY`/`EXT-X-MAP`/`EXT-X-BYTERANGE`/master/未知 tag → 明确报错,绝不静默产坏文件。
- 整集 ts+mp4 驻内存(样本集 ~110MB,峰值约 2 倍);m3u8.js 有 1.8G 上限经验值,超长片有内存风险 → 真遇到再做流式落盘(代码内有 ponytail 注)。
- **站点访问频率风控(端到端实测暴露)**:短时间对同一账号/IP 连发多个 `video/play` 取数会触发 iyf「访问过量」风控(播放页重定向 `iyf.tv/challenge?...triggerindex=访问过量`,取数返回 `empty clarity`);批量整剧一次性并发取数(iyfPump 同时放行 N 集→N 个 video/play 并发)易撞。风控在**取数阶段**,下载走 CDN 不受影响。→ 缓解候选(待拍板):集间取数节流 / 降默认并发 / 撞风控时退避重试。当前版本未实现节流(YAGNI,待用户确认需要)。

### 13.6 验收(=impl-plan T11)
样本剧前 3 集:本地落盘 mp4、ffprobe H264+AAC 可播、命名 `这一秒过火/这一秒过火-第NN集.mp4` 零填充、状态机全 done(靠消息不靠 tab 关闭)、全程无 m3u8.html/ffmpeg tab、无弹框无第三方。

## 14. 真机调试三项修正(2026-09-01,用户登录态实测)

用户提供登录态调试窗口后连跑端到端,暴露并修掉三个问题。**本节取代 §13.2 的第 7 步、§13.3 全部、§13.5 的风控条目。**

### 14.1 登录凭证:「访问过量」的真因(推翻 §13.5 的风控归因)
- §13.5 把 `video/play` 返回 `{"data":{"code":5,"msg":"访问过量"}}` 归因为**频率风控**,**这是错的**。
- **决定性对照(同一时刻、同一接口)**:带账号凭证 → 回「用户签名错误」;只带 vv/pub(游客签名) → 回「访问过量」。
  它是「拿游客签名要登录内容」的**拒绝话术**,与调用频率无关。
- 站点自己调 `video/play` 是**两套签名一起带**:`uid/expire/gid/sign/token`(账号)+ `vv/pub`(游客)。
- 账号凭证来源:**cookie `dn_temp` 里的 `__t` JSON**。
- **`vv` 必须对「已含账号参数的完整 query」算 md5** —— 先拼账号参数,再签名,顺序反了必错。
- `region` 可省;`lang=none` 站点没有,已去掉。
- 实现:`js/iyf-api.js` 的 `iyfMainReadAuth`/`iyfGetAuth`/`iyfResetAuth`/`iyfAuthQuery`。
- 取数节流(`IYF_FETCH_GAP_MS = 3000`)保留——不为规避风控,只为不给站点打并发峰值。

### 14.2 下载改走 offscreen 单例文档(取代 §13.2 第 7 步、§13.3)
- 用户反馈「不要弹出新的下载窗口」。改用 **MV3 offscreen document**(`chrome.offscreen`,`reasons:['BLOBS']`),不占标签栏。
- offscreen 是**单例**:多集并行都跑在同一个文档里,靠**集索引**区分,不再有 tabId。
- **offscreen 拿不到 `chrome.downloads`** → 转封装完把 blob URL 交 background 落盘,
  等 `downloads.onChanged state=complete` 再判完成,然后通知 offscreen `revoke`。
- 幂等锚从 `iyfParserTabs`(tabId→索引)换成**集索引 + `iyfSettled`**:已 done/failed 的集再来消息一律丢弃。
- job 收尾自动 `chrome.offscreen.closeDocument()`;manifest 加 `"offscreen"` 权限。
- 面板显示切片级实时进度(download/remux/save 三阶段)。

### 14.3 转封装换 hls.js:支持 4K(H.265/HEVC)
- 各档编码(ffprobe 实拉切片):`576/720/1080 = h264`,**`2160 = hevc 3840x2160`**。与是否 VIP 无关。
- **mux.js 只支持 H.264+AAC**,喂 HEVC 会静默只吐音频轨 → 产出纯音频坏文件(旧 bug 现象)。
- 选型:`mp4box.js` 是 MP4 容器工具**读不了 MPEG-TS**(要自写 HEVC TS demuxer,否决);
  `ffmpeg.wasm` 可行但 core ~30MB + 需 CSP 加 `'wasm-unsafe-eval'`;
  **最终走自建 hls.js bundle** —— hls.js 1.6 的 TSDemuxer 原生认 M2TS stream_type `0x24`(HEVC),
  只抽 TSDemuxer+MP4Remuxer+mp4-generator 打包仅 **60KB**,无 wasm、无 CSP 改动。
  见 `lib/hls-transmux.min.js`、`tools/hls-transmux-entry.js`、`tools/build-hls-transmux.sh`。
- **两处必须自己处理**(hls.js 是为 MSE 写的,不是为落盘写的):
  1. **合轨**:hls.js 音视频分产两条 fMP4(对应两个 SourceBuffer)。用 `MP4.initSegment([videoTrack, audioTrack])`
     生成含双 trak 的 moov(该 API 本就收数组,官方只是分别传单元素),再把两轨 moof+mdat 依序拼接 → 单文件。
  2. **时间轴归零**:moof 的 tfdt 写的是 TS **绝对 PTS**,MSE 靠 `SourceBuffer.timestampOffset` 对齐,
     离线文件没这一层。实测某流 PTS 起点在 2^33 边界(≈95443 秒),不改就成一个 26 小时长的视频。
     → 拼装时把每个 tfdt 减去基准;音视频用**同一时间基准**(各按自己 timescale 换算),保留原有音画相对偏移。
- 整集总时长(m3u8 的 EXTINF 累加)传给 `createRemuxer(duration)` 写进 moov,播放器才能显示时长、拖进度条。
  mux.js 时代的 `fixFileDuration` 已删——它按 version-0 的 32 位 box 布局写死偏移,而 hls.js 的 mvhd 是 version 1(64 位)。
- 各档一视同仁,默认取 bitrate 最高档(=2160)。`IYF_HEVC_TITLES` 规避名单与面板的 `[H.265 暂不支持]` 标注同步删除。
