# 📑简介

**iyf_down** —— 面向 iyf.tv（爱壹帆）连续剧的多集自动下载浏览器扩展。

在 [xifangczy/cat-catch](https://github.com/xifangczy/cat-catch)（猫抓，Chrome MV3 资源嗅探扩展）底座上二次开发，新增 iyf.tv 整剧批量下载：popup 面板选集/选画质/看进度，逐集自动取流、下载切片、本地转封装为 mp4 落盘，无需第三方服务、无弹框。

# 📘安装方法（源码 / 已解压扩展）

1. `git clone` 本仓库。
2. 打开 Chrome 扩展管理页面（`chrome://extensions`），启用「开发者模式」。
3. 点击「加载已解压的扩展程序」，选中仓库根目录即可。

日常开发无需构建：改完代码在扩展页刷新即可。要求 Chromium 内核 93 以上（完整功能建议 104+）。

# 📖使用

在 iyf.tv 剧集播放页打开扩展 popup，面板会列出全部分集：勾选（支持全选/区间）、选画质、点下载。下载进度按集显示，可取消、可对失败集补下。文件命名为 `<剧名>/<剧名>-第NN集.mp4`。

# 🤚🏻免责

本扩展仅供下载用户拥有版权或已获授权的视频，禁止用于下载受版权保护且未经授权的内容。用户需自行承担使用本工具的全部法律责任，开发者不对用户的任何行为负责。本工具按“原样”提供，开发者不承担任何直接或间接责任。

# 🔒隐私

本扩展所有信息均在本地储存处理，不发送到远程服务器，不含任何跟踪器。

# 💖鸣谢

- [cat-catch](https://github.com/xifangczy/cat-catch)（本项目的底座）
- [hls.js](https://github.com/video-dev/hls.js)
- [jQuery](https://github.com/jquery/jquery)
- [mux.js](https://github.com/videojs/mux.js)
- [jquery.json-viewer](https://github.com/abodelot/jquery.json-viewer)
- [Momo707577045](https://github.com/Momo707577045)
- [mpd-parser](https://github.com/videojs/mpd-parser)
- [StreamSaver.js](https://github.com/jimmywarting/StreamSaver.js)
- [MQTT.js](https://github.com/mqttjs/MQTT.js)

# 📜License

GPL-3.0 license。

本项目二次开发自 [xifangczy/cat-catch](https://github.com/xifangczy/cat-catch)（GPL-3.0），依据 copyleft 条款保留原项目版权与 LICENSE，并同样以 GPL-3.0 开源。原项目 1.0 版采用 MIT、2.0 版起改为 GPL v3。
