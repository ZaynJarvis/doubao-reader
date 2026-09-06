"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decodeTtsResponse,
  extractJsonObjects,
  mergeBase64Chunks,
  parseChunkedJson,
} = require("../src/protocol.js");

test("parses one JSON response", () => {
  assert.deepEqual(parseChunkedJson('{"code":0,"data":"YQ=="}'), [
    { code: 0, data: "YQ==" },
  ]);
});

test("parses newline-delimited and SSE-style frames", () => {
  const input = [
    'data: {"code":0,"data":"YQ=="}',
    '{"code":0,"data":"YmM="}',
  ].join("\n");
  assert.equal(parseChunkedJson(input).length, 2);
});

test("extracts concatenated JSON while respecting braces in strings", () => {
  const values = extractJsonObjects('{"message":"a } b"}{"code":0}');
  assert.deepEqual(values, ['{"message":"a } b"}', '{"code":0}']);
});

test("merges independently padded base64 chunks as bytes", () => {
  assert.equal(mergeBase64Chunks(["YQ==", "YmM="]), "YWJj");
});

test("decodes audio frames and retains usage", () => {
  const response = [
    '{"code":0,"message":"OK","data":"YQ=="}',
    '{"code":0,"data":"YmM=","usage":{"text_words":3}}',
  ].join("\n");
  assert.deepEqual(decodeTtsResponse(response), {
    audioBase64: "YWJj",
    mimeType: "audio/mpeg",
    usage: { text_words: 3 },
    wordTimings: [],
  });
});

test("merges, sorts, and normalizes subtitle word timings in seconds", () => {
  const response = [
    JSON.stringify({
      code: 0,
      data: "YQ==",
      sentence: {
        words: [
          { word: "好，", startTime: 0.335, endTime: 0.725, confidence: 0.918 },
          { word: "你", startTime: "0.195", endTime: "0.335", confidence: "0.896" },
        ],
      },
    }),
    JSON.stringify({
      code: 20000000,
      data: "YmM=",
      sentence: {
        words: [
          { word: "你", startTime: 0.195, endTime: 0.335, confidence: 0.9 },
          { word: "呀", startTime: 0.725, endTime: 0.9 },
        ],
      },
    }),
  ].join("\n");

  assert.deepEqual(decodeTtsResponse(response).wordTimings, [
    { word: "你", startTime: 0.195, endTime: 0.335, confidence: 0.9 },
    { word: "好，", startTime: 0.335, endTime: 0.725, confidence: 0.918 },
    { word: "呀", startTime: 0.725, endTime: 0.9 },
  ]);
});

test("ignores absent and malformed subtitle words without dropping audio", () => {
  const response = [
    JSON.stringify({ code: 0, data: "YQ==", sentence: null }),
    JSON.stringify({
      code: 20000000,
      data: "YmM=",
      sentence: {
        words: [
          null,
          { word: "", startTime: 0, endTime: 1 },
          { word: "missing start", endTime: 1 },
          { word: "backwards", startTime: 2, endTime: 1 },
          { word: "not finite", startTime: "nope", endTime: 1 },
          { word: "valid", startTime: 1, endTime: 1.25, confidence: 9 },
        ],
      },
    }),
  ].join("\n");

  assert.deepEqual(decodeTtsResponse(response).wordTimings, [
    { word: "valid", startTime: 1, endTime: 1.25 },
  ]);
});

test("accepts the V3 terminal success code", () => {
  const response = [
    '{"code":0,"data":"YQ=="}',
    '{"code":20000000,"message":"OK","data":"YmM="}',
  ].join("\n");
  assert.equal(decodeTtsResponse(response).audioBase64, "YWJj");
});

test("surfaces API errors without pretending audio exists", () => {
  assert.throws(
    () => decodeTtsResponse('{"code":45000000,"message":"invalid speaker"}'),
    /invalid speaker/,
  );
});
