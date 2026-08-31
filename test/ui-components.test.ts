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
