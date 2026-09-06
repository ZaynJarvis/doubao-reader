# Doubao Reader

一个 clean-room 的 Chrome Manifest V3 网页朗读扩展：提取正文或朗读选区，用豆包语音合成大模型生成音频，并通过固定悬浮播放器控制播放。

## 先说清楚 API Key

这个版本使用豆包语音官方的 HTTP V3 接口：

- `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`
- `X-Api-Key: <豆包语音 API Key>`
- `X-Api-Resource-Id: seed-tts-2.0`

Key 应从[豆包语音控制台的 API Key 管理](https://console.volcengine.com/speech/new/setting/apikeys?projectName=default)创建。普通火山方舟 LLM 的 `ark-...` API Key 没有被官方文档声明可用于这个接口，不能把两者当成同一个凭证。

官方依据：[单向流式语音合成 HTTP](https://docs.volcengine.com/docs/6561/2528925?lang=zh)和[豆包语音 API Key 使用](https://docs.volcengine.com/docs/6561/1816214?lang=zh)。

## 当前能力

- 点击扩展工具栏图标后才显示页面右上方的极简深色播放器；再次点击可隐藏，hover 或键盘 focus 时展开跳段、语速、设置与停止
- 优先朗读当前选区（包括开放 Shadow DOM 内的选区），否则对全页可见文本块做正文评分
- 支持以 `div` / `span` 渲染正文的文档站和 SPA，不依赖页面必须有 `article` / `main`
- 排除导航、侧栏、账号弹层、操作栏、页脚和块级代码，并对嵌套块、重复段落及表格行去重
- 每次播放都重新提取当前 DOM；首段在自然块边界控制到约 140 字以内，后续合并到不超过 280 字并提前合成下一段
- 播放、暂停、停止、上/下一段与 0.75–2× 语速，并显示预估剩余分钟数（当前段开始后使用真实音频时长修正）；拖动时间标签可移动播放器
- 设置页预置 6 个豆包音色，也可填写任意音色 ID
- `seed-tts-2.0` 请求官方字幕时间戳，用 CSS Custom Highlight 做当前段及逐词跟读；字幕缺失时退回整段高亮，离开视口时自动滚动
- 右键菜单「用豆包朗读选中文字」
- 快捷键 `Alt+Shift+Space`
- 音频在 offscreen document 中播放，不受网页播放器和 CSS 干扰

## 安装

### 方式一：加载已解压的扩展（开发者）

```bash
git clone <本仓库地址> doubao-reader
```

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择克隆下来的目录。
3. 安装后会自动打开设置页。填写豆包语音 API Key、选择音色和语速，保存。
4. 打开或刷新任意 `http(s)` 网页，点击工具栏中的扩展图标显示播放器，再点播放。

改动代码后，在 `chrome://extensions` 对该扩展点「重新加载」，并刷新测试网页。

### 方式二：打包 zip 安装

```bash
zip -r doubao-reader.zip manifest.json icons src -x '*.DS_Store'
```

把 zip 解压后按方式一加载，或直接拖入 `chrome://extensions` 页面。

### 上架 Chrome Web Store

目前没有上架，因为发布需要 Google 开发者账号（一次性 5 美元）并通过人工审核。上架步骤：

1. 用上面的命令打包 zip。
2. 到 [Chrome Web Store 开发者控制台](https://chrome.google.com/webstore/devconsole) 注册账号并上传 zip。
3. 填写商店描述、截图和隐私声明（本扩展只请求 `openspeech.bytedance.com`，Key 仅存本地）。
4. 提交审核，通过后用户可直接从商店安装。

## 凭证边界

- Key 仅写入 `chrome.storage.local`；后台会把 storage 访问级别限制为 `TRUSTED_CONTEXTS`，content script 不读取 Key。
- 网络请求只由 extension service worker 发往 `openspeech.bytedance.com`。
- 设置页不会回显已保存的 Key，也不会在日志或错误信息里输出 Key。
- 这是纯客户端扩展。拥有该 Chrome profile 或调试扩展权限的人仍可能取得凭证；若要分发给不受信设备，应改成自己的后端签发短期令牌，不能把长期 Key 当成客户端秘密。

## 本地验证

无需构建步骤：

```bash
npm install
npm test
node --check src/background.js
node --check src/extractor.js
node --check src/content.js
node --check src/offscreen.js
node --check src/options.js
```

提取回归使用本地 HTML fixture，覆盖 DIV 文档正文、导航污染、嵌套重复、表格、隐藏内容、块级代码、开放 Shadow DOM 和 SPA DOM 更新。`linkedom` 只用于开发测试，不会被扩展运行时加载。

没有可用的真实豆包语音 Key 时，协议测试只验证响应帧解析与 base64 音频拼接；真实鉴权、计费、音色权限和播放链路须通过网页朗读验证。

## 正文提取边界

提取器从可见文本节点出发，把内联节点折叠到最小完整块，再按正文覆盖率、链接密度、语义标签和容器命名给候选正文区域评分。文章标题会优先取 `h1`，其次使用页面 metadata / 浏览器标题。它不会缓存解析结果，因此同 URL 下的 SPA 内容更新会在下一次播放时生效。

Mozilla Readability 适合传统长文章，但它解析的是克隆文档并返回一份脱离原页面的 HTML；对本项目主要故障形态（DIV 文档编辑器、原 DOM 高亮、表格与开放 Shadow DOM）不能单独闭环，因此当前没有把它作为运行时依赖。此处使用的是可测试的本地 DOM 提取器，没有外部 CDN 或动态代码。

## 与本机 Speechify 的关系

本机安装的 Speechify 是约 57 MB 的生产发布包：能看到 Manifest V3、压缩 bundle、WASM/模型和静态资源，但包内没有 source map 或开源许可，因此不等于拿到了可维护的原始源码。

本项目只借鉴可观察的产品行为：固定播放器、选区优先、正文提取、分段预取、当前段高亮、跨页面播放协调。没有复制 Speechify 的 bundle、协议、品牌资源或私有服务。

## MVP 明确不做

- Chrome / Ego 内置 PDF viewer、OCR、截图识别（普通 HTML 中可访问的文本层仍可提取）
- Google Docs、Kindle 等站点专用适配器
- 点击单词跳转（逐词跟读仅使用 `seed-tts-2.0` 官方字幕时间戳）
- 登录、云端同步、声音库浏览、内容收藏
- 由后端代理和保护 API Key

这些是下一阶段能力，不影响“选中或打开网页即可连续朗读”的最小闭环。
