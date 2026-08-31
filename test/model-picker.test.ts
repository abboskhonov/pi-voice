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
import { CatalogModelPicker } from "../src/model-picker.js";
import { CATALOG_MODELS, type CatalogModel } from "../src/catalog.js";

initTheme("dark");

const ESC = "\u001b";
const ENTER = "\r";
const DOWN = "\u001b[B";

function testTheme(): ExtensionContext["ui"]["theme"] {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
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
  refresh: () => void;
};

/** A picker in which no model is cached, with a manually driven activation. */
function controlledPicker(): {
  picker: CatalogModelPicker;
  internals: PickerInternals;
  resolve: (path: string) => void;
  reject: (error: unknown) => void;
  signal: () => AbortSignal;
  progress: (downloaded: number, total: number) => void;
} {
  let options: ActivationOptions | undefined;
  let resolveActivation!: (value: { path: string }) => void;
  let rejectActivation!: (error: unknown) => void;
  const picker = new CatalogModelPicker(
    testTui(),
    testTheme(),
    keybindings(),
    ["en"],
    undefined,
    () => undefined,
    (_model: CatalogModel, activationOptions: ActivationOptions) => {
      options = activationOptions;
      return new Promise<{ path: string }>((resolvePromise, rejectPromise) => {
        resolveActivation = resolvePromise;
        rejectActivation = rejectPromise;
      });
    },
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
  // Spread the samples 5s apart so the speed estimate becomes available.
  const now = Date.now();
  internals.downloadSamples = [
    { t: now - 5000, bytes: 500_000_000 },
    { t: now, bytes: 1_000_000_000 },
  ];
  // A further progress event refreshes the stats line from those samples.
  progress(1_000_000_000, 3_000_000_000);
  const body = rendered(picker);
  assert.match(body, /95 MiB\/s/);
  assert.match(body, /~\d+(s| min) left/);
});

test("esc during a download asks before stopping, and stop aborts", async (t) => {
  const { picker, internals, signal, progress, reject } = controlledPicker();
  t.after(() => picker.dispose());
  picker.handleInput(ENTER);
  progress(1_000_000_000, 3_000_000_000);

  picker.handleInput(ESC);
  assert.equal(internals.mode, "confirm-cancel");
  const prompt = rendered(picker);
  assert.match(prompt, /Stop downloading .*\?/);
  assert.match(prompt, /stopping discards it/);
  assert.match(prompt, /→ Keep downloading/);

  // Enter on the default choice keeps the download running.
  picker.handleInput(ENTER);
  assert.equal(internals.mode, "downloading");
  assert.equal(signal().aborted, false);

  // Esc again, move to "Stop download", confirm.
  picker.handleInput(ESC);
  picker.handleInput(DOWN);
  assert.match(rendered(picker), /→ Stop download/);
  picker.handleInput(ENTER);
  assert.equal(signal().aborted, true);
  assert.equal(internals.mode, "downloading");
  assert.match(rendered(picker), /Cancelling…/);

  // The aborted activation rejects; the picker returns to the list quietly.
  reject(new Error("aborted"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(internals.mode, "models");
  assert.match(rendered(picker), /67 models/);
});

test("esc in the stop prompt keeps downloading", (t) => {
  const { picker, internals, signal } = controlledPicker();
  t.after(() => picker.dispose());
  picker.handleInput(ENTER);
  picker.handleInput(ESC);
  assert.equal(internals.mode, "confirm-cancel");
  picker.handleInput(ESC);
  assert.equal(internals.mode, "downloading");
  assert.equal(signal().aborted, false);
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

function visibleLength(line: string): number {
  return line.replace(/\u001b\[[0-9;]*m/g, "").length;
}
