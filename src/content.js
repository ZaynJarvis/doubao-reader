(() => {
  "use strict";

  if (window.top !== window || document.documentElement.dataset.doubaoReaderLoaded) {
    return;
  }
  document.documentElement.dataset.doubaoReaderLoaded = "true";

  const MAX_SEGMENT_LENGTH = 280;
  const RATE_STEPS = [0.75, 1, 1.2, 1.5, 2];
  const extractor = globalThis.DoubaoPageExtractor;

  const state = {
    cache: new Map(),
    configured: false,
    currentIndex: -1,
    currentTime: 0,
    duration: null,
    highlightedNodes: [],
    intentRevision: 0,
    mappedWords: [],
    loadGeneration: 0,
    mode: "idle",
    queue: [],
    rate: 1,
    sessionId: null,
    visible: false,
    wantsPlayback: false,
    wordTimings: [],
  };

  const host = document.createElement("div");
  host.id = "doubao-reader-root";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `${styles()}${markup()}`;
  document.documentElement.append(host);

  const ui = {
    shell: shadow.querySelector(".shell"),
    player: shadow.querySelector(".player"),
    play: shadow.querySelector('[data-action="play"]'),
    previous: shadow.querySelector('[data-action="previous"]'),
    next: shadow.querySelector('[data-action="next"]'),
    stop: shadow.querySelector('[data-action="stop"]'),
    settings: shadow.querySelector('[data-action="settings"]'),
    rate: shadow.querySelector('[data-action="rate"]'),
    time: shadow.querySelector(".time"),
    status: shadow.querySelector(".sr-status"),
    error: shadow.querySelector(".error"),
  };

  bindUi();
  refreshSettings();
  chrome.storage?.local.get("widgetPosition").then((stored) => {
    if (stored?.widgetPosition) placeShell(stored.widgetPosition);
  }).catch(() => {});

  let lastContentMutationAt = performance.now();
  const contentObserver = new MutationObserver((records) => {
    if (records.some((record) => !host.contains(record.target))) {
      lastContentMutationAt = performance.now();
    }
  });
  contentObserver.observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "TOGGLE_READER") {
      setVisible(!state.visible);
    } else if (message?.type === "TOGGLE_PLAYBACK") {
      setVisible(true);
      togglePlayback();
    } else if (message?.type === "READ_SELECTION") {
      setVisible(true);
      startReading(message.text, "选中文字");
    } else if (message?.type === "AUDIO_EVENT") {
      handleAudioEvent(message);
    }
  });

  function bindUi() {
    ui.play.addEventListener("click", togglePlayback);
    ui.player.addEventListener("pointerup", (event) => {
      if (event.pointerType === "mouse") {
        event.target.closest?.("button")?.blur();
      }
    });
    ui.play.addEventListener("pointerup", (event) => {
      if (event.pointerType && event.pointerType !== "mouse") {
        ui.shell.classList.toggle("touch-expanded");
      }
    });
    ui.previous.addEventListener("click", () => skip(-1));
    ui.next.addEventListener("click", () => skip(1));
    ui.stop.addEventListener("click", stopReading);
    ui.settings.addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }));
    ui.rate.addEventListener("click", cycleRate);
    document.addEventListener("pointerdown", (event) => {
      if (!host.contains(event.target)) {
        ui.shell.classList.remove("touch-expanded");
      }
    }, { passive: true });
    bindDrag();
  }

  function bindDrag() {
    let origin = null;
    ui.time.addEventListener("pointerdown", (event) => {
      const rect = ui.shell.getBoundingClientRect();
      origin = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      ui.time.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    ui.time.addEventListener("pointermove", (event) => {
      if (!origin) return;
      const width = ui.shell.offsetWidth;
      const height = ui.shell.offsetHeight;
      placeShell({
        left: Math.min(Math.max(0, event.clientX - origin.x), window.innerWidth - width),
        top: Math.min(Math.max(0, event.clientY - origin.y), window.innerHeight - height),
      });
    });
    const end = () => {
      if (!origin) return;
      origin = null;
      chrome.storage?.local.set({ widgetPosition: { left: ui.shell.offsetLeft, top: ui.shell.offsetTop } }).catch(() => {});
    };
    ui.time.addEventListener("pointerup", end);
    ui.time.addEventListener("pointercancel", end);
  }

  function placeShell({ left, top }) {
    ui.shell.style.left = `${Math.max(0, Math.min(left, window.innerWidth - 52))}px`;
    ui.shell.style.top = `${Math.max(0, Math.min(top, window.innerHeight - 52))}px`;
    ui.shell.style.right = "auto";
    ui.shell.style.transform = "none";
  }

  async function refreshSettings() {
    const response = await send({ type: "GET_SAFE_SETTINGS" });
    if (!response?.ok) {
      return;
    }
    state.configured = response.settings.configured;
    state.rate = Number(response.settings.rate) || 1;
    render();
  }

  function setVisible(visible) {
    state.visible = visible;
    ui.shell.hidden = !visible;
  }

  async function togglePlayback() {
    clearError();

    if (state.wantsPlayback && (state.mode === "playing" || state.mode === "loading")) {
      const expectedSession = state.sessionId;
      const intentRevision = ++state.intentRevision;
      state.wantsPlayback = false;
      state.mode = "paused";
      render();
      const response = await send({
        type: "PLAYBACK_COMMAND",
        command: "pause",
        sessionId: state.sessionId,
      });
      if (
        !response?.ok
        && !response?.error?.includes("MISSING_PLAYBACK")
        && state.sessionId === expectedSession
        && state.intentRevision === intentRevision
        && !state.wantsPlayback
      ) {
        state.intentRevision += 1;
        state.wantsPlayback = true;
        state.mode = "playing";
        showError(response?.error || "暂停失败");
        render();
      }
      return;
    }

    if (state.mode === "paused") {
      const expectedSession = state.sessionId;
      const intentRevision = ++state.intentRevision;
      state.wantsPlayback = true;
      state.mode = "playing";
      render();
      const response = await send({
        type: "PLAYBACK_COMMAND",
        command: "resume",
        sessionId: state.sessionId,
      });
      if (!response?.ok) {
        if (
          state.sessionId !== expectedSession
          || state.intentRevision !== intentRevision
          || !state.wantsPlayback
        ) {
          return;
        }
        if (response?.error?.includes("MISSING_PLAYBACK") && state.currentIndex >= 0) {
          await loadAndPlay(state.currentIndex);
          return;
        }
        state.wantsPlayback = false;
        state.mode = "error";
        showError(response?.error || "恢复播放失败");
        render();
      }
      return;
    }

    if (!state.configured) {
      showError("先设置豆包语音 API Key");
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
      return;
    }

    const selection = extractor?.getSelectionText(document, window) || window.getSelection()?.toString().trim();
    if (selection) {
      await startReading(selection, "选中文字");
      return;
    }

    await waitForContentSettle();
    const extracted = extractReadableSegments();
    await beginQueue(extracted.queue, extracted.title || document.title || "当前页面", firstVisibleIndex(extracted.queue));
  }

  // Start from the first segment whose text is at or below the top of the viewport,
  // so a page scrolled halfway down reads from where the user is looking.
  function firstVisibleIndex(queue) {
    const index = queue.findIndex((segment) => {
      const nodes = segment.nodes?.length ? segment.nodes : segment.node ? [segment.node] : [];
      return nodes.some((node) => {
        if (!node?.isConnected) return false;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect?.();
        return Boolean(rect) && rect.height > 0 && rect.bottom >= 0;
      });
    });
    return index > 0 ? index : 0;
  }

  async function startReading(text, label) {
    if (!state.configured) {
      await refreshSettings();
    }
    if (!state.configured) {
      showError("先设置豆包语音 API Key");
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
      return;
    }

    const queue = splitText(text).map((part) => ({ text: part, node: null, nodes: [] }));
    await beginQueue(queue, label);
  }

  async function beginQueue(queue, label, startIndex = 0) {
    if (!queue.length) {
      showError("这页没有找到可朗读的正文。可先选中文字再试。");
      return;
    }

    await stopReading();
    state.queue = queue;
    state.currentIndex = startIndex;
    state.currentTime = 0;
    state.duration = null;
    state.wordTimings = [];
    state.mappedWords = [];
    state.sessionId = crypto.randomUUID();
    state.intentRevision += 1;
    state.wantsPlayback = true;
    state.cache.clear();
    state.mode = "loading";
    ui.player.setAttribute("aria-label", `${label} · 豆包阅读器`);
    render();
    await loadAndPlay(startIndex);
  }

  // Infinite-scroll pages append content as the user (or our auto-scroll) moves
  // down. Re-extract and append only blocks whose nodes we have not queued yet.
  function extendQueue() {
    const known = new Set(state.queue.flatMap((segment) => segment.nodes || []));
    if (!known.size || !extractor) return false;
    const result = extractor.extractPage(document, { window });
    const freshBlocks = result.blocks.filter((block) => !(block.nodes || [block.node]).some((node) => known.has(node)));
    const fresh = extractor.segmentBlocks(freshBlocks, { maxLength: MAX_SEGMENT_LENGTH, targetLength: 120 });
    if (!fresh.length) return false;
    state.queue.push(...fresh);
    return true;
  }

  async function loadAndPlay(index) {
    if (index >= state.queue.length && state.sessionId && extendQueue()) {
      render();
    }
    if (index < 0 || index >= state.queue.length || !state.sessionId) {
      finishReading();
      return;
    }

    const expectedSession = state.sessionId;
    const generation = ++state.loadGeneration;
    state.currentIndex = index;
    state.currentTime = 0;
    state.duration = null;
    state.wordTimings = [];
    state.mappedWords = [];
    state.mode = state.wantsPlayback ? "loading" : "paused";
    for (const key of state.cache.keys()) {
      if (key < index || key > index + 1) state.cache.delete(key);
    }
    highlightCurrent();
    render();

    try {
      const audio = await synthesize(index, expectedSession);
      if (state.sessionId !== expectedSession || state.loadGeneration !== generation) {
        return;
      }

      state.wordTimings = Array.isArray(audio.wordTimings) ? audio.wordTimings : [];
      state.mappedWords = mapWordTimings(state.queue[index], state.wordTimings);

      if (!state.wantsPlayback) {
        state.mode = "paused";
        render();
        return;
      }

      const response = await send({
        type: "PLAY_AUDIO",
        sessionId: expectedSession,
        segmentIndex: index,
        audioBase64: audio.audioBase64,
        mimeType: audio.mimeType,
        rate: state.rate,
      });
      if (state.sessionId !== expectedSession || state.loadGeneration !== generation) {
        return;
      }
      if (!state.wantsPlayback) {
        const pauseRevision = state.intentRevision;
        if (response?.ok) {
          await send({
            type: "PLAYBACK_COMMAND",
            command: "pause",
            sessionId: expectedSession,
          });
        }
        if (
          state.sessionId !== expectedSession
          || state.loadGeneration !== generation
          || state.intentRevision !== pauseRevision
          || state.wantsPlayback
        ) {
          return;
        }
        state.mode = "paused";
        render();
        return;
      }
      if (!response?.ok) {
        throw new Error(response?.error || "播放失败");
      }

      state.mode = "playing";
      render();

      if (index + 1 >= state.queue.length) {
        extendQueue();
      }
      if (index + 1 < state.queue.length) {
        synthesize(index + 1, expectedSession).catch(() => undefined);
      }
    } catch (error) {
      if (state.sessionId === expectedSession && String(error?.message || error) !== "已取消") {
        state.mode = "error";
        showError(String(error?.message || error));
        render();
      }
    }
  }

  function synthesize(index, sessionId) {
    if (state.cache.has(index)) {
      return state.cache.get(index);
    }

    const promise = send({
      type: "SYNTHESIZE",
      sessionId,
      requestId: `${index}-${crypto.randomUUID()}`,
      text: state.queue[index].text,
    }).then((response) => {
      if (!response?.ok) {
        throw new Error(response?.error || "语音生成失败");
      }
      return response;
    }).catch((error) => {
      state.cache.delete(index);
      throw error;
    });

    state.cache.set(index, promise);
    return promise;
  }

  function handleAudioEvent(message) {
    if (message.sessionId !== state.sessionId || message.segmentIndex !== state.currentIndex) {
      return;
    }

    if (message.event === "ended") {
      state.cache.delete(state.currentIndex);
      const nextIndex = state.currentIndex + 1;
      if (!state.wantsPlayback && nextIndex < state.queue.length) {
        state.currentIndex = nextIndex;
        state.currentTime = 0;
        state.duration = null;
        state.wordTimings = [];
        state.mappedWords = [];
        state.mode = "paused";
        highlightCurrent();
        render();
      } else {
        loadAndPlay(nextIndex);
      }
    } else if (message.event === "paused") {
      if (!state.wantsPlayback) {
        state.mode = "paused";
        render();
      }
    } else if (message.event === "playing") {
      if (state.wantsPlayback) {
        state.mode = "playing";
        render();
      } else {
        send({
          type: "PLAYBACK_COMMAND",
          command: "pause",
          sessionId: state.sessionId,
        });
      }
    } else if (message.event === "progress") {
      state.currentTime = Number.isFinite(message.currentTime) ? message.currentTime : state.currentTime;
      state.duration = Number.isFinite(message.duration) ? message.duration : state.duration;
      updateWordHighlight();
      render();
    } else if (message.event === "error") {
      state.mode = "error";
      showError("浏览器无法播放生成的音频");
      render();
    } else if (message.event === "interrupted") {
      stopReading();
    }
  }

  async function skip(delta) {
    if (!state.queue.length) {
      return;
    }
    const target = Math.min(state.queue.length - 1, Math.max(0, state.currentIndex + delta));
    if (target === state.currentIndex) {
      return;
    }
    await send({
      type: "PLAYBACK_COMMAND",
      command: "stop",
      sessionId: state.sessionId,
    });
    await loadAndPlay(target);
  }

  async function stopReading() {
    const previousSession = state.sessionId;
    state.loadGeneration += 1;
    state.intentRevision += 1;
    state.sessionId = null;
    state.wantsPlayback = false;
    state.mode = "idle";
    state.currentIndex = -1;
    state.currentTime = 0;
    state.duration = null;
    state.wordTimings = [];
    state.mappedWords = [];
    state.queue = [];
    state.cache.clear();
    clearHighlight();
    clearError();
    render();

    if (previousSession) {
      await send({ type: "CANCEL_SESSION", sessionId: previousSession });
      await send({
        type: "PLAYBACK_COMMAND",
        command: "stop",
        sessionId: previousSession,
      });
    }
  }

  function finishReading() {
    state.intentRevision += 1;
    state.mode = "idle";
    state.currentIndex = -1;
    state.currentTime = 0;
    state.duration = null;
    state.wordTimings = [];
    state.mappedWords = [];
    state.queue = [];
    state.cache.clear();
    state.sessionId = null;
    state.wantsPlayback = false;
    clearHighlight();
    render();
  }

  async function cycleRate() {
    const current = RATE_STEPS.indexOf(state.rate);
    state.rate = RATE_STEPS[(current + 1) % RATE_STEPS.length];
    ui.rate.textContent = `${state.rate}×`;
    await send({ type: "UPDATE_RATE", rate: state.rate });
    if (state.sessionId) {
      await send({
        type: "PLAYBACK_COMMAND",
        command: "rate",
        rate: state.rate,
        sessionId: state.sessionId,
      });
    }
  }

  function extractReadableSegments() {
    if (!extractor) {
      return { title: document.title, queue: [] };
    }
    const result = extractor.extractPage(document, { window });
    const queue = extractor.segmentBlocks(result.blocks, {
      firstMaxLength: 140,
      maxLength: MAX_SEGMENT_LENGTH,
      targetLength: 120,
    });
    return { title: result.title, queue };
  }

  function splitText(input) {
    return extractor?.splitLongText(input, MAX_SEGMENT_LENGTH) || [];
  }

  async function waitForContentSettle() {
    const startedAt = performance.now();
    while (performance.now() - lastContentMutationAt < 90 && performance.now() - startedAt < 450) {
      await new Promise((resolve) => setTimeout(resolve, 45));
    }
  }

  function highlightCurrent() {
    clearHighlight();
    const current = state.queue[state.currentIndex];
    const nodes = Array.from(new Set(current?.nodes || (current?.node ? [current.node] : [])))
      .filter((node) => node?.isConnected);
    if (!nodes.length) {
      return;
    }
    state.highlightedNodes = nodes;

    const ranges = rangesForSegment(current);
    if (supportsCustomHighlights() && ranges.length) {
      CSS.highlights.set("doubao-reader-segment", new Highlight(...ranges));
    } else {
      // Chrome 105+ uses non-mutating Custom Highlights. This class is only a
      // compatibility fallback for older Chromium builds.
      for (const node of nodes) {
        node.classList.add("doubao-reader-source-active");
      }
    }
    const first = nodes[0];
    if (!isMostlyVisible(first)) {
      first.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function clearHighlight() {
    if (globalThis.CSS?.highlights) {
      CSS.highlights.delete("doubao-reader-word");
      CSS.highlights.delete("doubao-reader-segment");
    }
    for (const node of state.highlightedNodes) {
      node?.classList?.remove("doubao-reader-source-active");
    }
    state.highlightedNodes = [];
  }

  function updateWordHighlight() {
    if (!supportsCustomHighlights()) {
      return;
    }
    CSS.highlights.delete("doubao-reader-word");
    const active = state.mappedWords.find((entry) => (
      state.currentTime >= entry.startTime && state.currentTime < entry.endTime
    ));
    if (active?.ranges?.length) {
      CSS.highlights.set("doubao-reader-word", new Highlight(...active.ranges));
    }
  }

  function rangesForSegment(segment) {
    const index = createTextIndex(segment?.nodes || []);
    if (!index.key || !segment?.text) {
      return [];
    }
    const wanted = comparableText(segment.text);
    const start = index.key.indexOf(wanted);
    if (start < 0) {
      return index.entries.length ? segmentRangesFromEntries(index.entries) : [];
    }
    return segmentRangesFromEntries(index.entries.slice(start, start + wanted.length));
  }

  function mapWordTimings(segment, timings) {
    if (!supportsCustomHighlights() || !segment?.text || !timings.length) {
      return [];
    }
    const index = createTextIndex(segment.nodes || []);
    const wanted = comparableText(segment.text);
    const segmentStart = index.key.indexOf(wanted);
    if (segmentStart < 0) {
      return [];
    }
    const segmentEnd = segmentStart + wanted.length;
    let cursor = segmentStart;
    const mapped = [];
    for (const timing of timings) {
      const word = comparableText(timing.word);
      if (!word) {
        continue;
      }
      const position = index.key.indexOf(word, cursor);
      if (position < cursor || position + word.length > segmentEnd) {
        continue;
      }
      const ranges = rangesFromEntries(index.entries.slice(position, position + word.length));
      if (ranges.length) {
        mapped.push({
          startTime: timing.startTime,
          endTime: timing.endTime,
          ranges,
        });
      }
      cursor = position + word.length;
    }
    return mapped;
  }

  function createTextIndex(nodes) {
    const entries = [];
    const seen = new Set();
    for (const sourceNode of nodes) {
      if (!sourceNode?.isConnected) {
        continue;
      }
      const walker = document.createTreeWalker(sourceNode, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode) {
        if (!seen.has(textNode)) {
          seen.add(textNode);
          const value = textNode.nodeValue || "";
          for (let offset = 0; offset < value.length; offset += 1) {
            const character = value[offset];
            if (/[\p{L}\p{N}]/u.test(character)) {
              entries.push({
                character: character.toLocaleLowerCase(),
                node: textNode,
                offset,
                sourceNode,
              });
            }
          }
        }
        textNode = walker.nextNode();
      }
    }
    return { entries, key: entries.map((entry) => entry.character).join("") };
  }

  function segmentRangesFromEntries(entries) {
    if (!entries.length) {
      return [];
    }
    const ranges = [];
    let first = entries[0];
    let previous = first;
    const push = () => {
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(previous.node, previous.offset + 1);
      ranges.push(range);
    };
    for (let index = 1; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.sourceNode !== previous.sourceNode) {
        push();
        first = entry;
      }
      previous = entry;
    }
    push();
    return ranges;
  }

  function rangesFromEntries(entries) {
    if (!entries.length) {
      return [];
    }
    const ranges = [];
    let first = entries[0];
    let previous = first;
    const push = () => {
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(previous.node, previous.offset + 1);
      ranges.push(range);
    };
    for (let index = 1; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.node !== previous.node || entry.offset !== previous.offset + 1) {
        push();
        first = entry;
      }
      previous = entry;
    }
    push();
    return ranges;
  }

  function comparableText(value) {
    return String(value || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function supportsCustomHighlights() {
    return Boolean(globalThis.CSS?.highlights && globalThis.Highlight);
  }

  function isMostlyVisible(node) {
    const rect = node.getBoundingClientRect();
    return rect.top >= 80 && rect.bottom <= window.innerHeight - 100;
  }

  function showError(message) {
    ui.error.textContent = message;
    ui.error.hidden = false;
  }

  function clearError() {
    ui.error.hidden = true;
    ui.error.textContent = "";
  }

  function render() {
    const current = state.queue[state.currentIndex];
    const total = state.queue.length;
    const position = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
    ui.play.dataset.state = state.mode;
    ui.shell.dataset.active = total ? "true" : "false";
    const canPause = state.wantsPlayback && (state.mode === "playing" || state.mode === "loading");
    const iconState = state.mode === "loading" ? "loading" : canPause ? "pause" : "play";
    ui.play.setAttribute("aria-label", canPause ? "暂停" : "播放");
    if (ui.play.dataset.iconState !== iconState) {
      ui.play.dataset.iconState = iconState;
      ui.play.innerHTML = iconState === "loading" ? spinnerIcon() : iconState === "pause" ? pauseIcon() : playIcon();
    }
    ui.play.title = canPause ? "暂停" : "播放";
    ui.time.textContent = formatDuration(remainingSeconds());
    ui.time.hidden = state.mode === "idle" || !total;
    ui.status.textContent = state.mode === "idle"
      ? "准备朗读当前页面"
      : `${state.mode === "playing" ? "正在播放" : state.mode === "paused" ? "已暂停" : "正在准备"}，第 ${position} 段，共 ${total} 段`;
    ui.rate.textContent = `${state.rate}×`;
    ui.previous.disabled = !total || state.currentIndex <= 0;
    ui.next.disabled = !total || state.currentIndex >= total - 1;
    ui.stop.disabled = state.mode === "idle";
  }

  function remainingSeconds() {
    if (!state.queue.length || state.currentIndex < 0) {
      return 0;
    }
    const current = Number.isFinite(state.duration)
      ? Math.max(0, state.duration - state.currentTime) / state.rate
      : estimateSpeechSeconds(state.queue[state.currentIndex]?.text) / state.rate;
    const future = state.queue
      .slice(state.currentIndex + 1)
      .reduce((sum, segment) => sum + estimateSpeechSeconds(segment.text) / state.rate, 0);
    return Math.ceil(current + future);
  }

  function estimateSpeechSeconds(text) {
    const value = String(text || "");
    const cjk = (value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
    const latinWords = (value.match(/[\p{L}\p{N}]+/gu) || [])
      .filter((word) => !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)).length;
    const pauses = (value.match(/[。！？!?；;,.，]/g) || []).length;
    return Math.max(1, cjk * 0.24 + latinWords * 0.4 + pauses * 0.12);
  }

  function formatDuration(seconds) {
    const minutes = Math.max(1, Math.ceil((Number(seconds) || 0) / 60));
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours}h ${minutes % 60}m` : `${minutes} min`;
  }

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  function markup() {
    return `
      <div class="shell" data-active="false" hidden>
        <output class="time" aria-hidden="true" title="拖动移动" hidden>1 min</output>
        <section class="player" aria-label="Doubao Reader">
          <div class="primary-rail">
            <button data-action="play" class="play" aria-label="播放" title="播放">${playIcon()}</button>
          </div>
          <div class="secondary-rail" aria-label="播放控制">
            <button data-action="previous" class="control playback-only" aria-label="上一段" title="上一段">${previousIcon()}</button>
            <button data-action="next" class="control playback-only" aria-label="下一段" title="下一段">${nextIcon()}</button>
            <button data-action="rate" class="rate" aria-label="切换语速" title="切换语速">1×</button>
            <button data-action="settings" class="control" aria-label="设置" title="设置">${settingsIcon()}</button>
            <button data-action="stop" class="control stop playback-only" aria-label="停止朗读" title="停止朗读">${stopIcon()}</button>
          </div>
          <p class="error" role="alert" hidden></p>
          <span class="sr-status" role="status" aria-live="polite">准备朗读当前页面</span>
        </section>
      </div>`;
  }

  function styles() {
    return `<style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      button { font: inherit; }
      .shell { position: fixed; top: 50%; right: 22px; transform: translateY(-50%); z-index: 2147483647; width: 52px; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; }
      .time { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(100% - 6px); min-width: 28px; padding: 1px 7px; border-radius: 10px; color: #fff; background: rgba(31,31,32,.94); box-shadow: 0 0 0 1px rgba(255,255,255,.055), 0 4px 12px rgba(0,0,0,.18); font-size: 11px; font-weight: 700; line-height: 16px; letter-spacing: -.02em; text-align: center; white-space: nowrap; font-variant-numeric: tabular-nums; cursor: grab; touch-action: none; user-select: none; }
      .time:active { cursor: grabbing; }
      .player { position: relative; width: 52px; }
      .primary-rail { display: flex; width: 52px; padding: 12px; }
      .secondary-rail { position: absolute; top: calc(100% - 8px); right: 12px; display: flex; width: 28px; flex-direction: column; gap: 2px; padding: 3px 0; border-radius: 14px; background: rgba(31,31,32,.96); box-shadow: 0 0 0 1px rgba(255,255,255,.055), 0 8px 22px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.035); backdrop-filter: blur(16px); opacity: 0; pointer-events: none; transform: translateY(-4px) scale(.97); transform-origin: 50% 0; transition: opacity 160ms cubic-bezier(.23,1,.32,1), transform 180ms cubic-bezier(.23,1,.32,1); }
      .secondary-rail::before { content: ""; position: absolute; top: -12px; right: -12px; left: -12px; height: 12px; background: transparent; }
      .shell:has(:focus-visible) .secondary-rail, .shell.touch-expanded .secondary-rail { opacity: 1; pointer-events: auto; transform: translateY(0) scale(1); }
      .play, .control, .rate { display: grid; place-items: center; width: 28px; height: 28px; flex: 0 0 28px; padding: 0; border: 0; border-radius: 50%; color: rgba(255,255,255,.94); background: transparent; cursor: pointer; transition: color 140ms ease, background-color 140ms ease, transform 140ms cubic-bezier(.23,1,.32,1); }
      .play { background: rgba(31,31,32,.96); box-shadow: 0 0 0 1px rgba(255,255,255,.055), 0 8px 22px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.035); backdrop-filter: blur(16px); }
      .play:active, .control:active:not(:disabled), .rate:active { transform: scale(.94); }
      .play:focus-visible, .control:focus-visible, .rate:focus-visible { outline: 2px solid #9c82ff; outline-offset: 1px; }
      .play svg { width: 16px; height: 16px; }
      .control svg { width: 14px; height: 14px; }
      .control:disabled { opacity: .22; cursor: default; }
      .shell[data-active="false"] .playback-only { display: none; }
      .stop { color: rgba(255,255,255,.48); }
      @keyframes spin { to { transform: rotate(360deg); } }
      .rate { font-size: 10px; font-weight: 720; letter-spacing: -.03em; }
      .error { position: absolute; top: 0; right: calc(100% + 10px); width: 238px; margin: 0; padding: 10px 12px; border: 1px solid rgba(255,112,139,.2); border-radius: 12px; color: #ffd6de; background: rgba(48,28,33,.97); box-shadow: 0 8px 24px rgba(0,0,0,.24); font-size: 12px; line-height: 17px; }
      .sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
      [hidden] { display: none !important; }
      @media (hover: hover) and (pointer: fine) {
        .shell:hover .secondary-rail { opacity: 1; pointer-events: auto; transform: translateY(0) scale(1); }
        .play:hover { background: rgba(48,48,50,.98); } .control:hover:not(:disabled), .rate:hover { color: #fff; background: rgba(255,255,255,.12); }
        .stop:hover:not(:disabled) { color: #ffb6c2; background: rgba(255,91,117,.12); }
      }
      @media (prefers-reduced-motion: reduce) {
        .secondary-rail { transition: opacity 120ms ease; transform: none; }
        .shell:has(:focus-visible) .secondary-rail, .shell.touch-expanded .secondary-rail { transform: none; }
      }
      @media (max-width: 480px) { .shell { right: 12px; } }
    </style>`;
  }

  function icon(paths, extra = "") {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;
  }
  function playIcon() { return icon('<path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none"/>'); }
  function pauseIcon() { return icon('<path d="M9 5v14M15 5v14" stroke-width="3"/>'); }
  function spinnerIcon() { return icon('<path d="M20 12a8 8 0 1 1-5.5-7.6"/>', 'style="animation:spin .8s linear infinite"'); }
  function previousIcon() { return icon('<path d="M6 5v14M18 6l-9 6 9 6z"/>'); }
  function nextIcon() { return icon('<path d="M18 5v14M6 6l9 6-9 6z"/>'); }
  function stopIcon() { return icon('<rect x="7.5" y="7.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none"/>'); }
  function settingsIcon() { return icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.55V21h-4v-.08a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63a1.7 1.7 0 0 0 1-1.55V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9a1.7 1.7 0 0 0 1.55 1H21v4h-.08a1.7 1.7 0 0 0-1.52 1z"/>'); }
})();
