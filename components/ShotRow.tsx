"use client";

/**
 * Which shot a take belongs to.
 *
 * Filing is optional — an experiment shouldn't need paperwork — but filing is
 * what turns a pile of renders into "v3 of SH110": it names the download,
 * counts the revisions, and groups the canvas. So the control is one row, and
 * a new shot can be made without leaving the composer.
 */
import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { appPrompt, appAlert } from "@/components/dialog";

type Shot = { id: string; code: string; scene: string; title: string; takes: number };

export default function ShotRow({ projectId, shotId, setShotId }: {
  projectId: string;
  shotId: string;
  setShotId: (id: string) => void;
}) {
  const scoped = projectId !== "all" && projectId !== "unfiled";
  const { data, refresh } = useApi<{ shots: Shot[] }>(
    scoped ? `/api/shots?projectId=${encodeURIComponent(projectId)}` : null, 0);
  const [busy, setBusy] = useState(false);
  const shots = data?.shots ?? [];
  const current = shots.find((s) => s.id === shotId) ?? null;

  async function newShot() {
    if (busy) return;
    const code = await appPrompt("New shot", "", "SH010 — blank numbers it for you");
    if (code === null) return;
    setBusy(true);
    try {
      const res = await fetch("/api/shots", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, code }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not add the shot");
      setShotId(json.shot.id);
      refresh();
    } catch (e) {
      await appAlert((e as Error).message);
    } finally { setBusy(false); }
  }

  if (!scoped) {
    return (
      <div className="card px-4 py-3">
        <p className="grouplabel">Shot</p>
        <p className="mt-1 text-[13px] text-mute">
          Pick a project and renders can be filed against a shot — which is
          what numbers the versions and names the downloads.
        </p>
      </div>
    );
  }

  return (
    <div className="card px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="grouplabel">Shot</span>
        <button onClick={newShot} disabled={busy}
          className="ml-auto text-[13px] text-blue disabled:opacity-50">+ New</button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <button onClick={() => setShotId("")}
          className={`chip ${!shotId ? "bg-blue text-on-ink" : ""}`}>Unfiled</button>
        {shots.map((s) => (
          <button key={s.id} onClick={() => setShotId(s.id)}
            title={s.title || undefined}
            className={`chip ${shotId === s.id ? "bg-blue text-on-ink" : ""}`}>
            {s.scene ? `${s.scene}·` : ""}{s.code}
            {s.takes > 0 && <span className="ml-1 opacity-60">{s.takes}</span>}
          </button>
        ))}
      </div>

      {current && (
        <p className="mt-2 text-[12px] text-mute">
          {current.title ? `${current.title} — ` : ""}
          next render is take {current.takes + 1}.
        </p>
      )}
    </div>
  );
}
