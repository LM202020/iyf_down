# iyf.tv 连续剧多集自动下载模块 — 设计文档

- 日期:2026-08-31
- 项目:Chrome_iyv_plug(fork 自 xifangczy/cat-catch,Chrome MV3,自用不分发)
- 状态:设计定稿,待实测补齐若干 fact 后进入实现
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
