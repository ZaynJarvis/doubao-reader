"use strict";

const player = document.querySelector("#player");
const PROGRESS_INTERVAL_MS = 100;
let objectUrl = null;
let playback = null;
let progressTimer = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  if (message.type === "OFFSCREEN_PLAY") {
    play(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "OFFSCREEN_COMMAND") {
    control(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "OFFSCREEN_STOP") {
    stop(false);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

player.addEventListener("ended", () => finish("ended"));
player.addEventListener("error", () => finish("error"));

async function play(message) {
  const previous = playback;
  const interrupted = Boolean(previous && player.src && !player.ended);
  stop(false);
  if (interrupted) {
    emitFor(previous, "interrupted");
  }
  playback = {
    tabId: message.tabId,
    sessionId: message.sessionId,
    segmentIndex: message.segmentIndex,
  };

  const bytes = base64ToBytes(message.audioBase64);
  const blob = new Blob([bytes], { type: message.mimeType || "audio/mpeg" });
  objectUrl = URL.createObjectURL(blob);
  player.src = objectUrl;
  player.playbackRate = clamp(Number(message.rate) || 1, 0.5, 2.5);
  try {
    await player.play();
    startProgressTicker();
  } catch (error) {
    stop(false);
    throw error;
  }
}

async function control(message) {
  if (!playback || (message.sessionId && playback.sessionId !== message.sessionId)) {
    throw new Error("MISSING_PLAYBACK");
  }

  switch (message.command) {
    case "pause":
      player.pause();
      stopProgressTicker();
      emitFor(playback, "progress");
      break;
    case "resume":
      await player.play();
      startProgressTicker();
      break;
    case "stop":
      stop(true);
      break;
    case "rate":
      player.playbackRate = clamp(Number(message.rate) || 1, 0.5, 2.5);
      break;
    default:
      throw new Error(`未知播放命令：${message.command}`);
  }
}

function stop(notify) {
  const previous = playback;
  stopProgressTicker();
  player.pause();
  player.removeAttribute("src");
  player.load();

  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  playback = null;

  if (notify && previous) {
    emitFor(previous, "stopped");
  }
}

function finish(event) {
  const finished = playback;
  stopProgressTicker();
  playback = null;
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  emitFor(finished, event);
}

function startProgressTicker() {
  stopProgressTicker();
  const tick = () => {
    if (!playback || player.paused || player.ended) {
      progressTimer = null;
      return;
    }
    emitFor(playback, "progress");
    progressTimer = setTimeout(tick, PROGRESS_INTERVAL_MS);
  };
  tick();
}

function stopProgressTicker() {
  if (progressTimer !== null) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
}

function emitFor(target, event) {
  if (!target) {
    return;
  }

  chrome.runtime.sendMessage({
    type: "AUDIO_EVENT",
    event,
    tabId: target.tabId,
    sessionId: target.sessionId,
    segmentIndex: target.segmentIndex,
    currentTime: player.currentTime,
    duration: Number.isFinite(player.duration) ? player.duration : null,
  });
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
