import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  CatalogModelPicker,
  createTranscriptionLanguagePicker,
  LanguagePicker,
  type CatalogModelPickerResult,
  type CatalogModelPostActivation,
} from "../src/model-picker.js";
import { getRepoFolderName } from "@huggingface/hub";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_MODELS, type CatalogModel } from "../src/catalog.js";

// Keep cache and partial-download probes away from the real Hugging Face cache.
process.env.HF_HUB_CACHE = mkdtempSync(join(tmpdir(), "pi-transcribe-picker-"));

initTheme("dark");

const ESC = "\u001b";
const ENTER = "\r";
const DOWN = "\u001b[B";

function testTheme(): ExtensionContext["ui"]["theme"] {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    inverse: (text: string) => text,
  } as unknown as ExtensionContext["ui"]["theme"];
}

function testTui(): TUI {
  return { requestRender() {} } as unknown as TUI;
}

function keybindings(): KeybindingsManager {
  return new KeybindingsManager(TUI_KEYBINDINGS);
}

type ActivationOptions = {
  cached: unknown;
  signal: AbortSignal;
  onProgress: (progress: { downloaded: number; total: number }) => void;
};

type PickerInternals = {
  cachedById: Map<string, unknown>;
  mode: string;
  downloadSamples: { t: number; bytes: number }[];
  filtered: CatalogModel[];
  refresh: () => void;
};

/** A picker in which no model is cached, with a manually driven activation. */
function controlledPicker(postActivation: CatalogModelPostActivation = "stay"): {
  picker: CatalogModelPicker;
  internals: PickerInternals;
  resolve: (path: string) => void;
  reject: (error: unknown) => void;
  signal: () => AbortSignal;
  progress: (downloaded: number, total: number) => void;
  result: () => CatalogModelPickerResult | undefined;
} {
  let options: ActivationOptions | undefined;
  let completed: CatalogModelPickerResult | undefined;
  let resolveActivation!: (value: { path: string }) => void;
  let rejectActivation!: (error: unknown) => void;
  const picker = new CatalogModelPicker(
    testTui(),
    testTheme(),
    keybindings(),
    ["en"],
    undefined,
    (result) => {
      completed = result;
    },
    (_model: CatalogModel, activationOptions: ActivationOptions) => {
      options = activationOptions;
      return new Promise<{ path: string }>((resolvePromise, rejectPromise) => {
        resolveActivation = resolvePromise;
        rejectActivation = rejectPromise;
      });
    },
    { postActivation },
  );
  const internals = picker as unknown as PickerInternals;
  // Deterministic regardless of the developer's local Hugging Face cache.
  internals.cachedById.clear();
  internals.refresh();
  return {
    picker,
    internals,
    resolve: (path) => resolveActivation({ path }),
    reject: (error) => rejectActivation(error),
    signal: () => options!.signal,
    progress: (downloaded, total) => options!.onProgress({ downloaded, total }),
    result: () => completed,
  };
}

function rendered(picker: CatalogModelPicker): string {
  return picker.render(100).join("\n");
}

test("enter on an uncached model starts the download immediately", (t) => {
  const { picker, internals, progress } = controlledPicker();
  t.after(() => picker.dispose());
  const body = rendered(picker);
  // The detail pane carries the model facts; the footer carries the action.
  assert.match(body, /English only|\d+ languages/);
  assert.match(body, /enter.*download \d/);
  assert.equal((stripAnsi(body).match(/tab change/gi) ?? []).length, 1);

  picker.handleInput(ENTER);
  assert.equal(internals.mode, "downloading");
  progress(0, 3_000_000_000);
  progress(1_260_000_000, 3_000_000_000);
  const downloading = rendered(picker);
  assert.match(downloading, /Downloading /);
  assert.match(downloading, /█+─+ 42%/);
  assert.match(downloading, /1\.2 GiB \/ 2\.8 GiB/);
  // The list and search are gone while the modal progress view is up.
  assert.doesNotMatch(downloading, /67 models/);
});

test("download stats include a rolling speed and ETA", (t) => {
  const { picker, internals, progress } = controlledPicker();
  t.after(() => picker.dispose());
  picker.handleInput(ENTER);
  progress(1_000_000_000, 3_000_000_000);
  // Spread the samples 4s apart: wide enough for a speed estimate, with a
  // second of slack inside the 5s window so wall-clock time elapsing before
  // the next refresh cannot age the first sample out on a slow CI runner.
  const now = Date.now();
  internals.downloadSamples = [
    { t: now - 4000, bytes: 600_000_000 },
    { t: now, bytes: 1_000_000_000 },
  ];
  // A further progress event refreshes the stats line from those samples.
  progress(1_000_000_000, 3_000_000_000);
  const body = rendered(picker);
  assert.match(body, /95 MiB\/s/);
  assert.match(body, /~\d+(s| min) left/);
});

test("esc during a download stops it immediately and keeps progress", async (t) => {
  const { picker, internals, signal, progress, reject } = controlledPicker();
  t.after(() => picker.dispose());
  picker.handleInput(ENTER);
  progress(1_000_000_000, 3_000_000_000);
  assert.match(rendered(picker), /stop \(keeps progress\)/);

  picker.handleInput(ESC);
  assert.equal(signal().aborted, true);
  assert.match(rendered(picker), /Stopping…/);

  // The aborted activation rejects; the picker returns to the list and
  // explains that the progress was kept.
  reject(new Error("aborted"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(internals.mode, "models");
  const body = rendered(picker);
  assert.match(body, /67 models/);
  assert.match(body, /Download stopped — progress saved/);
});

test("a finished download reports success and marks the model downloaded", async (t) => {
  const { picker, internals, resolve } = controlledPicker();
  t.after(() => picker.dispose());
  picker.handleInput(ENTER);
  resolve("/tmp/model.bin");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(internals.mode, "models");
  const body = rendered(picker);
  assert.match(body, /✓ Downloaded and selected /);
  assert.match(body, /Current: /);
  assert.ok(internals.cachedById.size > 0);
});

test("advance post-activation policy completes immediately", async (t) => {
  const { picker, resolve, result } = controlledPicker("advance");
  t.after(() => picker.dispose());
  picker.handleInput(ENTER);
  resolve("/tmp/model.bin");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  assert.deepEqual(result(), { type: "complete" });
});

test("advance policy also skips an extra pane for a downloaded model", async (t) => {
  const { picker, internals, resolve, result } = controlledPicker("advance");
  t.after(() => picker.dispose());
  const highlighted = internals.filtered[0]!;
  internals.cachedById.set(highlighted.id, { path: "/tmp/model.bin" });
  internals.refresh();

  picker.handleInput(ENTER);
  resolve("/tmp/model.bin");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  assert.deepEqual(result(), { type: "complete" });
  assert.doesNotMatch(stripAnsi(rendered(picker)), /Model ready/);
});

test("size and downloaded columns stay aligned and rows never wrap", (t) => {
  const { picker, internals } = controlledPicker();
  t.after(() => picker.dispose());
  const byName = new Map(CATALOG_MODELS.map((model) => [model.name, model]));
  // Cached sizes spanning 2-3 digits and MiB/GiB so misalignment would show.
  for (const name of ["Moonshine Streaming Tiny", "Parakeet Unified EN 0.6B", "Voxtral Small 24B"]) {
    internals.cachedById.set(byName.get(name)!.id, { path: "x" });
  }
  internals.refresh();
  const strip = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");
  for (const width of [80, 100]) {
    const lines = picker.render(width).map(strip);
    const rows = lines.filter((line) => / [MG]iB/.test(line) && !/·|download/.test(line));
    // Ten visible models, each on a single unwrapped line.
    assert.equal(rows.length, 10, `model rows at width ${width}`);
    const checkColumns = new Set(
      rows.filter((line) => line.includes("✓")).map((line) => line.indexOf("✓")),
    );
    assert.equal(checkColumns.size, 1, `✓ column drifts at width ${width}`);
    // Sizes are right-aligned: every size ends at the same column.
    const sizeEnds = new Set(rows.map((line) => line.search(/ [MG]iB/) + 4));
    assert.equal(sizeEnds.size, 1, `size column drifts at width ${width}`);
    for (const line of lines) {
      assert.ok(visibleLength(line) <= width, `overflowing line at width ${width}: ${line}`);
    }
  }
});

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function visibleLength(line: string): number {
  return stripAnsi(line).length;
}

test("language picker shows tab-to-continue inline on the action row", () => {
  const picker = new LanguagePicker(
    testTui(),
    testTheme(),
    keybindings(),
    ["en"],
    "skip for now",
    () => undefined,
  );

  const actionLine = picker.render(80).map(stripAnsi).find((line) => /tab\s+Continue/i.test(line));
  assert.ok(actionLine);
  assert.doesNotMatch(actionLine, /move|select|skip for now/);
});

test("transcription language picker keeps auto detect, codes, and preferred stars", () => {
  const model = CATALOG_MODELS.find(
    (candidate) => candidate.capabilities.languageDetection && candidate.languages.length > 5,
  )!;
  let chosen: string | undefined;
  const picker = createTranscriptionLanguagePicker(
    testTui(),
    testTheme(),
    keybindings(),
    model,
    "auto",
    ["en"],
    (language) => {
      chosen = language;
    },
  );
  const lines = picker.render(80);
  assert.ok(lines.some((line) => line.includes("→ ● Auto detect")));
  // Multiple English variants keep their regional labels and codes.
  assert.ok(lines.some((line) => /English\s+en-US  ★/.test(line)));
  assert.ok(lines.some((line) => line.includes("★ preferred language")));
  picker.handleInput(ENTER);
  assert.equal(chosen, "auto");
});

test("only an exact-hash partial switches the footer to resume", (t) => {
  const { picker, internals } = controlledPicker();
  t.after(() => picker.dispose());
  const highlighted = internals.filtered[0]!;
  const blobsDirectory = join(
    process.env.HF_HUB_CACHE!,
    getRepoFolderName({ name: highlighted.repository, type: "model" }),
    "blobs",
  );
  mkdirSync(blobsDirectory, { recursive: true });

  // A stale partial from another revision must not promise a resume.
  const stalePath = join(blobsDirectory, `${"0".repeat(64)}.incomplete`);
  writeFileSync(stalePath, Buffer.alloc(1024, 1));
  t.after(() => rmSync(stalePath, { force: true }));
  internals.refresh();
  assert.match(rendered(picker), /download \d/);
  assert.doesNotMatch(rendered(picker), /resume download/);

  const partialPath = join(blobsDirectory, `${highlighted.sha256}.incomplete`);
  writeFileSync(partialPath, Buffer.alloc(1024, 1));
  t.after(() => rmSync(partialPath, { force: true }));
  internals.refresh();
  assert.match(rendered(picker), /resume download/);
});
