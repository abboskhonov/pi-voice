import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countWords, createVoiceStatsStore } from "../src/voice-stats.js";

test("counts natural-language words", () => {
  assert.equal(countWords("Hello, world! Don't stop."), 4);
});

test("persists dictated words by local day and summarizes today and this month", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-stats-"));
  try {
    const store = createVoiceStatsStore(directory);
    const march1 = new Date(2026, 2, 1, 12).getTime();
    const march15 = new Date(2026, 2, 15, 12).getTime();
    const april1 = new Date(2026, 3, 1, 12).getTime();

    await store.addTranscript("one two", march1);
    await store.addTranscript("three four five", march15);
    await store.addTranscript("six", april1);

    assert.deepEqual(await createVoiceStatsStore(directory).summary(march15), {
      today: 3,
      thisMonth: 5,
      allTime: 6,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
