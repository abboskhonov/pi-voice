import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Type } from "typebox";
import { decodeFileAudio } from "./file-audio.js";
import type { TranscribeSettings } from "./settings.js";
import { TranscribeCppBackend } from "./transcription.js";

const CONTEXT_LINE_LENGTH = 1_000;

type FileTranscriptionDetails = {
  inputPath: string;
  modelId: string;
  seconds: number;
  truncation?: TruncationResult;
  fullTranscriptPath?: string;
};

type FileTranscriptionOptions = {
  getSettings: () => Promise<TranscribeSettings>;
  isDictationBusy: () => boolean;
};

export type FileTranscriptionController = {
  isBusy(): boolean;
  shutdown(): Promise<void>;
};

function normalizeToolPath(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

/** Wrap long model output lines so Pi's line-aware truncation can retain useful text. */
function wrapLongLines(text: string): string {
  const output: string[] = [];
  for (const originalLine of text.split("\n")) {
    let line = originalLine;
    while (line.length > CONTEXT_LINE_LENGTH) {
      let split = line.lastIndexOf(" ", CONTEXT_LINE_LENGTH);
      if (split <= 0) split = CONTEXT_LINE_LENGTH;
      output.push(line.slice(0, split));
      line = line.slice(split).trimStart();
    }
    output.push(line);
  }
  return output.join("\n");
}

async function saveFullTranscript(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-transcribe-"));
  const path = join(directory, "transcript.txt");
  await writeFile(path, `${text}\n`, "utf8");
  return path;
}

export function registerFileTranscriptionTool(
  pi: ExtensionAPI,
  options: FileTranscriptionOptions,
): FileTranscriptionController {
  let pending = 0;
  let shuttingDown = false;
  let tail: Promise<void> = Promise.resolve();
  const shutdownController = new AbortController();

  function enqueue<T>(
    signal: AbortSignal | undefined,
    task: (operationSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    pending += 1;
    const operationSignal = signal
      ? AbortSignal.any([signal, shutdownController.signal])
      : shutdownController.signal;
    const run = tail.then(async () => {
      operationSignal.throwIfAborted();
      if (shuttingDown) throw new Error("pi-transcribe is shutting down");
      if (options.isDictationBusy()) {
        throw new Error(
          "Microphone recording or another pi-transcribe operation is active. Retry transcribe_file after it finishes.",
        );
      }
      return task(operationSignal);
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      pending -= 1;
    });
  }

  pi.registerTool({
    name: "transcribe_file",
    label: "Transcribe File",
    description: `Transcribe speech from a local audio or video file using pi-transcribe's configured local model. Requires the ffmpeg executable on PATH (or PI_TRANSCRIBE_FFMPEG_PATH). Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; a complete transcript is saved to a temporary file when needed.`,
    promptSnippet: "Transcribe speech from local audio or video files with a local model",
    promptGuidelines: [
      "Use transcribe_file when speech in a local audio or video file needs to be read, analyzed, or transcribed.",
      "Call transcribe_file sequentially for multiple files to avoid loading several large transcription jobs at once.",
      "If transcribe_file reports that FFmpeg is unavailable, explain the installation guidance and ask the user before running a system package-manager command.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Local media file path, absolute or relative to the current working directory",
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (options.isDictationBusy()) {
        throw new Error(
          "Microphone recording or another pi-transcribe operation is active. Retry transcribe_file after it finishes.",
        );
      }

      return enqueue(signal, async (operationSignal) => {
        const input = normalizeToolPath(params.path.trim());
        if (!input) throw new Error("A media file path is required");
        const inputPath = resolve(ctx.cwd, input);
        const inputStat = await stat(inputPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") throw new Error(`Media file not found: ${inputPath}`);
          throw error;
        });
        if (!inputStat.isFile()) throw new Error(`Media path is not a regular file: ${inputPath}`);
        operationSignal.throwIfAborted();

        const configured = await options.getSettings();
        onUpdate?.({
          content: [{ type: "text", text: `Decoding ${basename(inputPath)} with FFmpeg…` }],
          details: { inputPath, modelId: configured.model.id, seconds: 0 },
        });
        const audio = await decodeFileAudio(inputPath, operationSignal);

        const backend = new TranscribeCppBackend(
          configured.model.path,
          configured.transcriptionLanguage === "auto"
            ? undefined
            : configured.transcriptionLanguage,
          configured.chineseOutput,
        );
        try {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Transcribing ${audio.seconds.toFixed(1)}s from ${basename(inputPath)} locally…`,
              },
            ],
            details: {
              inputPath,
              modelId: configured.model.id,
              seconds: audio.seconds,
            },
          });
          const transcript = await backend.transcribe(audio.pcm, operationSignal);
          const details: FileTranscriptionDetails = {
            inputPath,
            modelId: configured.model.id,
            seconds: audio.seconds,
          };

          if (!transcript) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No speech detected in ${audio.seconds.toFixed(1)}s of audio from ${inputPath}`,
                },
              ],
              details,
            };
          }

          const contextTranscript =
            Buffer.byteLength(transcript, "utf8") > DEFAULT_MAX_BYTES
              ? wrapLongLines(transcript)
              : transcript;
          const truncation = truncateHead(contextTranscript, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });
          let resultText = truncation.content;
          if (truncation.truncated) {
            const fullTranscriptPath = await saveFullTranscript(transcript);
            details.truncation = truncation;
            details.fullTranscriptPath = fullTranscriptPath;
            resultText += `\n\n[Transcript truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full transcript saved to: ${fullTranscriptPath}]`;
          }

          return {
            content: [{ type: "text" as const, text: resultText }],
            details,
          };
        } finally {
          await backend.dispose();
        }
      });
    },
  });

  return {
    isBusy: () => pending > 0,
    async shutdown() {
      shuttingDown = true;
      shutdownController.abort(new Error("pi-transcribe is shutting down"));
      await tail;
    },
  };
}
