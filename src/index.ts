import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import {
  CAPTURE_SAMPLE_RATE,
  MicrophoneCapture,
  MicrophoneUnavailableError,
  testMicrophonePermission,
} from "./audio.js";
import { registerFileTranscriptionTool } from "./file-transcription.js";
import { runModelSelection, runOnboarding } from "./onboarding.js";
import {
  readSettings,
  readShortcutForRegistration,
  type TranscribeSettings,
} from "./settings.js";
import {
  offerMacOSPermissionHelp,
  openMacOSMicrophoneSettings,
  showSettingsMenu,
} from "./settings-menu.js";
import { displayShortcut } from "./shortcuts.js";
import { TranscribeCppBackend, type TranscriptionBackend } from "./transcription.js";
import {
  clearTranscribeWidget,
  RecordingMeter,
  showTranscribeStatus,
} from "./visualizer.js";

type ActiveRecording = {
  capture: MicrophoneCapture;
  backend: TranscriptionBackend;
  preparation: Promise<void>;
  meter: RecordingMeter;
};

function captureErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const permissionHelp =
    process.platform === "darwin" && !(error instanceof MicrophoneUnavailableError)
      ? " Check System Settings → Privacy & Security → Microphone for your terminal app."
      : "";
  return `Microphone capture failed: ${message}${permissionHelp}`;
}

function transcriptionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Local transcription failed: ${message}`;
}

export default function piTranscribe(pi: ExtensionAPI): void {
  const registeredShortcut = readShortcutForRegistration();
  let recording: ActiveRecording | undefined;
  let operation: Promise<void> | undefined;
  let transcriptionAbort: AbortController | undefined;
  let stopListening: (() => void) | undefined;
  let settings: TranscribeSettings | undefined;
  let settingsLoaded = false;
  let settingsReadWarning: string | undefined;
  let settingsWarningShown = false;
  let fileTranscriptionBusy: () => boolean = () => false;

  function rememberSettings(configured: TranscribeSettings): void {
    settings = configured;
    settingsLoaded = true;
    settingsReadWarning = undefined;
  }

  async function loadSettingsOnce(): Promise<void> {
    if (settingsLoaded) return;
    const result = await readSettings();
    settingsLoaded = true;
    settings = result.settings;
    settingsReadWarning = result.warning;
  }

  async function configureFirstRun(
    ctx: ExtensionContext,
  ): Promise<TranscribeSettings | undefined> {
    const configured = await runOnboarding(ctx, registeredShortcut);
    if (configured) rememberSettings(configured);
    return configured;
  }

  async function configureModel(
    ctx: ExtensionContext,
    previous: TranscribeSettings,
  ): Promise<TranscribeSettings | undefined> {
    const configured = await runModelSelection(ctx, {
      shortcut: previous.shortcut,
      preferredLanguages: previous.preferredLanguages,
      transcriptionLanguage: previous.transcriptionLanguage,
      chineseOutput: previous.chineseOutput,
      currentModelId: previous.model.id,
      microphone: previous.microphone,
    });
    if (configured) rememberSettings(configured);
    return configured;
  }

  async function ensureSettings(
    ctx: ExtensionContext,
  ): Promise<TranscribeSettings | undefined> {
    await loadSettingsOnce();
    if (settingsReadWarning && !settingsWarningShown) {
      settingsWarningShown = true;
      ctx.ui.notify(settingsReadWarning, "warning");
    }

    if (settings && existsSync(settings.model.path)) return settings;

    const previous = settings;
    if (settings) {
      ctx.ui.notify(
        `Configured model file is missing: ${settings.model.path}. Choose a model again; nothing will be downloaded without confirmation.`,
        "warning",
      );
      settings = undefined;
    }

    const configured = previous
      ? await configureModel(ctx, previous)
      : await configureFirstRun(ctx);
    if (configured) {
      ctx.ui.notify(
        `Setup complete. Press ${displayShortcut(registeredShortcut)} to start recording and press it again to transcribe. Use /transcribe for settings.`,
        "info",
      );
    }
    return configured;
  }

  async function requireConfiguredSettingsForTool(): Promise<TranscribeSettings> {
    await loadSettingsOnce();
    if (settingsReadWarning) {
      throw new Error(
        `${settingsReadWarning} Ask the user to run /transcribe in Pi's interactive TUI to configure a local model, then retry transcribe_file.`,
      );
    }
    if (!settings) {
      throw new Error(
        "pi-transcribe is not configured. Ask the user to run /transcribe in Pi's interactive TUI once to choose and download a local model, then retry transcribe_file.",
      );
    }
    if (!existsSync(settings.model.path)) {
      throw new Error(
        `The configured transcription model is missing: ${settings.model.path}. Ask the user to run /transcribe and choose a model again, then retry transcribe_file.`,
      );
    }
    return settings;
  }

  function listenForCancel(ctx: ExtensionContext): void {
    stopListening?.();
    if (!ctx.hasUI) return;
    stopListening = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "escape")) return;
      if (recording) {
        void runExclusive(ctx, () => cancelRecording(ctx));
        return { consume: true };
      }
      if (transcriptionAbort) {
        transcriptionAbort.abort();
        ctx.ui.notify("Transcription cancelled", "info");
        return { consume: true };
      }
    });
  }

  function clearCancelListener(): void {
    stopListening?.();
    stopListening = undefined;
  }

  async function cancelRecording(ctx: ExtensionContext): Promise<void> {
    const active = recording;
    if (!active) return;
    recording = undefined;
    active.meter.stop();
    try {
      await active.capture.stop();
    } catch {
      // Discarded either way.
    } finally {
      await active.backend.dispose().catch(() => undefined);
      clearCancelListener();
      ctx.ui.notify("Recording discarded", "info");
    }
  }

  async function stopAndTranscribe(ctx: ExtensionContext): Promise<void> {
    const active = recording!;
    recording = undefined;
    active.meter.stop();
    showTranscribeStatus(ctx, "finishing capture");

    try {
      let pcm: Float32Array;
      try {
        const audio = await active.capture.stop();
        pcm = audio.pcm;
      } catch (error) {
        ctx.ui.notify(captureErrorMessage(error), "error");
        if (!(error instanceof MicrophoneUnavailableError)) {
          await offerMacOSPermissionHelp(pi, ctx);
        }
        return;
      }

      const controller = new AbortController();
      transcriptionAbort = controller;

      try {
        showTranscribeStatus(ctx, "waiting for model", { cancelable: true });
        await active.preparation;

        showTranscribeStatus(ctx, "transcribing", { cancelable: true });
        const text = await active.backend.transcribe(pcm, controller.signal);
        const seconds = pcm.length / CAPTURE_SAMPLE_RATE;

        if (text) {
          ctx.ui.pasteToEditor(text);
          ctx.ui.notify(`Transcribed ${seconds.toFixed(1)}s of audio`, "info");
        } else {
          ctx.ui.notify(`No speech detected in ${seconds.toFixed(1)}s of audio`, "warning");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          ctx.ui.notify(transcriptionErrorMessage(error), "error");
        }
      } finally {
        if (transcriptionAbort === controller) transcriptionAbort = undefined;
      }
    } finally {
      showTranscribeStatus(ctx, "unloading model");
      try {
        await active.backend.dispose();
      } finally {
        clearCancelListener();
        clearTranscribeWidget(ctx);
      }
    }
  }

  async function startRecording(
    ctx: ExtensionContext,
    configured: TranscribeSettings,
  ): Promise<void> {
    if (process.platform === "darwin") {
      const micStatus = await testMicrophonePermission();
      if (micStatus.status === "denied") {
        const openSettings = await ctx.ui.confirm(
          "Microphone access",
          "Microphone access is denied in System Settings. Open Privacy & Security → Microphone settings?",
        );
        if (openSettings) await openMacOSMicrophoneSettings(pi, ctx);
        return;
      }
    }

    const capture = new MicrophoneCapture(
      configured.microphone.type === "device"
        ? {
            name: configured.microphone.name,
            occurrence: configured.microphone.occurrence,
          }
        : undefined,
    );
    const meter = new RecordingMeter();
    capture.onFrame = (frame) => meter.push(frame);
    meter.start(ctx);
    try {
      capture.start();
    } catch (error) {
      meter.stop();
      clearCancelListener();
      ctx.ui.notify(captureErrorMessage(error), "error");
      if (!(error instanceof MicrophoneUnavailableError)) {
        await offerMacOSPermissionHelp(pi, ctx);
      }
      return;
    }

    const backend = new TranscribeCppBackend(
      configured.model.path,
      configured.transcriptionLanguage === "auto"
        ? undefined
        : configured.transcriptionLanguage,
      configured.chineseOutput,
    );
    const preparation = backend.prepare();
    const active: ActiveRecording = { capture, backend, preparation, meter };
    recording = active;

    void preparation.then(
      () => {
        if (recording === active) active.meter.setModelState("ready");
      },
      () => {
        if (recording === active) active.meter.setModelState("failed");
      },
    );

    listenForCancel(ctx);
    ctx.ui.notify("Microphone recording started", "info");
  }

  async function toggleCapture(ctx: ExtensionContext): Promise<void> {
    if (recording) {
      await stopAndTranscribe(ctx);
      return;
    }

    const configured = await ensureSettings(ctx);
    if (configured) await startRecording(ctx, configured);
  }

  function runExclusive(
    ctx: ExtensionContext,
    task: () => Promise<void>,
  ): Promise<void> {
    if (fileTranscriptionBusy()) {
      ctx.ui.notify("A file transcription is already in progress", "warning");
      return Promise.resolve();
    }
    if (operation) {
      ctx.ui.notify("A pi-transcribe operation is already in progress", "warning");
      return operation;
    }

    const nextOperation = task().finally(() => {
      if (operation === nextOperation) operation = undefined;
    });
    operation = nextOperation;
    return nextOperation;
  }

  const fileTranscription = registerFileTranscriptionTool(pi, {
    getSettings: requireConfiguredSettingsForTool,
    isDictationBusy: () => Boolean(recording || operation),
  });
  fileTranscriptionBusy = fileTranscription.isBusy;

  pi.registerShortcut(
    registeredShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0],
    {
      description: "Toggle microphone transcription",
      handler: (ctx) => runExclusive(ctx, () => toggleCapture(ctx)),
    },
  );

  pi.registerCommand("transcribe", {
    description: "Open pi-transcribe settings",
    handler: async (_args, ctx) => {
      if (recording) {
        ctx.ui.notify(
          `Stop recording with ${displayShortcut(registeredShortcut)} before opening settings`,
          "warning",
        );
        return;
      }

      let reload = false;
      await runExclusive(ctx, async () => {
        const configured = await ensureSettings(ctx);
        if (!configured) return;
        reload = await showSettingsMenu(pi, ctx, configured, registeredShortcut);
      });
      if (reload) {
        await ctx.reload();
        return;
      }
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    transcriptionAbort?.abort();
    await Promise.all([
      operation?.catch(() => undefined),
      fileTranscription.shutdown().catch(() => undefined),
    ]);

    const active = recording;
    recording = undefined;
    clearCancelListener();
    if (active) {
      active.meter.stop();
      await active.capture.stop().catch(() => undefined);
      await active.backend.dispose();
    }
    clearTranscribeWidget(ctx);
  });
}
