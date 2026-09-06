"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { parseHTML } = require("linkedom");

const CONTENT_SOURCE = fs.readFileSync(require.resolve("../src/content.js"), "utf8");

function createHarness({ deferredSynthesis = false } = {}) {
  const { window } = parseHTML("<!doctype html><html><body><main>fixture</main></body></html>");
  Object.defineProperty(window, "top", { value: window, configurable: true });
  window.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
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
    CSS: { highlights: new Map() },
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
  context.DoubaoPageExtractor = {
    extractPage: () => ({ title: "fixture", blocks: [] }),
    getSelectionText: () => "",
    segmentBlocks: () => [],
    splitLongText: () => ["first segment", "second segment"],
  };
  vm.runInContext(CONTENT_SOURCE, context);

  return {
    commandCalls,
    emit: (message) => listener(message),
    playCalls,
    resolveSynthesis: () => resolveSynthesis?.(),
    playButton: () => shadow.querySelector('[data-action="play"]'),
    synthesisCalls,
  };
}

async function flushUntil(predicate, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
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
