export type GenRouteSearch = Record<string, string | string[] | undefined>;

/** Canonicalize old creation links without dropping saved source/reference identities. */
export function generationHref(kind: string, search: GenRouteSearch): string | null {
  const mode = kind === "image" ? "images" : kind;
  if (!["video", "images", "audio"].includes(mode)) return null;
  const query = new URLSearchParams({ mode });
  for (const [key, value] of Object.entries(search)) {
    if (key === "mode" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  return `/generate?${query}`;
}
