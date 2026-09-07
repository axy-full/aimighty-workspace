/**
 * The selects, on the way out (brief 2.6): the shot list a producer bills
 * from, and an edit list an editor drops into Resolve or Premiere. Pure —
 * the route reads the takes, these write the files.
 */
export type Select = {
  id: string; shot: string; shotTitle: string; version: number; kind: string;
  engine: string; credits: number; usd: number; seconds: number; prompt: string; filename: string;
};

const cell = (v: string | number | null): string => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per approved take, in shot order, the money column in the workspace's unit. */
export function selectsCsv(rows: Select[], unit: "cr" | "$"): string {
  const head = ["shot", "shot_title", "take", "version", "engine", unit === "cr" ? "credits" : "usd", "seconds", "prompt", "file"];
  const lines = rows.map((r) => [
    r.shot, r.shotTitle, r.id, r.version, r.engine,
    unit === "cr" ? r.credits : Math.round(r.usd * 10000) / 10000,
    r.seconds, r.prompt, r.filename,
  ].map(cell).join(","));
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}

/** Frames as a timecode at the given rate. */
export function tc(frames: number, fps = 25): string {
  const f = Math.max(0, Math.round(frames));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(f / (fps * 3600)))}:${p(Math.floor(f / (fps * 60)) % 60)}:${p(Math.floor(f / fps) % 60)}:${p(f % fps)}`;
}

/**
 * A CMX 3600 edit list: the approved takes end to end, in shot order, each
 * one a cut on V1 with its own file named in a comment — which is what an
 * editor's conform reads to find the master.
 */
export function edl(rows: Select[], opts: { title: string; fps?: number }): string {
  const fps = opts.fps ?? 25;
  const out: string[] = [`TITLE: ${opts.title.slice(0, 70)}`, "FCM: NON-DROP FRAME"];
  let at = 0;
  rows.forEach((r, i) => {
    const frames = Math.max(1, Math.round((r.seconds || 0) * fps));
    const reel = (r.shot || `T${i + 1}`).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase() || `T${i + 1}`;
    out.push(`${String(i + 1).padStart(3, "0")}  ${reel.padEnd(8)} V     C        ${tc(0, fps)} ${tc(frames, fps)} ${tc(at, fps)} ${tc(at + frames, fps)}`);
    out.push(`* FROM CLIP NAME: ${r.filename}`);
    if (r.shotTitle) out.push(`* COMMENT: ${r.shotTitle}`);
    at += frames;
  });
  return out.join("\r\n") + "\r\n";
}
