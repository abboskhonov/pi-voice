import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SingleSelectPicker } from "../src/ui-components.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

test("single-select picker marks the saved value separately from focus", () => {
  let selected: string | undefined;
  const picker = new SingleSelectPicker(
    testTui(),
    testTheme(),
    keybindings(),
    [
      { value: "alpha", label: "Alpha" },
      { value: "beta", label: "Beta" },
      { value: "gamma", label: "Gamma" },
    ],
    "beta",
    { title: "Choose one" },
    (value) => {
      selected = value;
    },
  );

  assert.ok(picker.render(80).some((line) => line.includes("→ ● Beta")));
  picker.handleInput("\u001b[B");
  const moved = picker.render(80);
  assert.ok(moved.some((line) => line.includes("→   Gamma")));
  assert.ok(moved.some((line) => line.includes("  ● Beta")));
  assert.ok(moved.some((line) => line.includes("● current")));
  picker.handleInput("\r");
  assert.equal(selected, "gamma");
});

test("single-select picker can act as a menu without a current marker", () => {
  let selected: string | undefined;
  const picker = new SingleSelectPicker(
    testTui(),
    testTheme(),
    keybindings(),
    [{ value: "model", label: "Model" }],
    undefined,
    { title: "Settings", cancelLabel: "close" },
    (value) => {
      selected = value;
    },
  );

  const rendered = picker.render(80).join("\n");
  assert.match(rendered, /→ Model/);
  assert.doesNotMatch(rendered, /●|current/);
  picker.handleInput("\r");
  assert.equal(selected, "model");
});

test("single-select picker clears search before going back and respects width", () => {
  let closes = 0;
  const picker = new SingleSelectPicker(
    testTui(),
    testTheme(),
    keybindings(),
    [
      { value: "alpha", label: "Alpha", description: "First choice" },
      { value: "beta", label: "Beta", description: "Second choice" },
    ],
    "alpha",
    { title: "Choose one", searchable: true },
    (value) => {
      if (value === undefined) closes += 1;
    },
  );

  picker.handleInput("b");
  assert.ok(picker.render(40).some((line) => line.includes("Beta")));
  assert.ok(!picker.render(40).some((line) => line.includes("● Alpha")));

  picker.handleInput("\u001b");
  assert.equal(closes, 0);
  assert.ok(picker.render(40).some((line) => line.includes("→ ● Alpha")));

  picker.handleInput("\u001b");
  assert.equal(closes, 1);
  assert.ok(picker.render(40).every((line) => visibleWidth(line) <= 40));
});

test("single-select picker shrinks its window to fit a 24-row terminal", () => {
  const choices = Array.from({ length: 30 }, (_, index) => ({
    value: `choice-${index}`,
    label: `Choice ${index}`,
    description: `Description for choice ${index}`,
  }));
  const build = (rows?: number) =>
    new SingleSelectPicker(
      testTui(rows),
      testTheme(),
      keybindings(),
      choices,
      "choice-0",
      { title: "Choose one", searchable: true },
      () => {},
    );
  const listRows = (lines: string[]) =>
    lines.filter((line) => line.includes("Choice ")).length;

  const short = build(24).render(80);
  // 24 terminal rows minus the two host footer lines.
  assert.ok(short.length <= 22, `pane is ${short.length} rows`);
  assert.ok(listRows(short) < 10);
  // The chrome survives the shrink: title and key hints stay on screen.
  assert.match(short.join("\n"), /Choose one/);
  assert.match(short.join("\n"), /navigate/);

  // A tall terminal keeps the default ten-row window.
  assert.equal(listRows(build(40).render(80)), 10);
  // Without terminal size information the cap also applies unchanged.
  assert.equal(listRows(build().render(80)), 10);
});
