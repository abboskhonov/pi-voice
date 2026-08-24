import { test } from "node:test";
import assert from "node:assert/strict";
import { displayLanguage } from "../src/catalog.js";

test("catalog distinguishes Mandarin from Cantonese in spoken-language labels", () => {
  assert.equal(displayLanguage("zh"), "Mandarin (Chinese)");
  assert.equal(displayLanguage("zh-CN"), "Mandarin (Chinese)");
  assert.equal(displayLanguage("yue"), "Cantonese");
});
