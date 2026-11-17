# 小克音量均衡器 · Claude-Volume-Leveler

<img src="icon.png" width="128" align="right" alt="icon">

[EchoMusic](https://github.com/hoowhoami/EchoMusic) 插件：现在小克会帮你实时调歌曲音量啦~再也不用担心一会儿听不见一会儿伤耳朵喽
与[小克音乐下载器](https://github.com/LW-Arqiu1shz/Claude-Music-Downloader)一起用还可以下载均衡版音乐哦！

## 功能

- 按 BS.1770 / LUFS 实时测量响度，把音量保持在你设定的范围里（预设：温和 / 标准 / 夜间·戴耳机，也可以自己调范围和反应速度）
- **柔和压缩**：超出范围的部分只拉回一部分，带软拐点，大声的地方依然比安静的地方响，只是没那么猛；突然特别响时 0.4 秒内压住护耳
- **预听**（可关）：每首歌开始 4 秒后在后台下载并分析整首歌，提前 1～2 秒轻轻调音量，副歌进来时已经刚好
  - 网太慢（25 秒没下完）或播放卡顿时立刻放弃，这首歌放完前只用实时模式
  - 本地文件、下载失败、预听结果和实际播放对不上时，也自动用实时模式
- 淡入的前奏、淡出的尾巴不会被抬起来
- 兼容 EchoMusic 的所有换歌模式（关闭 / 无缝 / 淡入淡出 / 自然衔接 / 节奏融合），新歌开头立刻接上
- 实时监视页：滚动画出原始响度和调整后响度（播放栏小天平、标题栏「更多应用」都能打开）
- 和 EchoMusic 自带的「音量均衡」共存，不会去改它的设置
- 配合小克音乐下载器：下载「音量均衡版」FLAC，用的是同一套算法

## 安装

要求 EchoMusic ≥ 2.3.2。

1. 到 [Releases](https://github.com/LW-Arqiu1shz/Claude-Volume-Leveler/releases/latest) 下载 `Claude-Volume-Leveler-版本号.zip`，解压到 `%APPDATA%\echo-music\plugins\`，得到 `plugins\Claude-Volume-Leveler\` 文件夹（里面直接就是 `manifest.json`）
2. 重启 EchoMusic，在插件管理里启用
3. 插件会申请两项权限：
   - **音频频谱**：实时测量响度
   - **原生网络**：预听时下载正在播放的歌（只下当前这首，不会上传任何东西）。不想给的话可以在设置里关掉「预听整首歌」

## 作者

- **Arqiu-owo**
- **Claude**（Anthropic）

## 许可证

- 代码：[LGPL-3.0](LICENSE)
- 图标 `icon.png`：CC BY-NC-SA 4.0
