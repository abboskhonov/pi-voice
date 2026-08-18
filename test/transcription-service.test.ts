import assert from "node:assert/strict";
import test from "node:test";
import type { TranscribeSettings } from "../src/settings.js";
import { TranscriptionService } from "../src/transcription-service.js";
import type { TranscriptionOptions } from "../src/transcription.js";
import { deferred, nextTurn } from "./helpers.js";

function settings(modelPath: string): TranscribeSettings {
  return {
    version: 1,
    backend: { type: "transcribe-cpp" },
    shortcut: "ctrl+alt+z",
    preferredLanguages: ["en"],
    transcriptionLanguage: "auto",
    chineseOutput: "simplified",
    microphone: { type: "system-default" },
    model: { source: "catalog", id: modelPath, path: modelPath },
  };
}

function pcm(id: number): Float32Array {
  return Float32Array.of(id);
}

function createHarness(blockedIds: readonly number[] = []): {
  service: TranscriptionService;
  events: string[];
  release(id: number): void;
} {
  const events: string[] = [];
  const blocks = new Map(blockedIds.map((id) => [id, deferred()]));
  const service = new TranscriptionService((modelPath) => {
    events.push(`load:${modelPath}`);
    return {
      async prepare() {
        events.push(`prepare:${modelPath}`);
      },
      async transcribe(samples: Float32Array, options: TranscriptionOptions = {}) {
        const id = samples[0] ?? -1;
        events.push(`run:${id}`);
        await blocks.get(id)?.promise;
        options.signal?.throwIfAborted();
        events.push(`done:${id}`);
        return String(id);
      },
      async dispose() {
        events.push(`unload:${modelPath}`);
      },
    };
  });
  return {
    service,
    events,
    release(id) {
      blocks.get(id)?.resolve();
    },
  };
}

test("queued jobs sharing a model load it once", async () => {
  const harness = createHarness([1]);
  const first = harness.service.transcribeFile(settings("model-a"), pcm(1));
  await nextTurn();
  const second = harness.service.transcribeFile(settings("model-a"), pcm(2));

  harness.release(1);
  assert.deepEqual(await Promise.all([first, second]), ["1", "2"]);
  await nextTurn();

  assert.equal(harness.events.filter((event) => event === "load:model-a").length, 1);
  assert.deepEqual(
    harness.events.filter((event) => event.startsWith("run:")),
    ["run:1", "run:2"],
  );
  assert.equal(harness.events.at(-1), "unload:model-a");
  await harness.service.shutdown();
});

test("dictation reservation runs before queued file jobs", async () => {
  const harness = createHarness([1]);
  const activeFile = harness.service.transcribeFile(settings("model-a"), pcm(1));
  await nextTurn();
  const queuedFile = harness.service.transcribeFile(settings("model-a"), pcm(2));
  const reservation = harness.service.reserveDictation(settings("model-a"));

  harness.release(1);
  await reservation.ready;
  const dictation = reservation.submit(pcm(9));
  assert.deepEqual(
    await Promise.all([activeFile, dictation, queuedFile]),
    ["1", "9", "2"],
  );
  await nextTurn();

  assert.deepEqual(
    harness.events.filter((event) => event.startsWith("run:")),
    ["run:1", "run:9", "run:2"],
  );
  assert.equal(harness.events.filter((event) => event === "load:model-a").length, 1);
  assert.equal(harness.events.at(-1), "unload:model-a");
  await harness.service.shutdown();
});

test("cancelling a dictation reservation releases file work", async () => {
  const harness = createHarness();
  const reservation = harness.service.reserveDictation(settings("model-a"));
  await reservation.ready;
  const file = harness.service.transcribeFile(settings("model-a"), pcm(3));
  await nextTurn();

  assert.equal(harness.events.includes("run:3"), false);
  reservation.cancel();
  assert.equal(await file, "3");
  await harness.service.shutdown();
});

test("a different model is unloaded and loaded at the queue boundary", async () => {
  const harness = createHarness([4]);
  const first = harness.service.transcribeFile(settings("model-a"), pcm(4));
  await nextTurn();
  const second = harness.service.transcribeFile(settings("model-b"), pcm(5));

  harness.release(4);
  await Promise.all([first, second]);
  await nextTurn();

  assert.ok(
    harness.events.indexOf("unload:model-a") < harness.events.indexOf("load:model-b"),
  );
  assert.equal(harness.events.filter((event) => event === "load:model-a").length, 1);
  assert.equal(harness.events.filter((event) => event === "load:model-b").length, 1);
  await harness.service.shutdown();
});
