/**
 * R9 — the filename protocol.
 *
 * A download must never inherit `hf_8f3a91c2.mp4` or a raw Seedance id. The
 * platform decides the name from a template the workspace configures, e.g.
 *   {project}_{scene}_{shot}_{model}_v{version}_{user}
 * → NIKEAW26_SC04_SH110_SD25_v3_Akshay.mp4
 *
 * Tokens that resolve to nothing collapse rather than leaving `__` holes, so
 * a render filed under no scene still reads cleanly.
 */

export type NameFacts = {
  project?: string | null;
  projectCode?: string | null;
  scene?: string | null;
  shot?: string | null;
  shotTitle?: string | null;
  model?: string | null;
  version?: number | null;
  user?: string | null;
  status?: string | null;
  id: string;
  createdAt?: number | null;
  ext: string;
};

export const TOKENS = [
  "project", "projectcode", "scene", "shot", "shottitle",
  "model", "version", "user", "date", "time", "status", "id",
] as const;

/**
 * Filesystem-safe, and safe inside a Content-Disposition header.
 *
 * Dots are stripped from VALUES even though they're legal in a filename:
 * "Seedance 2.5" would otherwise land as `SD2.5` mid-name, which reads like a
 * second extension and disagrees with the sample the settings screen shows.
 * Dots typed into the template survive — those are separators the workspace
 * chose on purpose.
 */
function clean(v: string): string {
  return v
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")    // drop punctuation, keep word chars/space/dash
    .trim()
    .replace(/\s+/g, "")         // "Sunset Beach" → "SunsetBeach"
    .replace(/^-+|-+$/g, "");
}

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function resolveTokens(f: NameFacts): Record<string, string> {
  const d = f.createdAt ? new Date(f.createdAt) : null;
  return {
    project: clean(f.project ?? ""),
    projectcode: clean(f.projectCode ?? ""),
    scene: clean(f.scene ?? ""),
    shot: clean(f.shot ?? ""),
    shottitle: clean(f.shotTitle ?? ""),
    model: clean(f.model ?? ""),
    version: f.version != null ? String(f.version) : "",
    user: clean((f.user ?? "").split(/\s+/)[0] ?? ""),
    date: d ? `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}` : "",
    time: d ? `${two(d.getHours())}${two(d.getMinutes())}` : "",
    status: clean(f.status ?? ""),
    id: clean(f.id),
  };
}

/**
 * Expand a template.
 *
 * A token that resolves to nothing takes its whole SEGMENT with it — the
 * literal text bound to it between separators. That matters: with a naive
 * substitution `v{version}` on an unfiled render leaves a bare `v`, and two
 * such downloads land in a producer's folder as `v.mp4` and `v-1.mp4`, which
 * is the exact meaningless filename this protocol exists to prevent.
 *
 * Unknown tokens are left visible, so a typo in the template shows up in the
 * filename instead of silently vanishing.
 */
export function buildFilename(template: string, f: NameFacts): string {
  const vals = resolveTokens(f);

  // Split on separators, keeping them, so a segment can be dropped whole.
  const parts = template.split(/([_\-.]+)/);
  const kept: string[] = [];
  for (const part of parts) {
    if (/^[_\-.]+$/.test(part) || part === "") { kept.push(part); continue; }
    let dropped = false;
    const expanded = part.replace(/\{([a-z0-9]+)\}/gi, (m, k: string) => {
      const key = k.toLowerCase();
      if (!(key in vals)) return m;          // unknown token — leave it showing
      if (!vals[key]) { dropped = true; return ""; }
      return vals[key];
    });
    kept.push(dropped ? "" : expanded);
  }

  let out = kept.join("")
    // A path separator becomes a dash rather than vanishing, so the boundary
    // it marked survives instead of fusing two names into one word.
    .replace(/[\\/:]+/g, "-")
    // Anything else that would break a Content-Disposition header or a
    // filesystem path, whether it came from a fact or from the template.
    .replace(/[\u0000-\u001f\u007f"'`;*?<>|]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[_\-.]{2,}/g, (run) => run[0])
    .replace(/^[_\-.\s]+|[_\-.\s]+$/g, "")
    .trim();

  if (!out) out = clean(f.id) || "render";
  const ext = f.ext.replace(/^\.+/, "").replace(/[^A-Za-z0-9]/g, "");
  return ext ? `${out}.${ext}` : out;
}

/** A short, human sample so the settings screen can show what a template does. */
export function sampleFilename(template: string): string {
  return buildFilename(template, {
    project: "Nike AW26", projectCode: "NKA26", scene: "SC04", shot: "SH110",
    shotTitle: "Rooftop wide", model: "SD25", version: 3, user: "Akshay Panchal",
    status: "approved", id: "gen_m1x2y3", createdAt: Date.UTC(2026, 8, 1, 9, 30), ext: "mp4",
  });
}
