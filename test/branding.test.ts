import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

test("registers /voice rather than the legacy /transcribe command", () => {
  assert.match(indexSource, /registerCommand\("voice",/);
  assert.doesNotMatch(indexSource, /registerCommand\("transcribe",/);
});
