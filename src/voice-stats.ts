import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const STATS_VERSION = 1;
const STATS_FILE_NAME = "pi-voice-stats.json";

type VoiceStats = {
  version: 1;
  totalWords: number;
  days: Record<string, number>;
};

export type VoiceStatsSummary = {
  today: number;
  thisMonth: number;
  allTime: number;
};

function emptyStats(): VoiceStats {
  return { version: STATS_VERSION, totalWords: 0, days: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidStats(value: unknown): value is VoiceStats {
  if (!isRecord(value) || !isRecord(value.days)) return false;
  return (
    value.version === STATS_VERSION &&
    typeof value.totalWords === "number" &&
    Number.isSafeInteger(value.totalWords) &&
    value.totalWords >= 0 &&
    Object.values(value.days).every(
      (count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    )
  );
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function countWords(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)].filter(
    (segment) => segment.isWordLike,
  ).length;
}

export function summarizeVoiceStats(stats: VoiceStats, timestamp = Date.now()): VoiceStatsSummary {
  const todayKey = localDay(timestamp);
  const monthKey = todayKey.slice(0, 7);
  const thisMonth = Object.entries(stats.days).reduce(
    (total, [day, count]) => total + (day.startsWith(monthKey) ? count : 0),
    0,
  );
  return {
    today: stats.days[todayKey] ?? 0,
    thisMonth,
    allTime: stats.totalWords,
  };
}

export function formatVoiceStats(summary: VoiceStatsSummary): string {
  return `Voice stats — today: ${summary.today} words · this month: ${summary.thisMonth} words · all time: ${summary.allTime} words`;
}

export function createVoiceStatsStore(directory = getAgentDir()) {
  const path = join(directory, STATS_FILE_NAME);

  async function read(): Promise<VoiceStats> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      return isValidStats(parsed) ? parsed : emptyStats();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyStats();
      throw error;
    }
  }

  async function write(stats: VoiceStats): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(stats, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  return {
    async addTranscript(text: string, timestamp = Date.now()): Promise<number> {
      const words = countWords(text);
      if (words === 0) return 0;
      const stats = await read();
      const day = localDay(timestamp);
      stats.days[day] = (stats.days[day] ?? 0) + words;
      stats.totalWords += words;
      await write(stats);
      return words;
    },

    async summary(timestamp = Date.now()): Promise<VoiceStatsSummary> {
      return summarizeVoiceStats(await read(), timestamp);
    },
  };
}
