# 本机 Speechify 静态检查

检查对象：

```text
/Users/bytedance/Library/Application Support/Citro Labs/ego lite/Profile 1/Extensions/
  ljflmlehinmoeknoonhibbjpldiijjmm/14.6.0_0
```

## 结论

Chrome 扩展安装后，客户端发布产物确实保存在本机，因此可以读取 manifest、JavaScript bundle、HTML/CSS、WASM/ONNX 和静态资源。但这里找到的是 **57 MB 的生产构建产物，不是 Speechify 的原始源码仓库**：

- Manifest 显示 `Speechify Inc`、Manifest V3、版本 `14.6.0`。
- 有 170 个 JavaScript 文件；主要 background bundle 约 2.8 MB。
- 大量 bundle 末尾引用 `*.js.map`，安装包里实际没有任何 `.map` 文件。
- 未发现 LICENSE、NOTICE 或 README 说明这些代码以开源许可发布。

所以它适合用于理解本机实际运行路径和可观察行为，不适合复制压缩 bundle 或据此宣称拿到了“source code”。

## 可复核入口

| 位置 | 证据 |
| --- | --- |
| `manifest.json:11` | background service worker 是 `background/main.js` |
| `manifest.json:53` | content script 覆盖 `<all_urls>`，分别在 `document_start` / `document_idle` 运行 |
| `manifest.json:83` | 使用 offscreen、tabCapture、contextMenus、storage、scripting、sidePanel 等权限 |
| `manifest.json:84` | 有独立 side panel 页面 |
| `content-wrapper.js:1` | 动态加载 `content/main.js` |
| `offscreen/offscreen.html:4` | 加载 `offscreen/src/main.js` |

## 可借鉴的行为，不复制实现

静态 bundle 中可以确认以下产品形态：

- 点击工具栏后向当前 tab 路由 `/browser-action`；存在选区时优先播放。
- content 负责页面内容提取；默认不是只查 `p/li`，而是从全页文本节点建立 text block，再处理可见性、链接密度、语义容器、页面位置与字符阈值。
- 普通解析区分原生可见性、viewport 可见性、开放 Shadow Root、代码块与缓存失效；动态页面可强制 fresh parse。
- 另有 spatial / hybrid readability 路径：先聚类带 DOM rect 的可读节点，再把判定结果与普通解析结果合并。发布包还包含 offscreen 侧的本地可读性模型；模型协议和实现属于 Speechify 私有边界，本项目没有复制。
- 语音按片段请求并预取；speech marks 用于单词/句子高亮。
- 固定播放器、selection / sentence / paragraph 高亮、自动滚动、播放速度、跳句等能力按功能拆分。
- offscreen document 负责后台音频播放；新 tab 播放会暂停旧 tab，保持全局单实例。
- PDF、OCR/截图、Google Docs/Kindle 等都有专门路径，明显超出 TTS MVP。

本仓库采用 clean-room 边界：只复刻浮动播放器、选区/正文提取、短段队列与预取、当前段高亮、offscreen 播放和跨 tab 打断；不复制 Speechify 的代码、协议、模型、品牌资源或私有 API。

## 本次提取故障与修复

真实复现页：`https://docs.volcengine.com/docs/6561/2528925?lang=zh`。

| 指标 | 旧提取器 | 0.2.0 提取器 |
| --- | ---: | ---: |
| 页面语义根 | 无 `article/main/[role=main]`，回落 BODY | 从可见文本块给正文容器评分 |
| 抽到的内容 | 20 个 `li`，约 772 字 | 163 个原始块、约 3721 字 |
| 发给 TTS 的队列 | 从 `seed-tts-2.0...` 开始 | 21 段，首段 77 字，为标题和接口描述 |
| 导航 / 账号 / 操作栏 | 会混入或正文漏失 | 实页检查均未混入 |
| 嵌套重复 | 父子块可能重复 | 每个文本节点只归属一个最小块，并做长文本去重 |

根因是旧代码把正文等同于 `h1/h2/h3/p/li/blockquote`。火山文档正文主要由 `.ace-line` DIV 和内联 SPAN 渲染；残留的少量 LI 让 fallback 误判为“提取成功”，所以正文反而被跳过。

0.2.0 的实现只借鉴上面的行为策略：遍历本地 DOM 文本节点、折叠内联节点、过滤不可见或非正文区域、评分正文容器、按文档顺序去重与分段。代码是独立实现，并有本仓库 fixture 回归；没有移植 Speechify bundle、模型权重或消息协议。

## 豆包语音资源从哪获取

| 需要 | 入口 |
| --- | --- |
| API Key | [控制台 API Key 管理](https://console.volcengine.com/speech/new/setting/apikeys?projectName=default)，创建后填到扩展设置页 |
| 音色 ID | [控制台音色库](https://console.volcengine.com/speech/new/voices?projectName=default)，复制音色 ID（如 `zh_female_gujie_uranus_bigtts`）；扩展设置页已预置 6 个 |
| 接口文档 | [单向流式语音合成 HTTP](https://docs.volcengine.com/docs/6561/2528925?lang=zh)，Resource ID 固定为 `seed-tts-2.0` |
| 服务开通 | 控制台需先开通「豆包语音合成大模型」并确认音色已授权，否则请求会返回权限错误 |

音色不需要下载：它们是云端模型，扩展只按 ID 发请求，音频以流式返回。
