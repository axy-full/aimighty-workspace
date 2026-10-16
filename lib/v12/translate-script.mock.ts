/**
 * The Hindi script stand-in's sample answer (app/api/v12/translate-script/route.ts, ENGINE_MOCK=1 only): a fixed, labelled sample, never a
 * translation. The real one comes from Sarvam (#777). Each line keeps its own words after the label.
 */
export function sampleHindi(text: string): string {
  return text.split("\n").map((line) => (line.trim() ? `हिन्दी (नमूना) · ${line}` : line)).join("\n");
}
