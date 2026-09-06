"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHTML } = require("linkedom");
const {
  extractPage,
  getSelectionText,
  segmentBlocks,
} = require("../src/extractor.js");

function documentFrom(body, title = "Fixture -- Docs") {
  const { document, window } = parseHTML(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
  return { document, window };
}

function extract(body, title) {
  const { document, window } = documentFrom(body, title);
  return extractPage(document, {
    window,
    isVisible: () => true,
    getRect: () => ({ x: 300, y: 100, width: 760, height: 40 }),
  });
}

function combinedText(result) {
  return result.blocks.map((block) => block.text).join(" ");
}

test("extracts div-rendered documentation and rejects surrounding chrome", () => {
  const result = extract(`
    <header class="top-navigation"><a>文档中心</a><a>控制台</a></header>
    <div class="account-dropdown"><div>账号信息与费用中心</div></div>
    <div class="layout">
      <div class="sidebar-menu">
        <div class="arco-menu-item">同步语音合成</div>
        <div class="arco-menu-item">单向流式语音合成 WebSocket</div>
      </div>
      <div class="contentdoc">
        <div class="title">单向流式语音合成 HTTP</div>
        <div class="copy-actions">复制全文 下载 PDF 我的收藏</div>
        <div id="doc-viewer-container">
          <div class="zone-container doceditor">
            <div class="ace-line">基于 HTTP Chunked 协议的单向流式合成接口，一次性输入文本，流式返回音频。</div>
            <div class="ace-line">POST https://openspeech.bytedance.com/api/v3/tts/unidirectional</div>
            <div class="ace-line">
              <div class="ace-line">请求头</div>
              <div class="ace-line">X-Api-Key string 必选</div>
              <div class="ace-line">API Key 可从控制台的 API Key 管理页面获取</div>
            </div>
            <div class="ace-line">
              <div class="ace-line">请求体</div>
              <div class="ace-line">text string 必选</div>
              <div class="ace-line">输入待合成的文本</div>
            </div>
          </div>
          <div class="volc-doceditor-sample-box"><pre>curl -H 'X-Api-Key: secret-placeholder'</pre></div>
        </div>
      </div>
      <aside class="table-of-contents">本文档目录 请求头 请求体</aside>
    </div>
    <footer>服务条款 联系我们</footer>
  `, "单向流式语音合成HTTP--豆包语音-火山引擎");

  const text = combinedText(result);
  assert.match(text, /单向流式语音合成HTTP/);
  assert.match(text, /基于 HTTP Chunked 协议/);
  assert.match(text, /X-Api-Key string 必选/);
  assert.match(text, /输入待合成的文本/);
  assert.doesNotMatch(text, /账号信息|同步语音合成|复制全文|secret-placeholder|服务条款/);
  assert.equal((text.match(/X-Api-Key string 必选/g) || []).length, 1);
});

test("keeps content list items but removes navigation and exact repeated blocks", () => {
  const result = extract(`
    <nav><ul><li>首页和产品导航入口</li><li>账户设置入口</li></ul></nav>
    <main>
      <h1>一篇真正的文章标题</h1>
      <p>这是足够长的正文开头，用来说明文章真正讨论的问题与上下文。</p>
      <ul><li>第一条有意义的正文结论，应该保留。</li><li>第二条有意义的正文结论，也应该保留。</li></ul>
      <p>这是足够长的正文开头，用来说明文章真正讨论的问题与上下文。</p>
    </main>
  `);
  const text = combinedText(result);
  assert.doesNotMatch(text, /产品导航|账户设置/);
  assert.match(text, /第一条有意义/);
  assert.match(text, /第二条有意义/);
  assert.equal((text.match(/这是足够长的正文开头/g) || []).length, 1);
});

test("coalesces each table row once instead of repeating parent and cells", () => {
  const result = extract(`
    <main>
      <h1>接口参数说明</h1>
      <p>下面的表格列出了接口调用所需的关键参数，供开发者配置请求。</p>
      <table>
        <tr><th>参数</th><th>类型</th><th>说明</th></tr>
        <tr><td>speaker</td><td>string</td><td>指定合成音色</td></tr>
        <tr><td>sample_rate</td><td>integer</td><td>指定采样率</td></tr>
      </table>
    </main>
  `);
  const text = combinedText(result);
  assert.equal((text.match(/speaker/g) || []).length, 1);
  assert.equal((text.match(/指定合成音色/g) || []).length, 1);
  assert.match(text, /speaker string 指定合成音色/);
});

test("skips hidden and block code while retaining inline identifiers", () => {
  const result = extract(`
    <main>
      <h1>语音调用指南</h1>
      <p>请求时请设置 <code>X-Api-Request-Id</code>，这样可以定位每次调用。</p>
      <p hidden>这是一段不应朗读的隐藏说明文字。</p>
      <div aria-hidden="true">这是一段无障碍隐藏的重复文字。</div>
      <pre>const credential = "do-not-read-code";</pre>
    </main>
  `);
  const text = combinedText(result);
  assert.match(text, /X-Api-Request-Id/);
  assert.doesNotMatch(text, /隐藏说明|无障碍隐藏|do-not-read-code/);
});

test("discovers readable text inside an open shadow root", () => {
  const { document, window } = documentFrom("<main><h1>组件化文章</h1><reader-section></reader-section></main>");
  const host = document.querySelector("reader-section");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = "<div>这段正文渲染在开放的 Shadow DOM 中，也应当被朗读。</div>";
  const result = extractPage(document, {
    window,
    isVisible: () => true,
    getRect: () => ({ x: 300, y: 100, width: 760, height: 40 }),
  });
  assert.match(combinedText(result), /开放的 Shadow DOM/);
});

test("does not cache a stale SPA document", () => {
  const { document, window } = documentFrom("<main><h1>旧页面</h1><p>旧页面里有一段足够长的正文内容。</p></main>");
  const options = { window, isVisible: () => true, getRect: () => ({ x: 0, y: 0, width: 800, height: 30 }) };
  assert.match(combinedText(extractPage(document, options)), /旧页面/);
  document.querySelector("main").innerHTML = "<h1>新页面</h1><p>路由切换之后出现的是全新正文内容。</p>";
  const updated = combinedText(extractPage(document, options));
  assert.match(updated, /新页面/);
  assert.doesNotMatch(updated, /旧页面里/);
});

test("selection lookup prefers a real non-collapsed selection, including shadow roots", () => {
  const { document, window } = documentFrom("<main>正文</main>");
  window.getSelection = () => ({ isCollapsed: false, toString: () => "  当前选中的文字  " });
  assert.equal(getSelectionText(document, window), "当前选中的文字");

  window.getSelection = () => ({ isCollapsed: true, toString: () => "" });
  const host = document.createElement("reader-section");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.getSelection = () => ({ isCollapsed: false, toString: () => "Shadow 选区" });
  document.body.append(host);
  assert.equal(getSelectionText(document, window), "Shadow 选区");
});

test("keeps the first TTS request short at a natural block boundary", () => {
  const result = extract(`
    <main>
      <h1>单向流式语音合成HTTP</h1>
      <div>基于 HTTP Chunked 协议的单向流式合成接口，一次性输入文本，流式返回音频，支持中、英、日、西等多语种及多种方言口音。</div>
      <div>POST https://openspeech.bytedance.com/api/v3/tts/unidirectional</div>
      <div>请求头</div>
      <div>X-Api-Key string 必选</div>
      <div>API Key 可从控制台的 API Key 管理页面获取</div>
      <div>X-Api-Resource-Id string 必选</div>
      <div>请求的模型版本包括豆包语音合成大模型和声音复刻大模型。</div>
      <div>X-Api-Request-Id string 必选</div>
      <div>标识客户端请求 ID，使用 UUID 随机字符串。</div>
    </main>
  `, "单向流式语音合成HTTP--豆包语音-火山引擎");
  const segments = segmentBlocks(result.blocks, {
    firstMaxLength: 140,
    maxLength: 280,
    targetLength: 120,
  });

  assert.ok(segments[0].text.length <= 140, `first segment was ${segments[0].text.length} chars`);
  assert.match(segments[0].text, /单向流式语音合成HTTP.*基于 HTTP Chunked/);
  assert.doesNotMatch(segments[0].text, /POST https:/);
  assert.ok(segments.slice(1).some((segment) => segment.nodes.length >= 3));
  assert.ok(segments.slice(1).every((segment) => segment.text.length <= 280));
});
