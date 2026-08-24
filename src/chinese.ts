import type { ChineseOutput } from "./settings.js";

type Converter = (text: string) => string;

const converters = new Map<ChineseOutput, Promise<Converter>>();

async function createConverter(output: ChineseOutput): Promise<Converter> {
  const { default: OpenCC } = await import("opencc-js");
  switch (output) {
    case "simplified":
      return OpenCC.Converter({ from: "t", to: "cn" });
    case "traditional-taiwan":
      return OpenCC.Converter({ from: "cn", to: "tw" });
    case "traditional-hong-kong":
      return OpenCC.Converter({ from: "cn", to: "hk" });
  }
}

function converterFor(output: ChineseOutput): Promise<Converter> {
  const existing = converters.get(output);
  if (existing) return existing;

  const loading = createConverter(output);
  converters.set(output, loading);
  void loading.catch(() => {
    if (converters.get(output) === loading) converters.delete(output);
  });
  return loading;
}

export function isChineseLanguage(language: string): boolean {
  const base = language.toLowerCase().split("-", 1)[0];
  return base === "zh" || base === "yue";
}

/**
 * Post-processing step: never fails the transcription. If the converter cannot
 * load or convert, the raw model output is returned unchanged.
 */
export async function convertChineseOutput(
  text: string,
  output: ChineseOutput,
): Promise<string> {
  try {
    return await (await converterFor(output))(text);
  } catch (error) {
    console.warn(
      `pi-transcribe: Chinese output conversion failed; returning unconverted text: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return text;
  }
}

export function chineseOutputSummary(output: ChineseOutput): string {
  switch (output) {
    case "simplified":
      return "Simplified";
    case "traditional-taiwan":
      return "Traditional (Taiwan)";
    case "traditional-hong-kong":
      return "Traditional (Hong Kong)";
  }
}
