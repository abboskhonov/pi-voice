import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import type { MicrophoneCapture } from "./audio.js";
import type { TranscribeSettings } from "./settings.js";
import { displayShortcut } from "./shortcut-core.js";
import {
  TranscriptionService,
  type DictationReservation,
} from "./transcription-service.js";
import type { RecordingMeter } from "./visualizer.js";

type ActiveRecording = {
  capture: MicrophoneCapture;
  reservation: DictationReservation;
  meter: RecordingMeter;
};

export type PiTranscribeRuntime = {
  readonly service: TranscriptionService;
  requireConfiguredSettingsForTool(): Promise<TranscribeSettings>;
  toggleCapture(ctx: ExtensionContext): Promise<void>;
  showSettings(ctx: ExtensionCommandContext): Promise<void>;
  replayOnboarding(ctx: ExtensionCommandContext): Promise<void>;
  shutdown(ctx: ExtensionContext): Promise<void>;
};

function isMicrophoneUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.name === "MicrophoneUnavailableError";
}

function captureErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const permissionHelp =
    process.platform === "darwin" && !isMicrophoneUnavailableError(error)
      ? " Check System Settings → Privacy & Security → Microphone for your terminal app."
      : "";
  return `Microphone capture failed: ${message}${permissionHelp}`;
}

function transcriptionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Local transcription failed: ${message}`;
}

export function createPiTranscribeRuntime(
  pi: ExtensionAPI,
  registeredShortcut: string,
): PiTranscribeRuntime {
  let recording: ActiveRecording | undefined;
  let operation: Promise<void> | undefined;
  let transcriptionAbort: AbortController | undefined;
  let stopListening: (() => void) | undefined;
  let settings: TranscribeSettings | undefined;
  let settingsLoaded = false;
  let settingsReadWarning: string | undefined;
  let settingsWarningShown = false;
  let audioModulePromise: Promise<typeof import("./audio.js")> | undefined;
  let visualizerModulePromise: Promise<typeof import("./visualizer.js")> | undefined;
  const transcriptionService = new TranscriptionService();

  function loadAudio(): Promise<typeof import("./audio.js")> {
    return (audioModulePromise ??= import("./audio.js"));
  }

  function loadVisualizer(): Promise<typeof import("./visualizer.js")> {
    return (visualizerModulePromise ??= import("./visualizer.js"));
  }

  function rememberSettings(configured: TranscribeSettings): void {
    settings = configured;
    settingsLoaded = true;
    settingsReadWarning = undefined;
  }

  async function loadSettingsOnce(): Promise<void> {
    if (settingsLoaded) return;
    const { readSettings } = await import("./settings.js");
    const result = await readSettings();
    settingsLoaded = true;
    settings = result.settings;
    settingsReadWarning = result.warning;
  }

  async function configureFirstRun(
    ctx: ExtensionContext,
  ): Promise<TranscribeSettings | undefined> {
    const { runOnboarding } = await import("./onboarding.js");
    const configured = await runOnboarding(ctx, registeredShortcut);
    if (configured) rememberSettings(configured);
    return configured;
  }

  async function configureModel(
    ctx: ExtensionContext,
    previous: TranscribeSettings,
  ): Promise<TranscribeSettings | undefined> {
    const { runModelSelection } = await import("./onboarding.js");
    const configured = await runModelSelection(ctx, {
      shortcut: previous.shortcut,
      preferredLanguages: previous.preferredLanguages,
      transcriptionLanguage: previous.transcriptionLanguage,
      chineseOutput: previous.chineseOutput,
      currentModelId: previous.model.id,
      microphone: previous.microphone,
      continueAfterSelection: true,
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
      active.reservation.cancel();
      clearCancelListener();
      ctx.ui.notify("Recording discarded", "info");
    }
  }

  async function stopAndTranscribe(ctx: ExtensionContext): Promise<void> {
    const { clearTranscribeWidget, showTranscribeStatus } = await loadVisualizer();
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
        active.reservation.cancel();
        ctx.ui.notify(captureErrorMessage(error), "error");
        if (!isMicrophoneUnavailableError(error)) {
          const { offerMacOSPermissionHelp } = await import("./settings-menu.js");
          await offerMacOSPermissionHelp(pi, ctx);
        }
        return;
      }

      const controller = new AbortController();
      transcriptionAbort = controller;

      try {
        showTranscribeStatus(ctx, "waiting to transcribe", { cancelable: true });
        const text = await active.reservation.submit(pcm, controller.signal);
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
      clearCancelListener();
      clearTranscribeWidget(ctx);
    }
  }

  async function startRecording(
    ctx: ExtensionContext,
    configured: TranscribeSettings,
  ): Promise<void> {
    const { MicrophoneCapture, testMicrophonePermission } = await loadAudio();
    if (process.platform === "darwin") {
      const micStatus = await testMicrophonePermission();
      if (micStatus.status === "denied") {
        const openSettings = await ctx.ui.confirm(
          "Microphone access",
          "Microphone access is denied in System Settings. Open Privacy & Security → Microphone settings?",
        );
        if (openSettings) {
          const { openMacOSMicrophoneSettings } = await import("./settings-menu.js");
          await openMacOSMicrophoneSettings(pi, ctx);
        }
        return;
      }
    }

    const { RecordingMeter } = await loadVisualizer();
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
      if (!isMicrophoneUnavailableError(error)) {
        const { offerMacOSPermissionHelp } = await import("./settings-menu.js");
        await offerMacOSPermissionHelp(pi, ctx);
      }
      return;
    }

    let reservation: DictationReservation;
    try {
      reservation = transcriptionService.reserveDictation(configured);
    } catch (error) {
      meter.stop();
      await capture.stop().catch(() => undefined);
      ctx.ui.notify(transcriptionErrorMessage(error), "error");
      return;
    }
    const active: ActiveRecording = { capture, reservation, meter };
    recording = active;

    void reservation.ready.then(
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

  async function toggleCaptureTask(ctx: ExtensionContext): Promise<void> {
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

  async function toggleCapture(ctx: ExtensionContext): Promise<void> {
    await runExclusive(ctx, () => toggleCaptureTask(ctx));
  }

  async function showSettings(ctx: ExtensionCommandContext): Promise<void> {
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
      const { showSettingsMenu } = await import("./settings-menu.js");
      reload = await showSettingsMenu(pi, ctx, configured, registeredShortcut);
    });
    if (reload) {
      await ctx.reload();
    }
  }

  async function replayOnboarding(ctx: ExtensionCommandContext): Promise<void> {
    if (recording) {
      ctx.ui.notify(
        `Stop recording with ${displayShortcut(registeredShortcut)} before replaying onboarding`,
        "warning",
      );
      return;
    }

    await runExclusive(ctx, async () => {
      await loadSettingsOnce();
      const { runOnboarding } = await import("./onboarding.js");
      const configured = await runOnboarding(
        ctx,
        settings?.shortcut ?? registeredShortcut,
      );
      if (!configured) return;
      rememberSettings(configured);
      ctx.ui.notify("Onboarding replay complete", "info");
    });
  }

  async function shutdown(ctx: ExtensionContext): Promise<void> {
    transcriptionAbort?.abort();
    await Promise.all([
      operation?.catch(() => undefined),
      transcriptionService.shutdown().catch(() => undefined),
    ]);

    const active = recording;
    recording = undefined;
    clearCancelListener();
    if (active) {
      active.reservation.cancel();
      active.meter.stop();
      await active.capture.stop().catch(() => undefined);
    }
    if (visualizerModulePromise) {
      const visualizer = await visualizerModulePromise.catch(() => undefined);
      visualizer?.clearTranscribeWidget(ctx);
    }
  }

  return {
    service: transcriptionService,
    requireConfiguredSettingsForTool,
    toggleCapture,
    showSettings,
    replayOnboarding,
    shutdown,
  };
}
