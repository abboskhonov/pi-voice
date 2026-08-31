import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  SettingsList,
  Spacer,
  Text,
  type Component,
  type KeybindingsManager,
  type SettingItem,
  type TUI,
} from "@earendil-works/pi-tui";
import { getAvailableMicrophones, testMicrophonePermission } from "./audio.js";
import { displayLanguage, getCatalogModel } from "./catalog.js";
import { chineseOutputSummary, isChineseLanguage } from "./chinese.js";
import { createModelActivation } from "./model-activation.js";
import {
  CatalogModelPicker,
  createTranscriptionLanguagePicker,
  LanguagePicker,
  transcriptionLanguageSummary,
  type CatalogModelPickerResult,
  type LanguageSelection,
} from "./model-picker.js";
import {
  settingsForModel,
  writeSettings,
  type ChineseOutput,
  type MicrophoneSetting,
  type TranscribeSettings,
} from "./settings.js";
import { displayShortcut } from "./shortcut-core.js";
import { createShortcutPicker } from "./shortcuts.js";
import {
  PANEL_PADDING,
  SingleSelectPicker,
  panelBorder,
  type SingleSelectChoice,
} from "./ui-components.js";

const MACOS_MICROPHONE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

type UiTheme = ExtensionContext["ui"]["theme"];

function preferredLanguagesSummary(languages: readonly string[]): string {
  const names = languages.map(displayLanguage);
  const visible = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${visible} +${names.length - 3}` : visible;
}

function microphoneSummary(microphone: MicrophoneSetting): string {
  if (microphone.type === "system-default") return "System default";
  const duplicate = microphone.occurrence > 0 ? ` · device ${microphone.occurrence + 1}` : "";
  return `${microphone.name}${duplicate}`;
}

function microphonesEqual(left: MicrophoneSetting, right: MicrophoneSetting): boolean {
  return (
    left.type === right.type &&
    (left.type === "system-default" ||
      (right.type === "device" &&
        left.name === right.name &&
        left.occurrence === right.occurrence))
  );
}

async function saveUpdatedSettings(
  ctx: ExtensionContext,
  configured: TranscribeSettings,
  updated: TranscribeSettings,
  successMessage?: string,
): Promise<boolean> {
  try {
    await writeSettings(updated);
    Object.assign(configured, updated);
    if (successMessage) ctx.ui.notify(successMessage, "info");
    return true;
  } catch (error) {
    ctx.ui.notify(
      `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return false;
  }
}

function microphoneChoices(
  devices: readonly string[],
  current: MicrophoneSetting,
): {
  choices: SingleSelectChoice<string>[];
  currentValue: string;
  byValue: Map<string, MicrophoneSetting>;
} {
  const totals = new Map<string, number>();
  for (const name of devices) totals.set(name, (totals.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const byValue = new Map<string, MicrophoneSetting>();
  byValue.set("system-default", { type: "system-default" });
  const choices: SingleSelectChoice<string>[] = [
    {
      value: "system-default",
      label: "System default",
      description: "Follow the input device selected by the operating system",
    },
  ];
  let currentValue = "system-default";
  for (const [index, name] of devices.entries()) {
    const occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
    const microphone: MicrophoneSetting = { type: "device", name, occurrence };
    const value = `device-${index}`;
    const label = (totals.get(name) ?? 0) > 1 ? `${name} · device ${occurrence + 1}` : name;
    choices.push({ value, label });
    byValue.set(value, microphone);
    if (microphonesEqual(current, microphone)) currentValue = value;
  }
  return { choices, currentValue, byValue };
}

type SubmenuComponent = Component & Partial<Focusable> & { dispose?: () => void };

/** SettingsList keeps its active submenu private, so mirror focus for nested Inputs. */
class FocusableSettingsList extends SettingsList implements Focusable {
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncSubmenuFocus();
  }

  get showingSubmenu(): boolean {
    return this.getActiveSubmenu() !== null;
  }

  override handleInput(data: string): void {
    super.handleInput(data);
    this.syncSubmenuFocus();
  }

  private getActiveSubmenu(): Partial<Focusable> | null {
    return Reflect.get(this, "submenuComponent") as Partial<Focusable> | null;
  }

  private syncSubmenuFocus(): void {
    const submenu = this.getActiveSubmenu();
    if (submenu && "focused" in submenu) submenu.focused = this._focused;
  }
}

/** Keeps the rich model/language workflow inside a SettingsList submenu. */
class ModelSettingsSubmenu extends Container implements Focusable {
  private active: SubmenuComponent | undefined;
  private _focused = false;
  private selectedDuringSession = false;
  private disposed = false;
  private readonly activation: ReturnType<typeof createModelActivation>;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.active && "focused" in this.active) this.active.focused = value;
  }

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly configured: TranscribeSettings,
    private readonly onUpdated: () => void,
    private readonly done: (value?: string) => void,
  ) {
    super();
    this.activation = createModelActivation({
      buildSettings: (model, path) =>
        settingsForModel(model.id, path, {
          shortcut: this.configured.shortcut,
          preferredLanguages: this.configured.preferredLanguages,
          transcriptionLanguage: this.configured.transcriptionLanguage,
          chineseOutput: this.configured.chineseOutput,
          microphone: this.configured.microphone,
        }),
      onCommitted: (settings) => {
        Object.assign(this.configured, settings);
        this.selectedDuringSession = true;
        this.onUpdated();
      },
    });
    this.showModels();
  }

  private setActive(component: SubmenuComponent): void {
    this.active?.dispose?.();
    this.active = component;
    if ("focused" in component) component.focused = this._focused;
    this.clear();
    this.addChild(component);
    this.tui.requestRender();
  }

  private showModels(): void {
    const picker = new CatalogModelPicker(
      this.tui,
      this.theme,
      this.keybindings,
      this.configured.preferredLanguages,
      this.configured.model.id,
      (result) => void this.handleModelResult(result),
      this.activation.activate,
      {
        postActivation: "stay",
        activatedInFlow: this.selectedDuringSession,
      },
    );
    this.setActive(picker);
  }

  private async handleModelResult(
    result: CatalogModelPickerResult | undefined,
  ): Promise<void> {
    await this.activation.waitForCommits();
    if (this.disposed) return;
    if (result?.type === "change-languages") {
      this.showLanguages();
      return;
    }
    this.close();
  }

  private showLanguages(): void {
    const picker = new LanguagePicker(
      this.tui,
      this.theme,
      this.keybindings,
      this.configured.preferredLanguages,
      "back",
      (selection) => void this.handleLanguages(selection),
      false,
    );
    this.setActive(picker);
  }

  private async handleLanguages(selection: LanguageSelection | undefined): Promise<void> {
    if (selection) {
      const preferredLanguages = selection.languages;
      if (
        preferredLanguages.join("\0") !== this.configured.preferredLanguages.join("\0")
      ) {
        const updated = { ...this.configured, preferredLanguages };
        if (
          await saveUpdatedSettings(
            this.ctx,
            this.configured,
            updated,
            "Preferred languages saved",
          )
        ) {
          this.onUpdated();
        }
      }
    }
    if (!this.disposed) this.showModels();
  }

  private close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.dispose?.();
    this.done(getCatalogModel(this.configured.model.id)?.name ?? this.configured.model.id);
  }

  handleInput(data: string): void {
    this.active?.handleInput?.(data);
  }

  dispose(): void {
    this.disposed = true;
    this.active?.dispose?.();
  }
}

export async function openMacOSMicrophoneSettings(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (process.platform !== "darwin") return;
  const result = await pi.exec("open", [MACOS_MICROPHONE_SETTINGS_URL]);
  if (result.code === 0) {
    ctx.ui.notify(
      "Enable microphone access for your terminal app, then return to Pi and try recording. A terminal restart may be required.",
      "info",
    );
  } else {
    ctx.ui.notify(
      "Could not open System Settings. Open Privacy & Security → Microphone manually.",
      "error",
    );
  }
}

export async function offerMacOSPermissionHelp(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (process.platform !== "darwin") return;
  const openSettings = await ctx.ui.confirm(
    "Microphone access",
    "Microphone capture failed. Open macOS Privacy & Security → Microphone settings?",
  );
  if (openSettings) await openMacOSMicrophoneSettings(pi, ctx);
}

export async function showSettingsMenu(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configured: TranscribeSettings,
  registeredShortcut: string,
): Promise<boolean> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("pi-transcribe settings require the interactive TUI", "error");
    return false;
  }

  const micResult = await testMicrophonePermission();
  let devices: string[] = [];
  try {
    devices = getAvailableMicrophones();
  } catch (error) {
    ctx.ui.notify(
      `Could not list microphones: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }

  return ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
    let reload = configured.shortcut !== registeredShortcut;
    let settingsList!: FocusableSettingsList;

    const updateDisplayedValues = (): void => {
      const model = getCatalogModel(configured.model.id)!;
      settingsList.updateValue(
        "preferred-languages",
        preferredLanguagesSummary(configured.preferredLanguages),
      );
      settingsList.updateValue("model", model.name);
      settingsList.updateValue(
        "transcription-language",
        transcriptionLanguageSummary(configured.transcriptionLanguage, model),
      );
      settingsList.updateValue("chinese-output", chineseOutputSummary(configured.chineseOutput));
      settingsList.updateValue("microphone", microphoneSummary(configured.microphone));
      settingsList.updateValue("shortcut", displayShortcut(configured.shortcut));
      tui.requestRender();
    };

    // Shared submenu epilogue: an unchanged value just closes; a changed one
    // is saved, reflected in the list, and then closes.
    const commitSetting = (
      close: (value?: string) => void,
      options: {
        summary: string;
        unchanged: boolean;
        patch: Partial<TranscribeSettings>;
        message?: string;
        onSaved?: () => void;
      },
    ): void => {
      if (options.unchanged) {
        close(options.summary);
        return;
      }
      void saveUpdatedSettings(
        ctx,
        configured,
        { ...configured, ...options.patch },
        options.message,
      ).then((saved) => {
        if (!saved) return;
        options.onSaved?.();
        updateDisplayedValues();
        close(options.summary);
      });
    };

    const model = getCatalogModel(configured.model.id)!;
    const chineseChoices: SingleSelectChoice<ChineseOutput>[] = [
      {
        value: "simplified",
        label: "Simplified",
        description: "Convert Chinese transcripts to simplified characters",
      },
      {
        value: "traditional-taiwan",
        label: "Traditional (Taiwan)",
        description: "Use traditional characters and Taiwan conventions",
      },
      {
        value: "traditional-hong-kong",
        label: "Traditional (Hong Kong)",
        description: "Use traditional characters and Hong Kong conventions",
      },
    ];

    // Character-style conversion only matters when Chinese can appear in
    // transcripts; hide the setting otherwise.
    const showChineseOutput =
      isChineseLanguage(configured.transcriptionLanguage) ||
      configured.preferredLanguages.some(isChineseLanguage);
    const chineseOutputItem: SettingItem = {
      id: "chinese-output",
      label: "Chinese output",
      currentValue: chineseOutputSummary(configured.chineseOutput),
      description: "Character style used for Chinese transcripts",
      submenu: (_currentValue, close) =>
        new SingleSelectPicker(
          tui,
          theme,
          keybindings,
          chineseChoices,
          configured.chineseOutput,
          { title: "Choose Chinese output", cancelLabel: "back" },
          (chineseOutput) => {
            if (!chineseOutput) {
              close();
              return;
            }
            const summary = chineseOutputSummary(chineseOutput);
            commitSetting(close, {
              summary,
              unchanged: chineseOutput === configured.chineseOutput,
              patch: { chineseOutput },
              message: `Chinese output saved as ${summary}`,
            });
          },
        ),
    };

    const items: SettingItem[] = [
      {
        id: "preferred-languages",
        label: "Preferred languages",
        currentValue: preferredLanguagesSummary(configured.preferredLanguages),
        description: "Languages you speak, used to rank and recommend transcription models",
        submenu: (_currentValue, close) =>
          new LanguagePicker(
            tui,
            theme,
            keybindings,
            configured.preferredLanguages,
            "back",
            (selection) => {
              if (!selection) {
                close();
                return;
              }
              commitSetting(close, {
                summary: preferredLanguagesSummary(selection.languages),
                unchanged:
                  selection.languages.join("\0") ===
                  configured.preferredLanguages.join("\0"),
                patch: { preferredLanguages: selection.languages },
                message: "Preferred languages saved",
              });
            },
            false,
          ),
      },
      {
        id: "model",
        label: "Model",
        currentValue: model.name,
        description: "Local speech-recognition model; audio never leaves this machine",
        submenu: (_currentValue, close) =>
          new ModelSettingsSubmenu(
            ctx,
            tui,
            theme,
            keybindings,
            configured,
            updateDisplayedValues,
            close,
          ),
      },
      {
        id: "transcription-language",
        label: "Transcription language",
        currentValue: transcriptionLanguageSummary(configured.transcriptionLanguage, model),
        description: "Language expected in recordings, or automatic detection when supported",
        submenu: (_currentValue, close) => {
          const currentModel = getCatalogModel(configured.model.id)!;
          return createTranscriptionLanguagePicker(
            tui,
            theme,
            keybindings,
            currentModel,
            configured.transcriptionLanguage,
            configured.preferredLanguages,
            (transcriptionLanguage) => {
              if (!transcriptionLanguage) {
                close();
                return;
              }
              const summary = transcriptionLanguageSummary(
                transcriptionLanguage,
                currentModel,
              );
              commitSetting(close, {
                summary,
                unchanged: transcriptionLanguage === configured.transcriptionLanguage,
                patch: { transcriptionLanguage },
                message: `Transcription language saved as ${summary}`,
              });
            },
          );
        },
      },
      ...(showChineseOutput ? [chineseOutputItem] : []),
      {
        id: "microphone",
        label: "Microphone",
        currentValue: microphoneSummary(configured.microphone),
        description: "Input device used for dictation",
        submenu: (_currentValue, close) => {
          const { choices, currentValue, byValue } = microphoneChoices(
            devices,
            configured.microphone,
          );
          return new SingleSelectPicker(
            tui,
            theme,
            keybindings,
            choices,
            currentValue,
            {
              title: "Choose microphone input",
              searchable: choices.length > 8,
              cancelLabel: "back",
            },
            (value) => {
              if (!value) {
                close();
                return;
              }
              const microphone = byValue.get(value);
              if (!microphone) return;
              const summary = microphoneSummary(microphone);
              commitSetting(close, {
                summary,
                unchanged: microphonesEqual(microphone, configured.microphone),
                patch: { microphone },
                message: `Microphone saved as ${summary}`,
              });
            },
          );
        },
      },
      {
        id: "shortcut",
        label: "Shortcut",
        currentValue: displayShortcut(configured.shortcut),
        description: "Terminal shortcut that starts and stops microphone dictation",
        submenu: (_currentValue, close) =>
          createShortcutPicker(
            tui,
            theme,
            keybindings,
            configured.shortcut,
            (shortcut) => {
              if (!shortcut) {
                close();
                return;
              }
              commitSetting(close, {
                summary: displayShortcut(shortcut),
                unchanged: shortcut === configured.shortcut,
                patch: { shortcut },
                onSaved: () => {
                  reload = shortcut !== registeredShortcut;
                  ctx.ui.notify(
                    `Shortcut saved as ${displayShortcut(shortcut)}. It will apply when settings close; other open Pi processes must be reloaded separately.`,
                    "info",
                  );
                },
              });
            },
          ),
      },
    ];

    if (micResult.status === "denied" && process.platform === "darwin") {
      items.unshift({
        id: "microphone-access",
        label: "Microphone access",
        currentValue: "Denied — open System Settings",
        description: "Grant microphone access to the terminal application running Pi",
        values: ["Denied — open System Settings"],
      });
    }

    const nativeTheme = getSettingsListTheme();
    settingsList = new FocusableSettingsList(
      items,
      10,
      {
        ...nativeTheme,
        hint: (text) => nativeTheme.hint(text.replace("Esc to cancel", "Esc to close")),
      },
      (id) => {
        if (id === "microphone-access") void openMacOSMicrophoneSettings(pi, ctx);
      },
      () => done(reload),
    );

    let micLine: string;
    if (micResult.status === "granted") {
      micLine = `Microphone: ${theme.fg("success", "✓ Access granted")}`;
    } else if (micResult.status === "denied") {
      micLine = `Microphone: ${theme.fg("error", "✗ Access denied")}`;
    } else if (micResult.status === "not-determined") {
      micLine = `Microphone: ${theme.fg("warning", "⚠ Not yet requested")} — first recording will prompt for access`;
    } else {
      micLine = `Microphone: ${theme.fg("warning", "⚠")} ${micResult.message}`;
    }

    const container = new Container();
    container.addChild(panelBorder(theme));
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("pi-transcribe settings")), PANEL_PADDING, 0),
    );
    container.addChild(new Text(micLine, PANEL_PADDING, 0));
    container.addChild(new Spacer(1));
    container.addChild(settingsList);
    container.addChild(new Spacer(1));
    container.addChild(panelBorder(theme));

    return {
      get focused(): boolean {
        return settingsList.focused;
      },
      set focused(value: boolean) {
        settingsList.focused = value;
      },
      // SettingsList replaces only its own rows when a submenu opens. Render
      // that submenu as the whole pane so we do not leave the settings frame
      // and microphone summary wrapped around a second bordered panel.
      render: (width) =>
        settingsList.showingSubmenu
          ? settingsList.render(width)
          : container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        settingsList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
