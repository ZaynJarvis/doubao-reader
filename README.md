# Doubao Reader

一个把网页读给你听的 Chrome 扩展。用豆包语音合成大模型（seed-tts-2.0）朗读网页正文或选中文字，配一个可拖动的极简悬浮播放器。产品形态受 Speechify 启发。

<a href="https://buymeacoffee.com/zaynjarvis"><img src="icons/bmc-button.png" alt="Buy me a coffee" height="44"></a>

## 功能

- 点击工具栏图标显示播放器，再点隐藏；hover 展开上/下一段、语速、设置、停止
- 自动提取网页正文，排除导航、侧栏、页脚和代码块；也可右键朗读选中文字
- 当前段落和逐词高亮，自动滚动跟读
- 0.75× 到 2× 语速，显示预估剩余分钟数
- 预置 6 个豆包音色，也可填任意音色 ID
- 快捷键 `Alt+Shift+Space` 播放 / 暂停
- 设置页跟随系统深浅色

## 安装

Chrome Web Store 版本审核中。目前手动安装：

```bash
git clone https://github.com/ZaynJarvis/doubao-reader.git
```

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 「加载已解压的扩展程序」，选择克隆下来的目录。
3. 设置页填写豆包语音 API Key，选择音色和语速，保存。
4. 打开任意网页，点工具栏图标，再点播放。

## API Key

在[豆包语音控制台](https://console.volcengine.com/speech/new/setting/apikeys?projectName=default)创建 API Key，音色 ID 在[音色库](https://console.volcengine.com/speech/new/voices?projectName=default)获取。注意火山方舟 LLM 的 `ark-...` Key 不能用于语音接口。

Key 只存在本机 `chrome.storage.local`，只发往 `openspeech.bytedance.com`。详见 [PRIVACY.md](PRIVACY.md)。

## 开发

```bash
npm install
npm test
```

无构建步骤，改完代码在 `chrome://extensions` 点「重新加载」即可。打包上架：

```bash
zip -r doubao-reader.zip manifest.json icons src -x '*.DS_Store'
```
