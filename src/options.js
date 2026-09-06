"use strict";

const FIXED_RESOURCE_ID = "seed-tts-2.0";
const DEFAULTS = Object.freeze({
  speaker: "zh_male_liufei_uranus_bigtts",
  rate: 1,
});
const RATE_STEPS = new Set([0.75, 1, 1.2, 1.5, 2]);

const elements = {
  apiKey: document.querySelector("#api-key"),
  form: document.querySelector("#settings-form"),
  keyState: document.querySelector("#key-state"),
  keyStateText: document.querySelector(".key-state-text"),
  rates: [...document.querySelectorAll('input[name="rate"]')],
  save: document.querySelector("#save"),
  speaker: document.querySelector("#speaker"),
  speakerPreset: document.querySelector("#speaker-preset"),
  status: document.querySelector("#status"),
  toggleKey: document.querySelector("#toggle-key"),
};

elements.form.addEventListener("submit", save);
elements.toggleKey.addEventListener("click", toggleKeyVisibility);
elements.apiKey.addEventListener("input", () => {
  clearInvalid(elements.apiKey);
  markDirty();
  syncKeyToggle();
});
elements.speaker.addEventListener("input", () => {
  clearInvalid(elements.speaker);
  markDirty();
});
elements.speakerPreset.addEventListener("change", () => {
  elements.speaker.hidden = Boolean(elements.speakerPreset.value);
  if (!elements.speakerPreset.value) {
    elements.speaker.focus();
  }
  markDirty();
});
for (const rate of elements.rates) {
  rate.addEventListener("change", markDirty);
}

load();

async function load() {
  try {
    const stored = await chrome.storage.local.get(["speechApiKey", "speaker", "rate"]);
    selectSpeaker(stored.speaker || DEFAULTS.speaker);
    selectRate(stored.rate);
    updateKeyState(Boolean(stored.speechApiKey));
    elements.apiKey.setAttribute("aria-required", String(!stored.speechApiKey));
    syncKeyToggle();
    elements.form.dataset.state = "ready";
  } catch (error) {
    updateKeyState(false);
    showStatus(String(error?.message || error || "读取设置失败"), "error");
  }
}

async function save(event) {
  event.preventDefault();
  clearStatus();

  const typedKey = elements.apiKey.value.trim();
  const speaker = (elements.speakerPreset.value || elements.speaker.value).trim();

  if (!speaker) {
    showValidation(elements.speaker, "需要音色 ID");
    return;
  }

  setBusy(true);
  try {
    const current = await chrome.storage.local.get("speechApiKey");
    const speechApiKey = typedKey || current.speechApiKey;
    if (!speechApiKey) {
      setBusy(false);
      showValidation(elements.apiKey, "需要 API Key");
      return;
    }

    await chrome.storage.local.set({
      speechApiKey,
      resourceId: FIXED_RESOURCE_ID,
      speaker,
      rate: selectedRate(),
    });

    elements.apiKey.value = "";
    concealKey();
    syncKeyToggle();
    updateKeyState(true);
    elements.apiKey.setAttribute("aria-required", "false");
    elements.form.dataset.state = "saved";
    showStatus("已保存", "success");
  } catch (error) {
    showStatus(String(error?.message || error || "保存失败"), "error");
  } finally {
    setBusy(false);
  }
}

function selectSpeaker(value) {
  const preset = [...elements.speakerPreset.options].some((option) => option.value === value);
  elements.speakerPreset.value = preset ? value : "";
  elements.speaker.value = preset ? "" : value;
  elements.speaker.hidden = preset;
}

function selectRate(value) {
  const rate = RATE_STEPS.has(Number(value)) ? Number(value) : DEFAULTS.rate;
  const input = elements.rates.find((candidate) => Number(candidate.value) === rate);
  if (input) {
    input.checked = true;
  }
}

function selectedRate() {
  const input = elements.rates.find((candidate) => candidate.checked);
  const rate = Number(input?.value);
  return RATE_STEPS.has(rate) ? rate : DEFAULTS.rate;
}

function toggleKeyVisibility() {
  const reveal = elements.apiKey.type === "password";
  elements.apiKey.type = reveal ? "text" : "password";
  elements.toggleKey.dataset.revealed = String(reveal);
  elements.toggleKey.setAttribute("aria-label", reveal ? "隐藏 API Key" : "显示 API Key");
}

function concealKey() {
  elements.apiKey.type = "password";
  elements.toggleKey.dataset.revealed = "false";
  elements.toggleKey.setAttribute("aria-label", "显示 API Key");
}

function syncKeyToggle() {
  const hasTypedKey = Boolean(elements.apiKey.value);
  elements.toggleKey.hidden = !hasTypedKey;
  if (!hasTypedKey) {
    concealKey();
  }
}

function updateKeyState(configured) {
  elements.keyState.classList.toggle("configured", configured);
  elements.keyStateText.textContent = configured ? "已保存" : "未配置";
}

function showValidation(input, message) {
  input.setAttribute("aria-invalid", "true");
  input.focus();
  showStatus(message, "error");
}

function clearInvalid(input) {
  input.removeAttribute("aria-invalid");
}

function showStatus(message, kind) {
  elements.status.textContent = message;
  elements.status.className = kind;
}

function clearStatus() {
  showStatus("", "");
}

function markDirty() {
  elements.form.dataset.state = "dirty";
  if (!elements.form.querySelector('[aria-invalid="true"]')) {
    clearStatus();
  }
}

function setBusy(busy) {
  elements.form.setAttribute("aria-busy", String(busy));
  for (const control of [elements.apiKey, elements.speaker, elements.speakerPreset, elements.toggleKey, ...elements.rates]) {
    control.disabled = busy;
  }
  elements.save.disabled = busy;
  elements.save.textContent = busy ? "保存中…" : "保存";
}
