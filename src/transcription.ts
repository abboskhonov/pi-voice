import { TranscribeModel } from "transcribe-cpp";
import { convertChineseOutput, isChineseLanguage } from "./chinese.js";
import type { ChineseOutput } from "./settings.js";

export type TranscriptionOptions = {
  signal?: AbortSignal;
  language?: string;
  chineseOutput?: ChineseOutput;
};

/** A reusable loaded transcribe.cpp model. Calls must be scheduled sequentially. */
export class TranscribeCppBackend {
  private model: TranscribeModel | undefined;
  private loading: Promise<TranscribeModel> | undefined;
  private disposed = false;

  constructor(private readonly modelPath: string) {}

  async prepare(): Promise<void> {
    if (this.model) return;
    if (this.disposed) throw new Error("Transcription backend has been disposed");

    if (!this.loading) {
      this.loading = TranscribeModel.load(this.modelPath).then((model) => {
        if (this.disposed) {
          model.dispose();
          throw new Error("Transcription backend was disposed while loading");
        }
        this.model = model;
        return model;
      });
    }

    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  async transcribe(
    pcm: Float32Array,
    options: TranscriptionOptions = {},
  ): Promise<string> {
    if (pcm.length === 0) throw new Error("No audio samples were provided");
    await this.prepare();
    const model = this.model!;
    if (options.language && !model.capabilities.languages.includes(options.language)) {
      throw new Error(
        `Configured language ${options.language} is not supported by this model. Open /transcribe and choose another language.`,
      );
    }

    const result = await model.transcribe(pcm, {
      signal: options.signal,
      timestamps: "none",
      ...(options.language ? { language: options.language } : {}),
    });
    const text = result.text.trim();
    return isChineseLanguage(result.language || options.language || "")
      ? convertChineseOutput(text, options.chineseOutput ?? "simplified")
      : text;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.loading?.catch(() => undefined);
    this.model?.dispose();
    this.model = undefined;
  }
}
