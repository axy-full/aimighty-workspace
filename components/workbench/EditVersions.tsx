"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditVersion } from "@/lib/workbench/editorial";
import { downloadFile } from "@/lib/workbench/studio-export";
import styles from "./editorial.module.css";
export function EditVersions({
  draftId,
  apiBase,
  requestScope,
  onSave,
  onRestore,
}: {
  draftId: string;
  apiBase: string;
  requestScope: string;
  onSave: (label: string, id: string) => Promise<EditVersion>;
  onRestore: (id: string) => Promise<void>;
}) {
  const [versions, setVersions] = useState<EditVersion[]>([]),
    [label, setLabel] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const pending = useRef<{ id: string; label: string } | null>(null),
    active = useRef(true);
  const url = apiBase + "/edit-versions?draftId=" + encodeURIComponent(draftId);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const r = await fetch(url, {
        headers: { "X-Workbench-Scope": requestScope },
        cache: "no-store",
        signal,
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error || "Could not load edit versions.");
      if (active.current && !signal?.aborted) setVersions(data.versions);
    },
    [url, requestScope],
  );
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    void refresh(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => {
      active.current = false;
      controller.abort();
    };
  }, [refresh]);
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (active.current) await refresh();
    } catch (e) {
      if (active.current)
        setError(
          e instanceof Error
            ? e.message
            : "Could not complete this edit action.",
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function save() {
    if (!pending.current || pending.current.label !== label.trim())
      pending.current = { id: crypto.randomUUID(), label: label.trim() };
    const result = await onSave(pending.current.label, pending.current.id);
    pending.current = null;
    if (active.current) {
      setLabel("");
      setNotice(
        `Saved “${result.label}” from project revision ${result.revision}.`,
      );
    }
  }
  async function download(version: EditVersion) {
    const r = await fetch(url + "&id=" + encodeURIComponent(version.id), {
      headers: { "X-Workbench-Scope": requestScope },
      cache: "no-store",
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error || "Could not read version.");
    downloadFile(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      `particl-edit-${version.id}.json`,
    );
  }
  return (
    <section className={styles.versions} aria-label="Edit versions">
      <h3>Named cuts</h3>
      <p>
        Retain timing, sources, sound and sequence color. Restoring a cut first
        retains the current non-empty edit.
      </p>
      <label>
        Version name
        <input
          aria-label="Edit version name"
          maxLength={100}
          value={label}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <button
        className="btn primary"
        disabled={busy || !label.trim() || versions.length >= 50}
        onClick={() => void perform(save)}
      >
        {busy ? "Working…" : "Save edit version"}
      </button>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <div className={styles.versionHeading}>
        <span>{versions.length} / 50 retained</span>
        <button
          className="btn"
          disabled={busy}
          onClick={() => void perform(async () => {})}
        >
          Refresh versions
        </button>
      </div>
      <ol>
        {versions.map((v) => (
          <li key={v.id}>
            <strong>{v.label}</strong>
            <small>
              {v.shots} shots · {(v.frames / v.fps).toFixed(1)}s · {v.fps} fps
            </small>
            <small>
              {new Date(v.createdAt).toLocaleString()} · revision {v.revision}
            </small>
            <div>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await onRestore(v.id);
                    if (active.current)
                      setNotice(
                        `Restored “${v.label}”. Your canvas and bins are preserved.`,
                      );
                  })
                }
              >
                Restore {v.label}
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => void perform(() => download(v))}
              >
                Download version
              </button>
            </div>
          </li>
        ))}
      </ol>
      {!versions.length && (
        <p>
          No retained cuts yet. Save a named version before revising this edit.
        </p>
      )}
    </section>
  );
}
