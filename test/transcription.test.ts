import assert from "node:assert/strict";
import test from "node:test";
import { canStreamDictation } from "../src/transcription.js";

test("automatic language can stream for a Chinese-capable model", () => {
  const capabilities = {
    supportsStreaming: true,
    languages: ["en-US", "zh-CN"],
  };

  assert.equal(canStreamDictation(capabilities), true);
});
