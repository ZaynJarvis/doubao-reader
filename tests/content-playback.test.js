"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { parseHTML } = require("linkedom");

const CONTENT_SOURCE = fs.readFileSync(require.resolve("../src/content.js"), "utf8");

function createHarness({ deferredSynthesis = false, page = null } = {}) {
  const { window } = parseHTML(page || "<!doctype html><html><body><main>fixture</main></body></html>");
  Object.defineProperty(window, "top", { value: window, configurable: true });
  window.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  window.document.createRange = () => ({
    selectNodeContents() {}, setStart() {}, setEnd() {},
    getBoundingClientRect: () => ({ top: 100, bottom: 200, height: 100 }),
  });
  window.getSelection = () => ({ toString: () => "" });
  window.HTMLElement.prototype.scrollIntoView = () => {};

  const playCalls = [];
  const commandCalls = [];
  const synthesisCalls = [];
  let shadow;
  let listener;
  let offscreenActive = false;
  let resolveSynthesis;
  const synthesisGate = deferredSynthesis
    ? new Promise((resolve) => { resolveSynthesis = resolve; })
    : null;
  const attachShadow = window.HTMLElement.prototype.attachShadow;
  window.HTMLElement.prototype.attachShadow = function captureShadow(options) {
    shadow = attachShadow.call(this, options);
    return shadow;
  };

  const chrome = {
    runtime: {
      onMessage: {
        addListener(callback) {
          listener = callback;
        },
      },
      async sendMessage(message) {
        if (message.type === "GET_SAFE_SETTINGS") {
          return { ok: true, settings: { configured: true, rate: 1 } };
        }
        if (message.type === "SYNTHESIZE") {
          synthesisCalls.push({ ...message });
          if (synthesisGate) {
            await synthesisGate;
          }
          return { ok: true, audioBase64: "YQ==", mimeType: "audio/mpeg", wordTimings: [] };
        }
        if (message.type === "PLAY_AUDIO") {
          offscreenActive = true;
          playCalls.push({ ...message });
          return { ok: true };
        }
        if (message.type === "PLAYBACK_COMMAND") {
          commandCalls.push({ ...message });
          if (message.command === "stop") {
            offscreenActive = false;
            return { ok: true };
          }
          if (!offscreenActive) {
            return { ok: false, error: "MISSING_PLAYBACK" };
          }
          return { ok: true };
        }
        return { ok: true };
      },
    },
  };

  const context = vm.createContext({
    CSS: page ? undefined : { highlights: new Map() },
    Highlight: class Highlight {},
    HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver,
    Node: window.Node,
    NodeFilter: { SHOW_TEXT: 4 },
    chrome,
    clearTimeout,
    console,
    crypto: webcrypto,
    document: window.document,
    performance: window.performance,
    setTimeout,
    window,
  });
  context.globalThis = context;
  context.DoubaoPageExtractor = page ? require("../src/extractor.js") : {
    extractPage: () => ({ title: "fixture", blocks: [] }),
    getSelectionText: () => "",
    segmentBlocks: () => [],
    splitLongText: () => ["first segment", "second segment"],
  };
  vm.runInContext(CONTENT_SOURCE, context);

  return {
    document: window.document,
    time: () => shadow.querySelector(".time").textContent,
    status: () => shadow.querySelector(".sr-status").textContent,
    stop: () => shadow.querySelector('[data-action="stop"]').click(),
    commandCalls,
    emit: (message) => listener(message),
    playCalls,
    resolveSynthesis: () => resolveSynthesis?.(),
    playButton: () => shadow.querySelector('[data-action="play"]'),
    synthesisCalls,
  };
}

async function flushUntil(predicate, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "condition did not become true");
}

test("pause intent survives an ended event already queued for the current segment", async () => {
  const harness = createHarness();
  harness.emit({ type: "READ_SELECTION", text: "anything" });
  await flushUntil(() => harness.playCalls.length === 1);

  const first = harness.playCalls[0];
  harness.emit({ type: "TOGGLE_PLAYBACK" });
  harness.emit({
    type: "AUDIO_EVENT",
    event: "ended",
    sessionId: first.sessionId,
    segmentIndex: first.segmentIndex,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.commandCalls.at(-1)?.command, "pause");
  assert.equal(harness.playCalls.length, 1, "the next segment must not auto-play after pause");
});

test("progress renders preserve the pause icon DOM so an in-flight click is not lost", async () => {
  const harness = createHarness();
  harness.emit({ type: "READ_SELECTION", text: "anything" });
  await flushUntil(() => harness.playCalls.length === 1);

  const first = harness.playCalls[0];
  const iconBefore = harness.playButton().firstElementChild;
  harness.emit({
    type: "AUDIO_EVENT",
    event: "progress",
    sessionId: first.sessionId,
    segmentIndex: first.segmentIndex,
    currentTime: 0.1,
    duration: 10,
  });

  assert.equal(
    harness.playButton().firstElementChild === iconBefore,
    true,
    "progress must not replace the element that received pointerdown",
  );
});

test("pausing while synthesis is pending prevents the resulting audio from auto-playing", async () => {
  const harness = createHarness({ deferredSynthesis: true });
  harness.emit({ type: "READ_SELECTION", text: "anything" });
  await flushUntil(() => harness.synthesisCalls.length === 1);

  harness.emit({ type: "TOGGLE_PLAYBACK" });
  harness.resolveSynthesis();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.playCalls.length, 0, "audio must remain paused after synthesis completes");
});

const paragraph = (name) => `${name}。${"这是一段需要完整连续朗读的正文，用来验证延迟加载时的播放顺序。".repeat(5)}`;
const pageFixture = () => `<html><body><article><p id="first">${paragraph("开头")}</p><p id="last">${paragraph("结尾")}</p></article></body></html>`;
const endCurrent = (harness) => {
  const current = harness.playCalls.at(-1);
  harness.emit({ type: "AUDIO_EVENT", event: "ended", sessionId: current.sessionId, segmentIndex: current.segmentIndex });
};

test("late middle blocks update the estimate and replace prefetched tail audio in document order", async () => {
  const harness = createHarness({ page: pageFixture() });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emit({ type: "TOGGLE_PLAYBACK" });
  await flushUntil(() => harness.playCalls.length === 1);
  assert.ok(harness.synthesisCalls.some((call) => call.text.includes("结尾")), "ending was prefetched before the middle existed");
  const initialTime = harness.time();
  const article = harness.document.querySelector("article");
  const middle = harness.document.createElement("p");
  middle.textContent = paragraph("中间").repeat(10);
  article.insertBefore(middle, harness.document.querySelector("#last"));
  await flushUntil(() => harness.time() !== initialTime);
  const count = harness.playCalls.length;
  endCurrent(harness);
  await flushUntil(() => harness.playCalls.length > count);
  const next = harness.playCalls.at(-1).segmentIndex;
  assert.ok(harness.synthesisCalls.filter((call) => call.requestId.startsWith(`${next}-`)).at(-1).text.includes("中间"));
  assert.match(harness.time(), /≈/);
  harness.stop();
});

test("a growing paragraph keeps its unread suffix after the current audio", async () => {
  const harness = createHarness({ page: `<html><body><article><p id="first">${paragraph("开头")}</p></article></body></html>` });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emit({ type: "TOGGLE_PLAYBACK" });
  await flushUntil(() => harness.playCalls.length === 1);
  harness.document.querySelector("#first").textContent += paragraph("新增后半段");
  endCurrent(harness);
  await flushUntil(() => harness.playCalls.length === 2);
  assert.ok(harness.synthesisCalls.filter((call) => call.requestId.startsWith("1-")).at(-1).text.includes("新增后半段"));
  harness.stop();
});

test("virtualized node recycling retains old content and adds new text once", async () => {
  const harness = createHarness({ page: `<html><body><article><p id="first">${paragraph("开头")}</p></article></body></html>` });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emit({ type: "TOGGLE_PLAYBACK" });
  await flushUntil(() => harness.playCalls.length === 1);
  harness.document.querySelector("#first").textContent = paragraph("回收节点的新段落");
  endCurrent(harness);
  await flushUntil(() => harness.playCalls.length === 2);
  assert.ok(harness.synthesisCalls.filter((call) => call.requestId.startsWith("1-")).at(-1).text.includes("回收节点的新段落"));
  endCurrent(harness);
  await flushUntil(() => harness.playButton().dataset.state === "idle");
  assert.equal(harness.playCalls.length, 2);
});

test("stopping during the settle window cancels the pending continuation", async () => {
  const harness = createHarness({ page: pageFixture() });
  await new Promise((resolve) => setImmediate(resolve));
  harness.emit({ type: "TOGGLE_PLAYBACK" });
  await flushUntil(() => harness.playCalls.length === 1);
  harness.document.querySelector("#first").append("新增文本");
  endCurrent(harness);
  harness.stop();
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(harness.playCalls.length, 1);
  assert.equal(harness.playButton().dataset.state, "idle");
});
