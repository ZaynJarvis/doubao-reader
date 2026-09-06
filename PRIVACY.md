# Doubao Reader 隐私说明 / Privacy Policy

Doubao Reader 是纯客户端 Chrome 扩展，没有自己的服务器。

- **网页内容**：当你点击播放时，当前页面的正文或选中文字会分段发送到火山引擎豆包语音接口 `https://openspeech.bytedance.com` 进行语音合成。除此之外不会发送到任何地方。
- **API Key**：你填写的豆包语音 API Key 只保存在本机 `chrome.storage.local`，仅用于向上述接口鉴权，不会被扩展作者收集。
- **其他数据**：不收集浏览历史、账号信息、位置或任何统计信息。没有埋点，没有第三方 SDK。

豆包语音服务对所发送文本的处理以[火山引擎隐私政策](https://www.volcengine.com/docs/6256/64902)为准。

---

Doubao Reader is a client-only Chrome extension with no backend of its own.

- **Website content**: when you press play, the article text (or your selection) is sent in short segments to the Doubao Speech TTS endpoint at `https://openspeech.bytedance.com` to be synthesized. It is not sent anywhere else.
- **API key**: your Doubao Speech API key is stored only in `chrome.storage.local` on your device and used solely to authenticate those requests. The extension author never receives it.
- **Nothing else**: no browsing history, account data, location or analytics are collected. No trackers, no third-party SDKs.

Handling of submitted text by the TTS service is governed by the Volcengine privacy policy.
