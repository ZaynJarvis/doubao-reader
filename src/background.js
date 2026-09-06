importScripts("protocol.js");

const TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const DEFAULT_SETTINGS = Object.freeze({
  resourceId: "seed-tts-2.0",
  speaker: "zh_female_vv_uranus_bigtts",
  rate: 1,
});

const requests = new Map();
let creatingOffscreen = null;

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await protectCredentialStorage();
  await createContextMenus();

  if (reason === "install") {
    const { speechApiKey } = await chrome.storage.local.get("speechApiKey");
    if (!speechApiKey) {
      await chrome.runtime.openOptionsPage();
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  protectCredentialStorage();
  createContextMenus();
});

protectCredentialStorage();

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_READER" }).catch(() => undefined);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) {
    return;
  }

  if (info.menuItemId === "doubao-read-selection" && info.selectionText) {
    chrome.tabs.sendMessage(tab.id, {
      type: "READ_SELECTION",
      text: info.selectionText,
    }).catch(() => undefined);
  } else if (info.menuItemId === "doubao-open-settings") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-playback") {
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PLAYBACK" }).catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  if (message.type === "SYNTHESIZE") {
    synthesizeForSender(message, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
    return true;
  }

  if (message.type === "PLAY_AUDIO") {
    playForSender(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
    return true;
  }

  if (message.type === "PLAYBACK_COMMAND") {
    forwardPlaybackCommand(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
    return true;
  }

  if (message.type === "CANCEL_SESSION") {
    cancelSession(message.sessionId, sender.tab?.id);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_SAFE_SETTINGS") {
    getSafeSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
    return true;
  }

  if (message.type === "UPDATE_RATE") {
    const rate = Math.min(2, Math.max(0.75, Number(message.rate) || 1));
    chrome.storage.local.set({ rate })
      .then(() => sendResponse({ ok: true, rate }))
      .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
    return true;
  }

  if (message.type === "TEST_VOICE") {
    testVoice(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
    return true;
  }

  if (message.type === "AUDIO_EVENT" && sender.url?.endsWith("/src/offscreen.html")) {
    relayAudioEvent(message);
    return false;
  }

  return false;
});

async function protectCredentialStorage() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch (_error) {
    // Older Chromium builds do not expose setAccessLevel. The page still cannot
    // read extension storage directly because content scripts run in an isolated world.
  }
}

async function createContextMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "doubao-read-selection",
    title: "用豆包朗读选中文字",
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: "doubao-open-settings",
    title: "Doubao Reader 设置",
    contexts: ["action"],
  });
}

async function getSettings(overrides = {}) {
  const stored = await chrome.storage.local.get([
    "speechApiKey",
    "speaker",
    "rate",
  ]);

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    ...overrides,
    // Ignore resource IDs persisted by older versions. This reader only uses
    // the Seed TTS 2.0 contract, including its subtitle timestamps.
    resourceId: DEFAULT_SETTINGS.resourceId,
  };
}

async function getSafeSettings() {
  const settings = await getSettings();
  return {
    configured: Boolean(settings.speechApiKey),
    resourceId: settings.resourceId,
    speaker: settings.speaker,
    rate: Number(settings.rate) || DEFAULT_SETTINGS.rate,
  };
}

async function synthesizeForSender(message, sender) {
  const tabId = sender.tab?.id ?? "options";
  const sessionId = String(message.sessionId || "anonymous");
  const requestId = String(message.requestId || crypto.randomUUID());
  const key = `${tabId}:${sessionId}:${requestId}`;
  const controller = new AbortController();
  requests.set(key, controller);

  try {
    return await synthesize(message.text, controller.signal, message.settings);
  } finally {
    requests.delete(key);
  }
}

async function synthesize(text, signal, overrides = {}) {
  const normalizedText = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalizedText) {
    throw new Error("没有可朗读的文字");
  }
  if (normalizedText.length > 2000) {
    throw new Error("单段文字过长，请缩短到 2000 字以内");
  }

  const settings = await getSettings(overrides);
  if (!settings.speechApiKey) {
    const error = new Error("请先在设置中填写豆包语音 API Key");
    error.code = "NOT_CONFIGURED";
    throw error;
  }

  const requestId = crypto.randomUUID();
  const resourceId = settings.resourceId || DEFAULT_SETTINGS.resourceId;
  const response = await fetch(TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": settings.speechApiKey,
      "X-Api-Request-Id": requestId,
      "X-Api-Resource-Id": resourceId,
    },
    body: JSON.stringify({
      req_params: {
        text: normalizedText,
        speaker: settings.speaker || DEFAULT_SETTINGS.speaker,
        audio_params: {
          format: "mp3",
          sample_rate: 24000,
          ...(resourceId === "seed-tts-2.0" ? { enable_subtitle: true } : {}),
        },
      },
    }),
    signal,
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw createHttpError(response.status, responseText);
  }

  const decoded = DoubaoTtsProtocol.decodeTtsResponse(responseText);
  return { ...decoded, requestId };
}

function createHttpError(status, responseText) {
  let detail = "";
  try {
    const parsed = DoubaoTtsProtocol.parseChunkedJson(responseText)[0];
    detail = parsed?.message || parsed?.error?.message || "";
  } catch (_error) {
    detail = "";
  }

  if (status === 401 || status === 403) {
    return new Error(`鉴权失败。请确认使用的是豆包语音 API Key，而不是方舟 LLM Key${detail ? `：${detail}` : ""}`);
  }
  if (status === 429) {
    return new Error(`请求过快或额度不足${detail ? `：${detail}` : ""}`);
  }
  return new Error(`豆包语音请求失败（HTTP ${status}）${detail ? `：${detail}` : ""}`);
}

async function playForSender(message, sender) {
  const tabId = sender.tab?.id ?? null;
  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "OFFSCREEN_PLAY",
    audioBase64: message.audioBase64,
    mimeType: message.mimeType || "audio/mpeg",
    rate: Number(message.rate) || 1,
    tabId,
    sessionId: message.sessionId,
    segmentIndex: message.segmentIndex,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "无法播放音频");
  }
}

async function forwardPlaybackCommand(message, sender) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "OFFSCREEN_COMMAND",
    command: message.command,
    rate: message.rate,
    sessionId: message.sessionId,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "播放控制失败");
  }
}

function cancelSession(sessionId, tabId) {
  const prefix = `${tabId ?? "options"}:${sessionId}:`;
  for (const [key, controller] of requests) {
    if (key.startsWith(prefix)) {
      controller.abort();
      requests.delete(key);
    }
  }
}

async function testVoice(message) {
  const controller = new AbortController();
  const audio = await synthesize(
    "你好，我是豆包阅读器。声音设置成功。",
    controller.signal,
    message.settings,
  );
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "OFFSCREEN_PLAY",
    ...audio,
    rate: 1,
    sessionId: "options-test",
    segmentIndex: 0,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "测试音频播放失败");
  }
}

async function ensureOffscreenDocument() {
  const path = "src/offscreen.html";
  const url = chrome.runtime.getURL(path);

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    if (contexts.length) {
      return;
    }
  } else if (await chrome.offscreen.hasDocument()) {
    return;
  }

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: path,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play user-requested Doubao TTS audio outside the web page.",
    }).catch((error) => {
      if (!String(error?.message).includes("Only a single offscreen")) {
        throw error;
      }
    }).finally(() => {
      creatingOffscreen = null;
    });
  }
  await creatingOffscreen;
}

function relayAudioEvent(message) {
  relayToTab(message.tabId, {
    type: "AUDIO_EVENT",
    event: message.event,
    sessionId: message.sessionId,
    segmentIndex: message.segmentIndex,
    currentTime: message.currentTime,
    duration: message.duration,
  });

}

function relayToTab(tabId, message) {
  if (typeof tabId === "number") {
    chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
  }
}

function publicError(error) {
  if (error?.name === "AbortError") {
    return "已取消";
  }
  return String(error?.message || error || "未知错误");
}
