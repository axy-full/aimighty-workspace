"use client";

import { useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/useApi";
import { uploadFile } from "@/lib/uploadClient";
import { timeAgo } from "@/lib/format";
import { appConfirm } from "./dialog";
import { IconClose, IconPlus, IconSparkle } from "./Icons";
import { ParticlSpinner, Empty } from "./ParticlMark";
import LazyMedia from "./LazyMedia";
import Theatre from "./Theatre";
import Boundary from "./Boundary";
import type { Gen } from "./GenCard";
import { useMoney } from "@/lib/price";

/**
 * One identity, opened: its photos, its training, and — once trained — a
 * small composer that renders the face itself into any shot.
 */

export type IdentityView = {
  id: string; projectId: string | null; name: string; description: string;
  photos: string[]; status: "draft" | "training" | "ready" | "failed";
  trigger: string | null; steps: number | null; costUsd: number | null; error: string | null;
  coverUploadId: string | null; castId: string | null; authorName: string | null;
  createdAt: number; updatedAt: number; trainedAt: number | null; trained: boolean;
};

export type IdentityTerms = {
  configured: boolean; trainer: string;
  minPhotos: number; maxPhotos: number; recommended: string;
  steps: number; trainCostUsd: number; renderUsdPerMp: number;
};

const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;

export default function IdentitySheet({ identity: initial, projectId, terms, onClose, onChanged }: {
  identity: IdentityView | null;
  projectId: string | null;
  terms: IdentityTerms;
  onClose: () => void;
  onChanged: () => void;
}) {
  const money = useMoney();
  const [identity, setIdentity] = useState<IdentityView | null>(initial);
  const [progress, setProgress] = useState<number | null>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [photos, setPhotos] = useState<string[]>(initial?.photos ?? []);
  const [cover, setCover] = useState<string | null>(initial?.coverUploadId ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const isNew = !identity;
  const training = identity?.status === "training";
  const ready = identity?.status === "ready" && identity.trained;
  const dirty = !isNew && (
    name.trim() !== identity!.name || description.trim() !== identity!.description ||
    JSON.stringify(photos) !== JSON.stringify(identity!.photos) || cover !== identity!.coverUploadId);

  /* While it trains, ask every few seconds; the row flips to ready on its own. */
  useEffect(() => {
    if (!identity || identity.status !== "training") return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/identities/${identity.id}`, { cache: "no-store" });
        const json = await res.json();
        if (!alive || !res.ok) return;
        setProgress(json.progress ?? null);
        if (json.identity.status !== "training") { setIdentity(json.identity); onChanged(); }
      } catch { /* next tick */ }
    };
    tick();
    const t = setInterval(tick, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [identity, onChanged]);

  async function addPhotos(files: FileList) {
    setErr(null);
    const room = terms.maxPhotos - photos.length;
    const list = Array.from(files).slice(0, Math.max(0, room));
    if (!list.length) { setErr(`That's the limit — ${terms.maxPhotos} photos.`); return; }
    try {
      const added: string[] = [];
      for (const [i, f] of list.entries()) {
        setBusy(`Uploading ${i + 1} of ${list.length}…`);
        const up = await uploadFile(f, "reference");
        if (up.kind !== "image") continue;
        added.push(up.id);
      }
      setPhotos((p) => [...p, ...added]);
      if (!cover && added[0]) setCover(added[0]);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); if (file.current) file.current.value = ""; }
  }

  async function save(thenTrain = false): Promise<IdentityView | null> {
    setErr(null);
    if (!name.trim()) { setErr("Give them a name — it's what you'll write in prompts."); return null; }
    setBusy("Saving…");
    try {
      const body = { name: name.trim(), description: description.trim(), photos, coverUploadId: cover, projectId };
      const res = identity
        ? await fetch(`/api/identities/${identity.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        : await fetch("/api/identities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't save");
      setIdentity(json.identity);
      onChanged();
      if (thenTrain) return train(json.identity);
      return json.identity;
    } catch (e) { setErr((e as Error).message); return null; }
    finally { setBusy(null); }
  }

  async function train(target = identity): Promise<IdentityView | null> {
    if (!target) return null;
    setErr(null);
    setBusy("Handing the photos to the trainer…");
    try {
      const res = await fetch(`/api/identities/${target.id}/train`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't start training");
      setIdentity(json.identity); setProgress(null);
      onChanged();
      return json.identity;
    } catch (e) { setErr((e as Error).message); return null; }
    finally { setBusy(null); }
  }

  async function remove() {
    if (!identity) return;
    if (!(await appConfirm(`Remove ${identity.name}?`, "Takes made with them stay in All takes.", { confirmLabel: "Remove", danger: true }))) return;
    await fetch(`/api/identities/${identity.id}`, { method: "DELETE" });
    onChanged(); onClose();
  }

  const enough = photos.length >= terms.minPhotos;
  const canTrain = terms.configured && enough && !training && !busy;

  return (
    <div className="sheet-veil" onClick={onClose}>
      <div className="sheet !max-w-[720px]" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={identity ? identity.name : "New identity"}>
        <header className="sheet-head">
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[16px] font-semibold tracking-[-0.01em]">
              {identity ? `@${identity.name}` : "New identity"}
            </span>
            {identity && (
              <span className="text-[12.5px] text-mute">
                <StatusWord identity={identity} progress={progress} />
                {identity.authorName ? ` · ${identity.authorName}` : ""} · {timeAgo(identity.createdAt)}
              </span>
            )}
          </span>
          <button type="button" onClick={onClose} className="ml-auto theatre-close" title="Close"><IconClose /></button>
        </header>

        <div className="sheet-body">
          {/* ── Who ── */}
          <div className="grid gap-3 md:grid-cols-[200px_1fr]">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-dim">Name</span>
              <input className="ctl" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maya" disabled={training}
                spellCheck={false} />
              <span className="mt-1 block text-[11.5px] text-mute">Letters and digits — you&rsquo;ll write @{name.trim() || "Name"} in prompts.</span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-dim">A line about them</span>
              <input className="ctl" value={description} onChange={(e) => setDescription(e.target.value)} disabled={training}
                placeholder="e.g. mid-30s, close-cropped hair — what should stay true in every shot" maxLength={400} />
            </label>
          </div>

          {/* ── Photos ── */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-dim">Photos</span>
            <span className="text-[12px] text-mute">
              {photos.length} of {terms.maxPhotos} · {terms.recommended} is the sweet spot: one person, different angles, light and expressions, nobody else in frame.
            </span>
          </div>
          <div className="mt-2 grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(88px,1fr))]">
            {photos.map((pid) => (
              <span key={pid} className={`group relative block aspect-square overflow-hidden rounded-[10px] bg-thumb ${cover === pid ? "ring-2 ring-blue" : ""}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/uploads/${pid}`} alt="" className="h-full w-full object-cover" loading="lazy" />
                {!training && (
                  <>
                    <button type="button" onClick={() => setCover(pid)} title="Use as the cover"
                      className={`absolute bottom-1 left-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-on-ink ${cover === pid ? "bg-blue" : "reveal bg-black/55"}`}>
                      {cover === pid ? "Cover" : "Cover"}
                    </button>
                    <button type="button" onClick={() => { setPhotos((p) => p.filter((x) => x !== pid)); if (cover === pid) setCover(null); }}
                      className="reveal absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white" title="Remove">
                      <IconClose className="!h-3 !w-3" />
                    </button>
                  </>
                )}
              </span>
            ))}
            {!training && photos.length < terms.maxPhotos && (
              <button type="button" onClick={() => file.current?.click()} disabled={Boolean(busy)}
                className="grid aspect-square place-items-center rounded-[10px] border border-dashed border-hair text-mute hover:text-blue disabled:opacity-50" title="Add photos">
                <IconPlus />
              </button>
            )}
            <input ref={file} type="file" multiple hidden accept="image/jpeg,image/png,image/webp,image/heic"
              onChange={(e) => e.target.files && addPhotos(e.target.files)} />
          </div>

          {/* ── Training ── */}
          <div className="mt-5 rounded-[var(--r)] bg-panel2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-[13px] font-medium text-dim">Training</span>
              <span className="text-[12.5px] text-mute">
                About {money.price(terms.trainCostUsd, "identity-training")} for {terms.steps.toLocaleString()} steps, a few minutes on fal.ai. Renders afterwards are ~{money.price(terms.renderUsdPerMp, "fal-ai/flux-lora")} a still.
              </span>
            </div>
            {training && (
              <div className="mt-2">
                <div className="h-1.5 overflow-hidden rounded-full bg-chip">
                  <div className="h-full rounded-full bg-blue transition-[width] duration-700" style={{ width: `${progress ?? 4}%` }} />
                </div>
                <p className="mt-1.5 text-[12.5px] text-dim">
                  <ParticlSpinner size={12} className="mr-1.5 inline-block align-middle text-dim" />
                  {progress != null ? `${progress}% — learning the face` : "Queued at the trainer — this can take a minute to start"}. You can close this; it carries on.
                </p>
              </div>
            )}
            {identity?.status === "failed" && identity.error && (
              <p className="mt-2 rounded-[10px] bg-lift/8 px-3 py-2 text-[13px] text-lift">{identity.error}</p>
            )}
            {ready && (
              <p className="mt-2 text-[12.5px] text-ok">
                Trained {identity!.trainedAt ? timeAgo(identity!.trainedAt) : ""}. @{identity!.name} is in the cast too, so Seedance prompts can cite them.
              </p>
            )}
            {!terms.configured && (
              <p className="mt-2 text-[12.5px] text-mute">
                Training runs on fal.ai, which isn&rsquo;t connected yet — an admin connects it from Vercel. Photos can be gathered meanwhile.
              </p>
            )}
          </div>

          {/* ── Make shots ── */}
          {ready && identity && (
            <IdentityComposer identity={identity} projectId={projectId} />
          )}

          {err && <p className="mt-4 rounded-[10px] bg-lift/8 px-3 py-2 text-[13.5px] text-lift">{err}</p>}
        </div>

        <footer className="sheet-foot">
          <span className="text-[12.5px] text-mute">
            {busy ?? (isNew ? `Saved to ${projectId ? "this production" : "the whole workspace"}` : !enough ? `${terms.minPhotos - photos.length} more photo${terms.minPhotos - photos.length === 1 ? "" : "s"} before it can train` : "")}
          </span>
          <span className="ml-auto flex flex-wrap gap-2">
            {identity && !training && <button type="button" onClick={remove} className="chip !text-lift">Remove</button>}
            {(isNew || dirty) && (
              <button type="button" onClick={() => save(false)} disabled={Boolean(busy)} className="chip disabled:opacity-50">
                {isNew ? "Save as draft" : "Save changes"}
              </button>
            )}
            {!ready && (
              <button type="button" onClick={() => (isNew || dirty ? save(true) : train())} disabled={!canTrain}
                className="btn-render h-[36px] px-5 text-[14px] disabled:opacity-50"
                title={!terms.configured ? "fal.ai isn't connected" : !enough ? `Needs ${terms.minPhotos} photos` : ""}>
                <IconSparkle className="!h-4 !w-4" /> {identity?.status === "failed" ? "Train again" : "Train"}
              </button>
            )}
          </span>
        </footer>
      </div>
    </div>
  );
}

function StatusWord({ identity, progress }: { identity: IdentityView; progress: number | null }) {
  if (identity.status === "training") return <span className="text-blue">Training{progress != null ? ` ${progress}%` : "…"}</span>;
  if (identity.status === "ready") return <span className="text-ok">Ready</span>;
  if (identity.status === "failed") return <span className="text-lift">Training failed</span>;
  return <span>Draft · {identity.photos.length} photo{identity.photos.length === 1 ? "" : "s"}</span>;
}

/** Prompt → stills of this face. Every still is a render on the wall. */
function IdentityComposer({ identity, projectId }: { identity: IdentityView; projectId: string | null }) {
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<(typeof RATIOS)[number]>("16:9");
  const [count, setCount] = useState(2);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const { data, refresh } = useApi<{ generations: Gen[] }>(`/api/jobs?identityId=${encodeURIComponent(identity.id)}&limit=24&sync=0`, 0);
  const renders = data?.generations ?? [];
  const live = renders.some((g) => g.status === "queued" || g.status === "running");

  useEffect(() => {
    if (!live) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [live, refresh]);

  async function render() {
    if (!prompt.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/identities/${identity.id}/render`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, ratio, count, projectId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't render");
      setPrompt("");
      setTimeout(refresh, 600);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-5">
      <p className="text-[13px] font-medium text-dim">Put @{identity.name} in a shot</p>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); render(); } }}
        placeholder={`e.g. @${identity.name} on a rooftop at golden hour, wind in the hair, 85mm, shallow focus`}
        className="mt-2 w-full resize-none rounded-[12px] bg-chip px-3.5 py-3 text-[14.5px] text-bone placeholder:text-mute focus:bg-panel focus:outline-none" />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {RATIOS.map((r) => (
          <button key={r} type="button" onClick={() => setRatio(r)} className={`chip !py-1 !text-[12.5px] ${ratio === r ? "bg-blue text-on-ink" : ""}`}>{r}</button>
        ))}
        <span className="mx-1 text-mute">·</span>
        {[1, 2, 4].map((n) => (
          <button key={n} type="button" onClick={() => setCount(n)} className={`chip !py-1 !text-[12.5px] ${count === n ? "bg-blue text-on-ink" : ""}`}>{n} still{n === 1 ? "" : "s"}</button>
        ))}
        <button type="button" onClick={render} disabled={!prompt.trim() || busy}
          className="btn-render ml-auto h-[34px] px-4 text-[13.5px] disabled:opacity-50">
          {busy ? "Sending…" : "Generate"}
        </button>
      </div>
      {err && <p className="mt-2 rounded-[10px] bg-lift/8 px-3 py-2 text-[13px] text-lift">{err}</p>}

      {renders.length === 0 ? (
        <div className="mt-3"><Empty compact title="No shots yet" /></div>
      ) : (
        <div className="mt-3 grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(120px,1fr))]">
          {renders.map((g) => {
            const url = g.storedUrl ?? g.sourceUrl;
            const done = g.status === "succeeded" && url;
            return (
              <button key={g.id} type="button" onClick={() => setOpen(g.id)} title={g.prompt}
                data-gen-id={g.id} data-gen-prompt={g.prompt} data-gen-label={g.title || g.id.slice(-6).toUpperCase()} data-gen-title={g.title ?? ""}
                className="relative block aspect-square overflow-hidden rounded-[10px] bg-thumb">
                {done ? <LazyMedia url={url} kind="image" alt={g.prompt.slice(0, 80)} className="!absolute inset-0" />
                  : <span className="grid h-full w-full place-items-center text-[11px] text-mute">
                      {g.status === "failed" ? <span className="px-2 text-center text-lift">{g.error?.slice(0, 60) ?? "Failed"}</span> : <ParticlSpinner size={18} className="text-dim" />}
                    </span>}
              </button>
            );
          })}
        </div>
      )}
      <Boundary what="This take">
        <Theatre gens={renders} activeId={open && renders.some((g) => g.id === open) ? open : null}
          onClose={() => setOpen(null)} onSelect={setOpen} onChanged={refresh} />
      </Boundary>
    </div>
  );
}
