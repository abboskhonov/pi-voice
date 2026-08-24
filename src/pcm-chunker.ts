import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";

export const STREAM_CHUNK_SAMPLES = CAPTURE_SAMPLE_RATE / 2;

/** Coalesces recorder frames into fresh Float32 PCM chunks without timers. */
export class PcmChunker {
  private frames: Int16Array[] = [];
  private sampleCount = 0;

  constructor(
    private readonly onChunk: (chunk: Float32Array) => void,
    private readonly targetSamples = STREAM_CHUNK_SAMPLES,
  ) {
    if (!Number.isInteger(targetSamples) || targetSamples <= 0) {
      throw new Error("PCM chunk size must be a positive integer");
    }
  }

  push(frame: Int16Array): void {
    if (frame.length === 0) return;
    this.frames.push(frame);
    this.sampleCount += frame.length;
    if (this.sampleCount >= this.targetSamples) this.emit();
  }

  flush(): void {
    if (this.sampleCount > 0) this.emit();
  }

  discard(): void {
    this.frames = [];
    this.sampleCount = 0;
  }

  private emit(): void {
    const pcm = new Float32Array(this.sampleCount);
    let offset = 0;
    for (const frame of this.frames) {
      for (let index = 0; index < frame.length; index += 1) {
        pcm[offset + index] = (frame[index] ?? 0) / 32_768;
      }
      offset += frame.length;
    }
    this.frames = [];
    this.sampleCount = 0;
    this.onChunk(pcm);
  }
}
