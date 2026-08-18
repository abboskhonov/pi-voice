import type { TranscribeSettings } from "./settings.js";
import type { TranscribeCppBackend } from "./transcription.js";

type JobPriority = "dictation" | "file";

type TranscriptionJob = {
  priority: JobPriority;
  settings: TranscribeSettings;
  pcm: Float32Array;
  signal?: AbortSignal;
  resolve: (text: string) => void;
  reject: (error: unknown) => void;
  started: boolean;
  settled: boolean;
  removeAbortListener?: () => void;
};

type ReservationState = {
  settings: TranscribeSettings;
  active: boolean;
  submitted: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: unknown) => void;
  readySettled: boolean;
};

export type DictationReservation = {
  readonly ready: Promise<void>;
  submit(pcm: Float32Array, signal?: AbortSignal): Promise<string>;
  cancel(): void;
};

type ReusableBackend = Pick<TranscribeCppBackend, "prepare" | "transcribe" | "dispose">;
type BackendFactory = (
  modelPath: string,
) => ReusableBackend | Promise<ReusableBackend>;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Transcription cancelled");
}

/** Owns the loaded model and schedules dictation ahead of queued file jobs. */
export class TranscriptionService {
  private backend: ReusableBackend | undefined;
  private modelPath: string | undefined;
  private readonly dictationQueue: TranscriptionJob[] = [];
  private readonly fileQueue: TranscriptionJob[] = [];
  private reservation: ReservationState | undefined;
  private loop: Promise<void> | undefined;
  private shuttingDown = false;
  private readonly shutdownController = new AbortController();

  constructor(
    private readonly createBackend: BackendFactory = async (modelPath) => {
      const { TranscribeCppBackend } = await import("./transcription.js");
      return new TranscribeCppBackend(modelPath);
    },
  ) {}

  reserveDictation(settings: TranscribeSettings): DictationReservation {
    if (this.shuttingDown) throw new Error("pi-transcribe is shutting down");
    if (this.reservation?.active) throw new Error("A dictation reservation is already active");

    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const state: ReservationState = {
      settings,
      active: true,
      submitted: false,
      ready: new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      }),
      resolveReady: () => {
        if (state.readySettled) return;
        state.readySettled = true;
        resolveReady();
      },
      rejectReady: (error) => {
        if (state.readySettled) return;
        state.readySettled = true;
        rejectReady(error);
      },
      readySettled: false,
    };
    // The meter observes failures through ready, but cancellation may happen before
    // a caller attaches its handlers.
    void state.ready.catch(() => undefined);
    this.reservation = state;
    this.schedule();

    return {
      ready: state.ready,
      submit: (pcm, signal) => {
        if (!state.active || state.submitted) {
          return Promise.reject(new Error("The dictation reservation is no longer active"));
        }
        state.submitted = true;
        state.active = false;
        if (this.reservation === state) this.reservation = undefined;
        const result = this.enqueue("dictation", state.settings, pcm, signal);
        this.schedule();
        return result;
      },
      cancel: () => {
        if (!state.active || state.submitted) return;
        state.active = false;
        if (this.reservation === state) this.reservation = undefined;
        state.rejectReady(new Error("Dictation cancelled"));
        this.schedule();
      },
    };
  }

  transcribeFile(
    settings: TranscribeSettings,
    pcm: Float32Array,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.enqueue("file", settings, pcm, signal);
  }

  private enqueue(
    priority: JobPriority,
    settings: TranscribeSettings,
    pcm: Float32Array,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.shuttingDown) return Promise.reject(new Error("pi-transcribe is shutting down"));
    if (signal?.aborted) return Promise.reject(abortError(signal));

    const result = new Promise<string>((resolve, reject) => {
      const job: TranscriptionJob = {
        priority,
        settings,
        pcm,
        signal,
        resolve,
        reject,
        started: false,
        settled: false,
      };
      if (signal) {
        const onAbort = (): void => {
          if (job.started || job.settled) return;
          this.removeQueuedJob(job);
          this.settleJob(job, () => reject(abortError(signal)));
          this.schedule();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        job.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
      (priority === "dictation" ? this.dictationQueue : this.fileQueue).push(job);
    });
    this.schedule();
    return result;
  }

  private removeQueuedJob(job: TranscriptionJob): void {
    const queue = job.priority === "dictation" ? this.dictationQueue : this.fileQueue;
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
  }

  private settleJob(job: TranscriptionJob, settle: () => void): void {
    if (job.settled) return;
    job.settled = true;
    job.removeAbortListener?.();
    settle();
  }

  private schedule(): void {
    if (this.loop) return;
    const loop = this.process().finally(() => {
      if (this.loop === loop) this.loop = undefined;
      if (this.hasRunnableWork()) this.schedule();
    });
    this.loop = loop;
  }

  private hasRunnableWork(): boolean {
    if (this.shuttingDown) return false;
    if (this.dictationQueue.length > 0) return true;
    if (this.reservation?.active) return !this.reservation.readySettled;
    return this.fileQueue.length > 0;
  }

  private async process(): Promise<void> {
    while (!this.shuttingDown) {
      const dictation = this.dictationQueue.shift();
      if (dictation) {
        await this.runJob(dictation);
        continue;
      }

      const reservation = this.reservation;
      if (reservation?.active) {
        try {
          await this.ensureModel(reservation.settings.model.path);
          reservation.resolveReady();
        } catch (error) {
          reservation.rejectReady(error);
        }
        // A submitted or cancelled reservation changed state while the model loaded.
        if (!reservation.active || this.reservation !== reservation) continue;
        return;
      }

      const file = this.fileQueue.shift();
      if (file) {
        await this.runJob(file);
        continue;
      }

      // A dispose failure here would otherwise reject the loop promise unobserved.
      await this.unloadModel().catch(() => undefined);
      return;
    }
  }

  private async runJob(job: TranscriptionJob): Promise<void> {
    if (job.settled) return;
    job.started = true;
    const signal = job.signal
      ? AbortSignal.any([job.signal, this.shutdownController.signal])
      : this.shutdownController.signal;

    try {
      signal.throwIfAborted();
      const backend = await this.ensureModel(job.settings.model.path);
      signal.throwIfAborted();
      const text = await backend.transcribe(job.pcm, {
        signal,
        language:
          job.settings.transcriptionLanguage === "auto"
            ? undefined
            : job.settings.transcriptionLanguage,
        chineseOutput: job.settings.chineseOutput,
      });
      this.settleJob(job, () => job.resolve(text));
    } catch (error) {
      this.settleJob(job, () => job.reject(error));
    }
  }

  private async ensureModel(modelPath: string): Promise<ReusableBackend> {
    if (this.backend && this.modelPath === modelPath) {
      await this.backend.prepare();
      return this.backend;
    }

    await this.unloadModel();
    const backend = await this.createBackend(modelPath);
    this.backend = backend;
    this.modelPath = modelPath;
    try {
      await backend.prepare();
      return backend;
    } catch (error) {
      if (this.backend === backend) {
        this.backend = undefined;
        this.modelPath = undefined;
      }
      await backend.dispose().catch(() => undefined);
      throw error;
    }
  }

  private async unloadModel(): Promise<void> {
    const backend = this.backend;
    if (!backend) return;
    this.backend = undefined;
    this.modelPath = undefined;
    await backend.dispose();
  }

  async shutdown(): Promise<void> {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      this.shutdownController.abort(new Error("pi-transcribe is shutting down"));
      const shutdownError = new Error("pi-transcribe is shutting down");
      const reservation = this.reservation;
      this.reservation = undefined;
      if (reservation) {
        reservation.active = false;
        reservation.rejectReady(shutdownError);
      }
      for (const job of [...this.dictationQueue, ...this.fileQueue]) {
        this.settleJob(job, () => job.reject(shutdownError));
      }
      this.dictationQueue.length = 0;
      this.fileQueue.length = 0;
    }

    await this.loop?.catch(() => undefined);
    await this.unloadModel().catch(() => undefined);
  }
}
