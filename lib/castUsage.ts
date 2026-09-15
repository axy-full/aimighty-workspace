/**
 * Cast that carries across everything (brief 2.4): what a name has been
 * used in, summed the way a producer reads it, and the still that stands
 * behind a cited name so a likeness can be checked at a glance. Pure.
 */
export type Used = { id: string; kind?: string; shotCode?: string | null; projectId?: string | null; projectName?: string | null; status?: string };

export type UsageSummary = { takes: number; stills: number; shots: number; productions: number };

export function usageSummary(rows: Used[]): UsageSummary {
  const live = rows.filter((r) => r.status !== "failed" && r.status !== "cancelled");
  return {
    takes: live.filter((r) => r.kind !== "image").length,
    stills: live.filter((r) => r.kind === "image").length,
    shots: new Set(live.map((r) => r.shotCode).filter(Boolean)).size,
    productions: new Set(live.map((r) => r.projectId ?? r.projectName).filter(Boolean)).size,
  };
}

const n = (count: number, word: string) => `${count} ${word.toUpperCase()}${count === 1 ? "" : "S"}`;

/** "3 SHOTS · 7 TAKES · 2 STILLS · ACROSS 2 PRODUCTIONS", dropping what is zero. */
export function usageLine(s: UsageSummary): string {
  const parts = [n(s.shots, "shot"), n(s.takes, "take")];
  if (s.stills) parts.push(n(s.stills, "still"));
  if (s.productions > 1) parts.push(`ACROSS ${n(s.productions, "project")}`);
  return parts.join(" · ");
}

/** For each name a take cited, the cast still that stands behind it — matched by name, case blind. */
export function castThumbs(names: string[], cast: { name: string; uploadId: string | null }[]): { name: string; uploadId: string | null }[] {
  return names.map((name) => ({ name, uploadId: cast.find((c) => c.name.toLowerCase() === name.toLowerCase())?.uploadId ?? null }));
}
