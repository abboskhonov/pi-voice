import type { TranscribeSettings } from "./settings.js";
import type {
  DictationStream,
  TranscribeCppBackend,
  TranscriptionOptions,
} from "./transcription.js";

type TranscriptionJob = {
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
  accepting: boolean;
  submitted: boolean;
  cancelled: boolean;
  started: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: unknown) => void;
  readySettled: boolean;
  submission: Promise<void>;
  resolveSubmission: () => void;
  submissionSettled: boolean;
  result: Promise<string>;
  resolveResult: (text: string) => void;
  rejectResult: (error: unknown) => void;
  resultSettled: boolean;
  fullPcm?: Float32Array;
  signal?: AbortSignal;
  removeAbortListener?: () => void;
  chunks: Float32Array[];
  stream?: DictationStream;
  drain?: Promise<void>;
  streamUnavailable: boolean;
  streamError?: unknown;
};

export type DictationReservation = {
  readonly ready: Promise<void>;
  feed(chunk: Float32Array): void;
  submit(pcm: Float32Array, signal?: AbortSignal): Promise<string>;
  cancel(): void;
};

type ReusableBackend = Pick<
  TranscribeCppBackend,
  "prepare" | "transcribe" | "dispose"
> & {
  startStream?: (
    options?: TranscriptionOptions,
  ) => Promise<DictationStream | undefined>;
};

type BackendFactory = (
  modelPath: string,
) => ReusableBackend | Promise<ReusableBackend>;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Transcription cancelled");
}

function transcriptionOptions(
  settings: TranscribeSettings,
  signal?: AbortSignal,
): TranscriptionOptions {
  return {
    signal,
    language:
      settings.transcriptionLanguage === "auto"
        ? undefined
        : settings.transcriptionLanguage,
    chineseOutput: settings.chineseOutput,
  };
}

/** Owns the loaded model and schedules dictation ahead of queued file jobs. */
export class TranscriptionService {
  private backend: ReusableBackend | undefined;
  private modelPath: string | undefined;
  private readonly dictationQueue: ReservationState[] = [];
  private readonly fileQueue: TranscriptionJob[] = [];
  private readonly reservationStates = new Set<ReservationState>();
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
    if (this.reservation) throw new Error("A dictation reservation is already active");

    let resolveReadyPromise!: () => void;
    let rejectReadyPromise!: (error: unknown) => void;
    let resolveSubmissionPromise!: () => void;
    let resolveResultPromise!: (text: string) => void;
    let rejectResultPromise!: (error: unknown) => void;
    const state: ReservationState = {
      settings,
      accepting: true,
      submitted: false,
      cancelled: false,
      started: false,
      ready: new Promise<void>((resolve, reject) => {
        resolveReadyPromise = resolve;
        rejectReadyPromise = reject;
      }),
      resolveReady: () => {
        if (state.readySettled) return;
        state.readySettled = true;
        resolveReadyPromise();
      },
      rejectReady: (error) => {
        if (state.readySettled) return;
        state.readySettled = true;
        rejectReadyPromise(error);
      },
      readySettled: false,
      submission: new Promise<void>((resolve) => {
        resolveSubmissionPromise = resolve;
      }),
      resolveSubmission: () => {
        if (state.submissionSettled) return;
        state.submissionSettled = true;
        resolveSubmissionPromise();
      },
      submissionSettled: false,
      result: new Promise<string>((resolve, reject) => {
        resolveResultPromise = resolve;
        rejectResultPromise = reject;
      }),
      resolveResult: (text) => {
        if (state.resultSettled) return;
        state.resultSettled = true;
        resolveResultPromise(text);
      },
      rejectResult: (error) => {
        if (state.resultSettled) return;
        state.resultSettled = true;
        rejectResultPromise(error);
      },
      resultSettled: false,
      chunks: [],
      streamUnavailable: false,
    };
    // Cancellation can happen before callers attach handlers to either promise.
    void state.ready.catch(() => undefined);
    void state.result.catch(() => undefined);
    this.reservation = state;
    this.reservationStates.add(state);
    this.schedule();

    return {
      ready: state.ready,
      feed: (chunk) => {
        if (
          !state.accepting ||
          state.streamUnavailable ||
          state.streamError !== undefined ||
          chunk.length === 0
        ) return;
        state.chunks.push(chunk);
        this.startDrain(state);
      },
      submit: (pcm, signal) => {
        if (!state.accepting || state.submitted) {
          return Promise.reject(new Error("The dictation reservation is no longer active"));
        }
        state.accepting = false;
        state.submitted = true;
        state.fullPcm = pcm;
        if (this.reservation === state) this.reservation = undefined;
        if (!state.started) this.dictationQueue.push(state);
        state.signal = signal;
        if (signal) {
          const onAbort = (): void => this.abortReservation(state);
          signal.addEventListener("abort", onAbort, { once: true });
          state.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          if (signal.aborted) onAbort();
        }
        state.resolveSubmission();
        this.schedule();
        return state.result;
      },
      cancel: () => {
        if (!state.accepting || state.submitted) return;
        state.accepting = false;
        state.cancelled = true;
        state.chunks.length = 0;
        if (this.reservation === state) this.reservation = undefined;
        this.resetStream(state);
        state.rejectReady(new Error("Dictation cancelled"));
        state.resolveSubmission();
        if (!state.started) this.reservationStates.delete(state);
        this.schedule();
      },
    };
  }

  transcribeFile(
    settings: TranscribeSettings,
    pcm: Float32Array,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.shuttingDown) return Promise.reject(new Error("pi-transcribe is shutting down"));
    if (signal?.aborted) return Promise.reject(abortError(signal));

    const result = new Promise<string>((resolve, reject) => {
      const job: TranscriptionJob = {
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
          const index = this.fileQueue.indexOf(job);
          if (index >= 0) this.fileQueue.splice(index, 1);
          this.settleJob(job, () => reject(abortError(signal)));
          this.schedule();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        job.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
      this.fileQueue.push(job);
    });
    this.schedule();
    return result;
  }

  private abortReservation(state: ReservationState): void {
    if (state.cancelled || state.resultSettled) return;
    state.cancelled = true;
    state.accepting = false;
    state.chunks.length = 0;
    // Queue native reset before the scheduler can begin another model operation.
    this.resetStream(state);
    state.resolveSubmission();

    // A submitted reservation waiting behind active work has no native state to
    // tear down, so preserve the old immediate-cancellation behavior.
    if (!state.started) {
      const index = this.dictationQueue.indexOf(state);
      if (index >= 0) this.dictationQueue.splice(index, 1);
      this.reservationStates.delete(state);
      state.removeAbortListener?.();
      const error = state.signal?.aborted
        ? abortError(state.signal)
        : new Error("Transcription cancelled");
      state.rejectReady(error);
      state.rejectResult(error);
    }
  }

  private resetStream(state: ReservationState): void {
    const stream = state.stream;
    state.stream = undefined;
    stream?.reset();
  }

  private startDrain(state: ReservationState): void {
    if (
      !state.stream ||
      state.drain ||
      state.cancelled ||
      state.streamUnavailable ||
      state.streamError !== undefined ||
      state.chunks.length === 0
    ) {
      return;
    }

    const draining = this.drainStream(state).finally(() => {
      if (state.drain === draining) state.drain = undefined;
      this.startDrain(state);
    });
    state.drain = draining;
  }

  private async drainStream(state: ReservationState): Promise<void> {
    const stream = state.stream!;
    while (
      state.stream === stream &&
      !state.cancelled &&
      state.chunks.length > 0
    ) {
      const chunk = state.chunks.shift()!;
      try {
        await stream.feed(chunk);
      } catch (error) {
        state.streamError = error;
        state.chunks.length = 0;
        // A batch fallback may only start after reset has been issued.
        this.resetStream(state);
        return;
      }
    }
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
    return (
      this.dictationQueue.length > 0 ||
      this.reservation !== undefined ||
      this.fileQueue.length > 0
    );
  }

  private async process(): Promise<void> {
    while (!this.shuttingDown) {
      const queuedDictation = this.dictationQueue.shift();
      if (queuedDictation) {
        queuedDictation.started = true;
        await this.runReservation(queuedDictation);
        continue;
      }

      const reservation = this.reservation;
      if (reservation) {
        reservation.started = true;
        await this.runReservation(reservation);
        if (this.reservation === reservation) this.reservation = undefined;
        continue;
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

  private async runReservation(state: ReservationState): Promise<void> {
    try {
      await this.runReservationWork(state);
    } finally {
      state.removeAbortListener?.();
      this.reservationStates.delete(state);
    }
  }

  private settleCancelledReservation(state: ReservationState): void {
    this.resetStream(state);
    const error = state.signal?.aborted
      ? abortError(state.signal)
      : new Error("Dictation cancelled");
    state.rejectReady(error);
    if (state.submitted) state.rejectResult(error);
  }

  private async runReservationWork(state: ReservationState): Promise<void> {
    if (state.cancelled) {
      this.settleCancelledReservation(state);
      return;
    }

    let backend: ReusableBackend;
    try {
      backend = await this.ensureModel(state.settings.model.path);
    } catch (error) {
      if (state.cancelled) {
        this.settleCancelledReservation(state);
        return;
      }
      state.streamUnavailable = true;
      state.chunks.length = 0;
      state.rejectReady(error);
      await state.submission;
      if (state.submitted) state.rejectResult(error);
      return;
    }

    if (state.cancelled) {
      this.settleCancelledReservation(state);
      return;
    }

    // If recording already ended while the model loaded, avoid replaying the
    // complete clip through a newly opened stream and use the batch path.
    if (!state.submitted && backend.startStream) {
      try {
        state.stream = await backend.startStream(
          transcriptionOptions(state.settings),
        );
        if (!state.stream) {
          state.streamUnavailable = true;
          state.chunks.length = 0;
        }
      } catch (error) {
        // Stream setup is an optimization; preserve dictation via batch fallback.
        state.streamError = error;
        state.chunks.length = 0;
      }
    }

    if (state.cancelled) {
      this.settleCancelledReservation(state);
      return;
    }

    state.resolveReady();
    this.startDrain(state);
    await state.submission;

    if (!state.submitted) {
      this.resetStream(state);
      return;
    }

    try {
      if (state.cancelled || state.signal?.aborted) {
        throw state.signal?.aborted
          ? abortError(state.signal)
          : new Error("Dictation cancelled");
      }

      this.startDrain(state);
      while (state.drain) await state.drain;

      if (state.cancelled || state.signal?.aborted) {
        throw state.signal?.aborted
          ? abortError(state.signal)
          : new Error("Dictation cancelled");
      }

      const stream = state.stream;
      if (stream && state.streamError === undefined) {
        try {
          const text = await stream.finalize();
          state.signal?.throwIfAborted();
          state.resolveResult(text);
          return;
        } catch (error) {
          if (state.signal?.aborted) throw abortError(state.signal);
          state.streamError = error;
        } finally {
          // Idempotent if finalize already released it. This must happen before
          // the reservation is released and file work is scheduled.
          if (state.stream === stream) state.stream = undefined;
          stream.reset();
        }
      }

      // Stream setup/feed/finalize failure: reset precedes the batch fallback.
      this.resetStream(state);
      state.chunks.length = 0;
      const pcm = state.fullPcm!;
      const signal = state.signal
        ? AbortSignal.any([state.signal, this.shutdownController.signal])
        : this.shutdownController.signal;
      signal.throwIfAborted();
      const text = await backend.transcribe(
        pcm,
        transcriptionOptions(state.settings, signal),
      );
      state.resolveResult(text);
    } catch (error) {
      this.resetStream(state);
      state.rejectResult(
        state.signal?.aborted ? abortError(state.signal) : error,
      );
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
      const text = await backend.transcribe(
        job.pcm,
        transcriptionOptions(job.settings, signal),
      );
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
      this.reservation = undefined;
      this.dictationQueue.length = 0;
      for (const reservation of this.reservationStates) {
        reservation.accepting = false;
        reservation.cancelled = true;
        reservation.chunks.length = 0;
        this.resetStream(reservation);
        reservation.rejectReady(shutdownError);
        reservation.rejectResult(shutdownError);
        reservation.resolveSubmission();
      }
      for (const job of this.fileQueue) {
        this.settleJob(job, () => job.reject(shutdownError));
      }
      this.fileQueue.length = 0;
    }

    await this.loop?.catch(() => undefined);
    this.reservationStates.clear();
    await this.unloadModel().catch(() => undefined);
  }
}
