(function exposeProtocol(root, factory) {
  const protocol = factory();
  root.DoubaoTtsProtocol = protocol;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = protocol;
  }
})(globalThis, function createProtocol() {
  "use strict";

  function extractJsonObjects(input) {
    const source = String(input || "");
    const objects = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        if (depth === 0) {
          start = index;
        }
        depth += 1;
      } else if (character === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          objects.push(source.slice(start, index + 1));
          start = -1;
        }
      }
    }

    return objects;
  }

  function parseChunkedJson(input) {
    const normalized = String(input || "")
      .replace(/^[ \t]*data:[ \t]*/gm, "")
      .trim();

    if (!normalized) {
      return [];
    }

    try {
      const parsed = JSON.parse(normalized);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (_error) {
      return extractJsonObjects(normalized).map((value) => JSON.parse(value));
    }
  }

  function base64ToBytes(value) {
    if (typeof atob === "function") {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    }

    return Uint8Array.from(Buffer.from(value, "base64"));
  }

  function bytesToBase64(bytes) {
    if (typeof btoa === "function") {
      let binary = "";
      const step = 0x8000;
      for (let index = 0; index < bytes.length; index += step) {
        binary += String.fromCharCode(...bytes.subarray(index, index + step));
      }
      return btoa(binary);
    }

    return Buffer.from(bytes).toString("base64");
  }

  function mergeBase64Chunks(chunks) {
    const decoded = chunks.filter(Boolean).map(base64ToBytes);
    const size = decoded.reduce((sum, bytes) => sum + bytes.length, 0);
    const merged = new Uint8Array(size);
    let offset = 0;

    for (const bytes of decoded) {
      merged.set(bytes, offset);
      offset += bytes.length;
    }

    return bytesToBase64(merged);
  }

  function normalizeWordTiming(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    const word = typeof value.word === "string" ? value.word.trim() : "";
    const startTime = toFiniteNumber(value.startTime);
    const endTime = toFiniteNumber(value.endTime);
    if (!word || startTime === null || endTime === null || startTime < 0 || endTime < startTime) {
      return null;
    }

    const timing = { word, startTime, endTime };
    const confidence = toFiniteNumber(value.confidence);
    if (confidence !== null && confidence >= 0 && confidence <= 1) {
      timing.confidence = confidence;
    }
    return timing;
  }

  function toFiniteNumber(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function decodeTtsResponse(input) {
    const frames = parseChunkedJson(input);
    if (!frames.length) {
      throw new Error("豆包语音返回了空响应");
    }

    const audioChunks = [];
    const wordTimingMap = new Map();
    let usage = null;

    const successCodes = new Set([0, 20000000]);
    for (const frame of frames) {
      if (typeof frame.code === "number" && !successCodes.has(frame.code)) {
        throw new Error(frame.message || `豆包语音错误 ${frame.code}`);
      }
      if (typeof frame.data === "string" && frame.data) {
        audioChunks.push(frame.data);
      }
      if (frame.usage) {
        usage = frame.usage;
      }
      const words = frame.sentence?.words;
      if (Array.isArray(words)) {
        for (const value of words) {
          const timing = normalizeWordTiming(value);
          if (!timing) {
            continue;
          }
          const key = `${timing.startTime}\u0000${timing.endTime}\u0000${timing.word}`;
          wordTimingMap.set(key, timing);
        }
      }
    }

    if (!audioChunks.length) {
      throw new Error("豆包语音响应中没有音频数据");
    }

    return {
      audioBase64: mergeBase64Chunks(audioChunks),
      mimeType: "audio/mpeg",
      usage,
      wordTimings: [...wordTimingMap.values()].sort((left, right) => (
        left.startTime - right.startTime || left.endTime - right.endTime
      )),
    };
  }

  return {
    decodeTtsResponse,
    extractJsonObjects,
    mergeBase64Chunks,
    normalizeWordTiming,
    parseChunkedJson,
  };
});
