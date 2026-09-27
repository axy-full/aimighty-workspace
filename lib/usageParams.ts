/** Only display settings belong in usage responses; provider execution state stays private. */
export function visibleUsageParams(raw: unknown): Record<string, string | number> {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(raw ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      value = parsed as Record<string, unknown>;
  } catch {}
  const result: Record<string, string | number> = {};
  for (const key of ["resolution", "ratio"])
    if (typeof value[key] === "string" && String(value[key]).length <= 40)
      result[key] = String(value[key]);
  for (const key of ["duration", "steps"])
    if (typeof value[key] === "number" && Number.isFinite(value[key]))
      result[key] = Number(value[key]);
  return result;
}
