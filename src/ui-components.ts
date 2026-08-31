import {
  DynamicBorder,
  keyHint,
  rawKeyHint,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Spacer,
  Text,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";

type UiTheme = ExtensionContext["ui"]["theme"];

export const PANEL_PADDING = 1;
export const LIST_PADDING = 1;

export function panelBorder(theme: UiTheme): DynamicBorder {
  return new DynamicBorder((text: string) => theme.fg("border", text));
}

export type SingleSelectChoice<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

function selectedWindow(length: number, selected: number, maximum: number): [number, number] {
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(maximum / 2), length - maximum),
  );
  return [start, Math.min(start + maximum, length)];
}

/** Pi-native single-choice picker with optional fuzzy search and a current-value marker. */
export class SingleSelectPicker<T extends string> extends Container implements Focusable {
  private readonly search = new Input();
  private readonly titleText: Text;
  private readonly subtitleText: Text | undefined;
  private readonly list = new Container();
  private readonly detail = new Text("", PANEL_PADDING, 0);
  private readonly footer = new Text("", PANEL_PADDING, 0);
  private filtered: SingleSelectChoice<T>[];
  private selectedIndex: number;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value && Boolean(this.options.searchable);
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly choices: readonly SingleSelectChoice<T>[],
    private readonly current: T,
    private readonly options: {
      title: string;
      subtitle?: string;
      searchable?: boolean;
      maximumVisible?: number;
      cancelLabel?: string;
      /** Extra footer legend, appended after the ● current marker. */
      legend?: string;
      /** Custom row body after the cursor and ● markers; handles its own active styling. */
      renderLabel?: (choice: SingleSelectChoice<T>, active: boolean) => string;
    },
    private readonly done: (value: T | undefined) => void,
  ) {
    super();
    this.filtered = [...choices];
    this.selectedIndex = Math.max(
      0,
      this.filtered.findIndex((choice) => choice.value === current),
    );

    this.titleText = new Text(
      theme.fg("accent", theme.bold(options.title)),
      PANEL_PADDING,
      0,
    );
    this.subtitleText = options.subtitle
      ? new Text(theme.fg("muted", options.subtitle), PANEL_PADDING, 0)
      : undefined;

    this.addChild(panelBorder(theme));
    this.addChild(new Spacer(1));
    this.addChild(this.titleText);
    if (this.subtitleText) this.addChild(this.subtitleText);
    this.addChild(new Spacer(1));
    if (options.searchable) {
      const searchBox = new Box(LIST_PADDING, 0);
      searchBox.addChild(this.search);
      this.addChild(searchBox);
      this.addChild(new Spacer(1));
    }
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    if (choices.some((choice) => choice.description)) {
      this.addChild(this.detail);
      this.addChild(new Spacer(1));
    }
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(panelBorder(theme));
    this.refresh();
  }

  private refresh(): void {
    const query = this.search.getValue().trim();
    this.filtered = query
      ? fuzzyFilter([...this.choices], query, (choice) =>
          `${choice.label} ${choice.value} ${choice.description ?? ""}`,
        )
      : [...this.choices];
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filtered.length - 1),
    );
    this.list.clear();

    if (this.filtered.length === 0) {
      this.list.addChild(
        new Text(this.theme.fg("muted", "  No matching choices"), LIST_PADDING, 0),
      );
      this.detail.setText("");
    } else {
      const maximum = this.options.maximumVisible ?? 10;
      const [start, end] = selectedWindow(
        this.filtered.length,
        this.selectedIndex,
        maximum,
      );
      for (let index = start; index < end; index += 1) {
        const choice = this.filtered[index]!;
        const active = index === this.selectedIndex;
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const current = choice.value === this.current
          ? this.theme.fg("accent", "● ")
          : "  ";
        const label = this.options.renderLabel
          ? this.options.renderLabel(choice, active)
          : active
            ? this.theme.fg("accent", choice.label)
            : choice.label;
        this.list.addChild(new Text(`${prefix}${current}${label}`, LIST_PADDING, 0));
      }
      if (start > 0 || end < this.filtered.length) {
        this.list.addChild(
          new Text(
            this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`),
            LIST_PADDING,
            0,
          ),
        );
      }
      this.detail.setText(
        this.filtered[this.selectedIndex]?.description
          ? this.theme.fg("dim", this.filtered[this.selectedIndex]!.description!)
          : "",
      );
    }

    const shown = query
      ? `${this.filtered.length}/${this.choices.length} matching choices`
      : `${this.choices.length} choices`;
    const legend = [
      `${this.theme.fg("accent", "●")} ${this.theme.fg("dim", "current")}`,
      this.options.legend,
    ]
      .filter((value): value is string => Boolean(value))
      .join("  ");
    this.footer.setText(
      `${this.theme.fg("dim", shown)}  ${legend}\n${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", query ? "clear search" : (this.options.cancelLabel ?? "back"))}`,
    );
    this.tui.requestRender();
  }

  override invalidate(): void {
    super.invalidate();
    this.titleText.setText(
      this.theme.fg("accent", this.theme.bold(this.options.title)),
    );
    if (this.subtitleText && this.options.subtitle) {
      this.subtitleText.setText(this.theme.fg("muted", this.options.subtitle));
    }
    this.refresh();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.filtered[this.selectedIndex];
      if (selected) this.done(selected.value);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = Math.max(
          0,
          this.choices.findIndex((choice) => choice.value === this.current),
        );
        this.refresh();
      } else {
        this.done(undefined);
      }
      return;
    }

    if (this.options.searchable) {
      this.search.handleInput(data);
      this.selectedIndex = 0;
      this.refresh();
    }
  }
}
