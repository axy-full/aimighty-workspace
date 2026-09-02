"use client";

/**
 * Workspace-wide settings — the ones that change everyone's files, so they're
 * the admin's to set and they live in the database rather than a browser.
 */
import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { sampleFilename, TOKENS } from "@/lib/naming";
import { appAlert } from "@/components/dialog";
import { Switch } from "@/components/Panel";

type Settings = Record<string, string>;

export default function WorkspaceSettings({ isAdmin }: { isAdmin: boolean }) {
  const { data, refresh } = useApi<{ settings: Settings }>("/api/settings");
  /** null means "showing what the server has"; a string means someone typed.
   *  Derived rather than copied into state by an effect — copying would fight
   *  every poll for control of the field. */
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(patch: Record<string, string>) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not save");
      setDraft(null);
      refresh();
    } catch (e) {
      await appAlert((e as Error).message);
    } finally { setBusy(false); }
  }

  if (!data) return null;
  const saved = data.settings.namingTemplate ?? "";
  const template = draft ?? saved;
  const dirty = draft != null && draft !== saved;
  const derive = data.settings.deriveForApi !== "0";
  const retries = data.settings.maxRetries ?? "2";

  return (
    <>
      <p className="grouplabel mt-10">Downloads</p>
      <div className="rows">
        <div className="row !block py-3">
          <span className="text-[15px]">Filename protocol</span>
          <input
            value={template}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!isAdmin}
            spellCheck={false}
            className="mt-2 h-[38px] w-full rounded-[10px] bg-chip px-3 font-mono text-[13px] text-bone disabled:opacity-60"
          />
          <p className="mt-2 break-all font-mono text-[12px] text-dim">
            {sampleFilename(template || "{id}")}
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-mute">
            {TOKENS.map((t) => `{${t}}`).join(" · ")}
          </p>
          <p className="mt-1.5 text-[12px] text-mute">
            A token that resolves to nothing takes its separator with it, so an
            unfiled render doesn&rsquo;t come out as <code>v.mp4</code>.
          </p>
          {isAdmin && dirty && (
            <button onClick={() => save({ namingTemplate: template })} disabled={busy}
              className="mt-3 text-[14px] font-medium text-blue disabled:opacity-50">
              {busy ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>

      <p className="grouplabel mt-10">Assets</p>
      <div className="rows">
        <div className="row">
          <span className="min-w-0 flex-1">
            Delivery copies
            <span className="mt-0.5 block text-[12px] leading-snug text-mute">
              Keep the master untouched and send a derived copy when an API
              won&rsquo;t accept it. Off means oversized assets are refused.
            </span>
          </span>
          <Switch checked={derive} disabled={!isAdmin}
            onChange={(v) => save({ deriveForApi: v ? "1" : "0" })} />
        </div>
        <div className="row">
          <span className="min-w-0 flex-1">
            Edit &amp; extend output
            <span className="mt-0.5 block text-[12px] leading-snug text-mute">
              ByteDance recommend mov for edits — it holds colour and audio
              continuity an mp4 re-encode loses. mp4 is the default because
              QuickTime doesn&rsquo;t play reliably in Chrome.
            </span>
          </span>
          <span className="row-value">
            {isAdmin ? (
              <select value={data.settings.editOutputFormat ?? "mp4"} disabled={busy}
                onChange={(e) => save({ editOutputFormat: e.target.value })}
                className="rounded-[8px] bg-chip px-2 py-1 text-[14px]">
                <option value="mp4">mp4</option>
                <option value="mov">mov</option>
              </select>
            ) : (data.settings.editOutputFormat ?? "mp4")}
          </span>
        </div>
        <div className="row">
          <span className="min-w-0 flex-1">
            Retry failed submits
            <span className="mt-0.5 block text-[12px] leading-snug text-mute">
              Timeouts and rate limits only. A rejected prompt never retries.
            </span>
          </span>
          <span className="row-value">
            {isAdmin ? (
              <select value={retries} disabled={busy}
                onChange={(e) => save({ maxRetries: e.target.value })}
                className="rounded-[8px] bg-chip px-2 py-1 text-[14px]">
                {["0", "1", "2", "3", "4", "5"].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            ) : retries}
          </span>
        </div>
      </div>
    </>
  );
}
