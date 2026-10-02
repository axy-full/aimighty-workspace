"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PromptAttach, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { dropToIds, isDroppable, readDrop } from "@/lib/drop";
import LazyMedia from "@/components/LazyMedia";
import { resolveGenInput } from "@/lib/genAssetInput";
import { draftKey, type AdStill, type BusinessPage } from "@/lib/shell/business";
import {
  IMAGE_AD_ASPECTS, IMAGE_AD_BUILDS, IMAGE_AD_MAX, IMAGE_AD_PROMPT_MAX, IMAGE_AD_RESOLUTIONS, INITIAL_IMAGE_AD, PRESET_STILLS_MAX,
  imageAdBlock, imageAdBuild, imageAdRequest, qualityLabel, qualityOff, restoreImageAd, withBuild, withPreset, withProductStill, type ImageAdState,
} from "@/lib/shell/image-ads";
import { aboutCredits, estimateReason } from "@/lib/shell/key-estimate";
import { useShell } from "@/lib/shell/state";
import { useKeyTake } from "@/lib/shell/use-key-take";
import { useOpenTake } from "@/lib/shell/use-open-take";
import type { Generation } from "@/lib/jobs";
import { useSession } from "@/lib/session";
import { PresetPicker } from "./PresetPicker";
import type { Project } from "@/lib/workbench/studio";
import { uploadFilesToProject, useProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { OwnerRunCard } from "../OwnerRunCard";

/**
 * Business = Marketing Studio (FINAL_SPEC §2): Ads, Image ads and Setup.
 *
 * Image ads runs on Particl's API key for every workspace and every member
 * (lib/shell/image-ads.ts), through the one workspace-credit path — the
 * estimate on the button, then one send at that figure. Ads and Setup ran on
 * a signed-in Higgsfield account, whose sign-in is retired
 * (CLAUDE.md ground rule 10): each is the retired card, for
 * everyone, with the way to make the same kind of thing in Gen; Setup also
 * lists what Particl made (ParticlSetup, in BusinessSuite).
 *
 * A product or another still is one from this project's Library (picked,
 * dropped or uploaded).
 */
export function BusinessView({ scope, project, page }: { scope: string; project: Project | null; page: "ads" | "dtc" | "setup" }) {
  /* Image ads: Particl's API key, for everyone — nothing of the connected account is read for it. */
  if (page === "dtc") return <ImageAdsView scope={scope} project={project} />;
  /* Ads and Setup ran on the retired account: the one card, for everyone, on the first paint. */
  return <OwnerRunCard surface="business" scope={scope} aspect={project?.aspect} page />;
}


type Media = { id: string; name: string; sourceId: string; origin: "upload" | "generation"; url: string };
type Library = ReturnType<typeof useProjectLibrary>;

function readDraft<T>(key: string | null, restore: (raw: unknown) => T | null): T | null {
  if (!key) return null;
  try { const raw = sessionStorage.getItem(key); return raw ? restore(JSON.parse(raw)) : null; } catch { return null; }
}
/**
 * The composer's draft for this project (lib/shell/business.ts › Drafts): a
 * trip to Cast or the Library and back finds the ad as it was. Read before
 * paint and never on the server, so the first render matches the server's.
 */
function useComposerDraft<T>(page: BusinessPage, scope: string, projectId: string | null, initial: T, restore: (raw: unknown) => T | null): [T, (next: T) => void] {
  const key = projectId ? draftKey(scope, projectId, page) : null;
  const [draft, setDraft] = useState<{ key: string | null; value: T; ready: boolean }>({ key: null, value: initial, ready: false });
  useLayoutEffect(() => {
    if (draft.ready && draft.key === key) return;
    /* What was built before the project was known carries over; a switch between projects does not. */
    const base = readDraft(key, restore) ?? (!draft.ready || draft.key === null ? draft.value : initial);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate this project's tab-only draft before paint, never on the server.
    setDraft({ key, value: base, ready: true });
  }, [key, draft, initial, restore]);
  useEffect(() => {
    if (!draft.ready || !draft.key) return;
    try { sessionStorage.setItem(draft.key, JSON.stringify(draft.value)); } catch { /* the draft stays on screen */ }
  }, [draft]);
  const set = useCallback((value: T) => setDraft((d) => ({ ...d, value })), []);
  return [draft.value, set];
}


/** A Business prompt's attachments: pictures become reference stills, up to the well's limit; the rest stays in the Library. */
async function attachStills(scope: string, attached: Attached, have: number, max: number): Promise<{ stills: Media[]; note: string | null }> {
  const { media, unreadable } = await resolveAttached(scope, attached);
  const pictures = media.filter((m) => m.kind === "image");
  const stills = pictures.slice(0, Math.max(0, max - have)).map((m): Media => ({ id: m.key, name: m.name, sourceId: m.id, origin: m.origin, url: m.url }));
  const kept = [...unreadable, ...media.filter((m) => m.kind !== "image").map((m) => m.name), ...pictures.slice(stills.length).map((m) => m.name)];
  return { stills, note: keptNote(kept, `reference stills are pictures, up to ${max}.`) };
}

/** Drag Library stills in, up to the well's limit. */
function Well({ scope, projectId, medias, max, onAdd, onRemove, hint }: {
  scope: string; projectId?: string | null; medias: Media[]; max: number; hint: string;
  onAdd: (m: Media) => void; onRemove: (id: string) => void;
}) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drop = async (id: string) => {
    setError(null);
    if (medias.length >= max) { setError(`Up to ${max} reference stills.`); return; }
    try {
      const asset = await resolveGenInput(id, scope);
      if (asset.kind !== "image") throw new Error("Reference stills are images.");
      onAdd({ id: asset.key, name: asset.name, sourceId: asset.id, origin: asset.origin, url: asset.url });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "This file cannot be used as a reference."); }
  };
  return (
    <div className="gx-gen-row">
      <span className="gx-eyebrow" data-functional-label="">{hint}</span>
      <div className="gx-well" data-over={over} data-testid="business-well"
        onDragOver={(e) => { if (isDroppable(e.dataTransfer)) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setOver(false);
          const payload = readDrop(e.dataTransfer);
          void dropToIds(payload, { scope, projectId }).then(async ({ ids, notes }) => { for (const id of ids) await drop(id); if (notes.length) setError(notes.join(" ")); })
            .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The files could not be uploaded."));
        }}>
        {medias.length ? medias.map((m) => (
          <span className="gx-ref" key={m.id}>
            <span className="gx-ref-thumb"><LazyMedia url={m.url} kind="image" alt="" name={m.name} className="gx-lazy" /></span>
            <span className="gx-ref-name">{m.name}</span>
            <button type="button" className="gx-ref-x" aria-label={`Remove ${m.name}`} onClick={() => onRemove(m.id)}>×</button>
          </span>
        )) : <span className="gx-well-hint">Drag stills from the Library</span>}
      </div>
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
    </div>
  );
}

function Chips<T extends string | number>({ label, note, options, value, onPick, disabled, why, testId }: {
  label: string; note?: string; options: readonly (readonly [T, string] | T)[]; value: T | null; onPick: (v: T) => void;
  disabled?: (v: T) => boolean; why?: string | null; testId?: string;
}) {
  return (
    <div className="gx-gen-row" data-testid={testId}>
      <span className="gx-eyebrow" data-functional-label="">{label}{note ? <span className="bz-note"> · {note}</span> : null}</span>
      <div className="gx-chips" role="group" aria-label={label}>
        {options.map((o) => {
          const [v, text] = Array.isArray(o) ? (o as readonly [T, string]) : [o as T, String(o)];
          const off = disabled?.(v) ?? false;
          return <button key={String(v)} type="button" className="gx-chip" aria-pressed={value === v} aria-disabled={off || undefined} data-off={off || undefined} title={off ? why ?? undefined : undefined} onClick={() => { if (!off) onPick(v); }}>{text}</button>;
        })}
      </div>
    </div>
  );
}

function Label({ label, note }: { label: string; note?: string }) {
  return <span className="gx-eyebrow" data-functional-label="">{label}{note ? <span className="bz-note"> · {note}</span> : null}</span>;
}

const STILLS_SHOWN = 36;
/**
 * A named slot — Product, Setting — filled with one still from this project:
 * picked from its Library, dropped in (from the Library or the device), or
 * uploaded. The still rides first among the reference stills.
 */
function StillSlot({ scope, projectId, library, label, note, testId, still, onStill, disabled, why, children }: {
  scope: string; projectId: string | null; library: Library; label: string; note?: string; testId: string;
  still: AdStill | null; onStill: (still: AdStill | null) => void; disabled?: boolean; why?: string | null; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const stills = useMemo(() => library.items.filter((e): e is LibraryEntry & { url: string } => e.media === "image" && Boolean(e.url)).slice(0, STILLS_SHOWN), [library.items]);
  const loading = library.state.status === "idle" || library.state.status === "loading";

  const take = async (id: string) => {
    const asset = await resolveGenInput(id, scope);
    if (asset.kind !== "image") throw new Error(`The ${label.toLowerCase()} is a still image.`);
    onStill({ id: asset.key, name: asset.name, sourceId: asset.id, origin: asset.origin, url: asset.url });
    setOpen(false);
  };
  const run = async (work: () => Promise<string[]>) => {
    setError(null); setBusy(true);
    try { const notes = await work(); if (notes.length) setError(notes.join(" ")); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "This file cannot be used."); }
    finally { setBusy(false); }
  };
  const pick = (entry: LibraryEntry & { url: string }) => {
    setError(null); setOpen(false);
    onStill({ id: entry.take.id, name: entry.take.name, sourceId: entry.take.sourceId, origin: entry.asset.origin, url: entry.url });
  };
  const upload = (files: FileList | null) => {
    const chosen = files?.[0];
    if (!chosen || !projectId) return;
    void run(async () => {
      const { ids, notes } = await uploadFilesToProject(scope, projectId, [chosen]);
      if (!ids[0]) throw new Error(notes[0] ?? "The upload did not finish.");
      await take(ids[0]);
      return notes;
    });
  };

  return (
    <div className="gx-gen-row" data-testid={testId} data-off={disabled || undefined}>
      <Label label={label} note={note} />
      {disabled && why ? <span className="gx-reason">{why}</span> : null}
      {children}
      <div className="gx-well bz-slot" data-over={over} data-filled={still ? "" : undefined} data-testid={`${testId}-slot`}
        onDragOver={(e) => { if (!disabled && isDroppable(e.dataTransfer)) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setOver(false);
          if (disabled) return;
          const payload = readDrop(e.dataTransfer);
          void run(async () => {
            const { ids, notes } = await dropToIds(payload, { scope, projectId });
            if (!ids[0]) throw new Error(notes[0] ?? `Drop a still for the ${label.toLowerCase()}.`);
            await take(ids[0]);
            return notes;
          });
        }}>
        {still ? (
          <>
            <span className="bz-slot-thumb"><LazyMedia url={still.url} kind="image" alt="" name={still.name} className="gx-lazy" /></span>
            <span className="bz-slot-name" data-testid={`${testId}-name`}>{still.name}</span>
            <button type="button" className="gx-hbtn" aria-expanded={open} disabled={disabled || busy} onClick={() => setOpen(!open)}>Change</button>
            <button type="button" className="gx-ref-x" aria-label={`Remove ${still.name}`} onClick={() => { onStill(null); setOpen(false); }}>×</button>
          </>
        ) : (
          <button type="button" className="bz-slot-empty" aria-expanded={open} aria-disabled={disabled || undefined} disabled={busy} onClick={() => { if (!disabled) setOpen(!open); }} data-testid={`${testId}-choose`}>
            <span className="bz-slot-plus" aria-hidden="true">+</span>
            <span>{busy ? "Adding…" : `Pick, drop or upload a still`}</span>
          </button>
        )}
      </div>
      {open && !disabled ? (
        <div className="bz-pick" data-testid={`${testId}-stills`}>
          <div className="gx-soul-grid" role="group" aria-label={`${label} stills`}>
            <button type="button" className="gx-soul-still bz-upload" disabled={busy || !projectId} onClick={() => file.current?.click()} data-testid={`${testId}-upload`}>
              <span aria-hidden="true">+</span><span>Upload</span>
            </button>
            {stills.map((entry) => (
              <button key={entry.take.id} type="button" className="gx-soul-still" aria-pressed={still?.id === entry.take.id} aria-label={entry.take.name} title={entry.take.name} onClick={() => pick(entry)}>
                <LazyMedia url={entry.url} kind="image" alt="" name={entry.take.name} className="gx-lazy" />
              </button>
            ))}
            {loading && !stills.length ? [0, 1, 2].map((i) => <span key={i} className="gx-soul-still bz-skel-tile" aria-hidden="true" />) : null}
          </div>
          {library.state.status === "error" ? (
            <p className="gx-gen-error" role="alert">{library.state.error ?? "The Library could not be read."} <button type="button" className="cw-link" onClick={() => void library.refresh()}>Try again</button></p>
          ) : null}
        </div>
      ) : null}
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { upload(e.target.files); e.target.value = ""; }} data-testid={`${testId}-file`} />
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
    </div>
  );
}

/* ── Image ads (Particl's API key) ───────────────────────────────────── */
function ImageAdsView({ scope, project }: { scope: string; project: Project | null }) {
  const shell = useShell();
  const session = useSession();
  const library = useProjectLibrary(scope, project?.id ?? null);
  const [s, set] = useComposerDraft<ImageAdState>("dtc", scope, project?.id ?? null, INITIAL_IMAGE_AD, restoreImageAd);
  const take = useKeyTake(scope, project?.id ?? null, "business:image-ads");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  const production = project?.productionProjectId ?? null;
  const blocked = imageAdBlock(s, { hasProject: Boolean(project), saved: Boolean(production) });
  const request = useMemo(() => (!blocked && production ? imageAdRequest(s, { productionProjectId: production }) : null), [blocked, production, s]);
  const key = JSON.stringify(request);
  /* The estimate: read for exactly this request, again when it changes or ages; never while a press is being sent or followed. */
  const quote = take.quote, estimateKey = take.estimate?.key, estimateExpires = take.estimate?.expiresAt ?? 0, phase = take.run.phase;
  const busy = phase === "submitting" || phase === "running";
  useEffect(() => {
    if (!request || busy) return;
    if (estimateKey === key && estimateExpires > now) return;
    const timer = setTimeout(() => void quote(request, key), 700);
    return () => clearTimeout(timer);
  }, [request, key, quote, estimateKey, estimateExpires, now, busy]);
  const reason = blocked ?? estimateReason(take.estimate, key, now);
  const credits = !reason && take.estimate?.key === key ? take.estimate.credits : null;
  const estimateFailed = Boolean(!blocked && take.estimate?.key === key && take.estimate.error);
  const build = imageAdBuild(s.build);
  /* With a preset, a build that fixes the quality greys the others, with the reason. */
  const presetOff = s.preset && build.presetQuality ? qualityOff(s, "") : null;
  /* The well holds the stills after the product: with a preset, one more at most. */
  const wellMax = Math.max(0, (s.preset ? PRESET_STILLS_MAX : IMAGE_AD_MAX) - (s.productStill ? 1 : 0));
  const run = take.run;
  const running = run.phase === "running" ? run : null;
  const label = run.phase === "submitting" ? "Submitting…" : running ? "Rendering…" : credits != null ? `Generate image · ${aboutCredits(credits)}` : "Generate image";
  const runningWords = running ? (running.held ? "Held · it starts when credits arrive" : running.generation?.status === "queued" ? "Queued" : "Rendering") : null;
  const mayCancel = running?.generation?.status === "queued" && (session.role === "owner" || session.role === "admin" || session.userId === running.generation.createdBy);
  return (
    <div className="gx-gen bz gx-enter" data-testid="image-ads-view">
      <section className="gx-gen-card" aria-label="Image ads">
        <p className="bz-intro">Campaign stills built from your own product shots. Pick a preset to have the ad built around the product.</p>
        {/* 2.0 Alpha is priced live; a 2.5 build approximately, and the delivered image settles it (Moleculr's words). */}
        <Chips label="Model" note={build.approximate ? "priced approximately; the delivered image settles it" : "priced live before generating"}
          options={IMAGE_AD_BUILDS.map((b) => [b.id, b.label] as const)} value={s.build} onPick={(id) => set(withBuild(s, id))} testId="image-ad-build" />
        <StillSlot scope={scope} projectId={project?.id ?? null} library={library} label="Product" note="sent first · a preset starts from it" testId="image-ad-product"
          still={s.productStill} onStill={(still) => set(withProductStill(s, still))} />
        <PresetPicker scope={scope} value={s.preset} onPick={(preset) => set(withPreset(s, preset))} />
        <Chips label="Quality" note={presetOff && build.presetQuality ? `${qualityLabel(build.presetQuality).toLowerCase()} with a preset` : "affects cost"}
          options={build.qualities.map((q) => [q, qualityLabel(q)] as const)} value={s.quality} onPick={(q) => set({ ...s, quality: q })}
          disabled={(q) => Boolean(qualityOff(s, q))} why={presetOff} testId="image-ad-quality" />
        <Chips label="Aspect" options={IMAGE_AD_ASPECTS} value={s.aspect} onPick={(v) => set({ ...s, aspect: v })} testId="image-ad-aspect" />
        <Chips label="Size" options={IMAGE_AD_RESOLUTIONS} value={s.resolution} onPick={(v) => set({ ...s, resolution: v })} testId="image-ad-resolution" />
        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">Prompt</span>
          <PromptAttach scope={scope} projectId={project?.id} testId="image-ad-attach" onAttach={async (attached) => { const { stills, note } = await attachStills(scope, attached, s.medias.length, wellMax); if (stills.length) set({ ...s, medias: [...s.medias, ...stills] }); return note; }}>
            <textarea className="gx-textarea" aria-label="Prompt" rows={4} maxLength={IMAGE_AD_PROMPT_MAX} placeholder="Bold hero shot on marble…" value={s.prompt} onChange={(e) => set({ ...s, prompt: e.target.value })} data-testid="image-ad-prompt" />
          </PromptAttach>
        </div>
        <Well scope={scope} projectId={project?.id} medias={s.medias} max={wellMax} hint={s.preset ? "One more still · optional (a model shot)" : `More stills · optional · up to ${IMAGE_AD_MAX} with the product`}
          onAdd={(m) => set({ ...s, medias: [...s.medias, m] })} onRemove={(id) => set({ ...s, medias: s.medias.filter((m) => m.id !== id) })} />
        {reason ? (
          <div className="gx-retry">
            <p className="gx-reason" id="bz-blocked2" data-testid="image-ad-blocked">{reason}</p>
            {estimateFailed && request ? <button type="button" className="gx-hbtn" onClick={() => void take.quote(request, key)} data-testid="image-ad-retry">Try again</button> : null}
          </div>
        ) : null}
        {run.phase === "failed" ? <p className="gx-gen-error" role="alert" data-testid="image-ad-error">{run.error}</p> : null}
        {take.note ? <p className="gx-gen-note" role="status" data-testid="image-ad-note">{take.note}</p> : null}
        <button type="button" className="gx-primary gx-gen-go" disabled={Boolean(reason) || busy} aria-describedby={reason ? "bz-blocked2" : undefined}
          onClick={() => { if (request) void take.submit(request, key, credits); }} data-testid="image-ad-generate">{label}</button>
        {credits != null ? <p className="gx-gen-foot" data-testid="image-ad-foot">{build.approximate ? "An approximate price · the delivered image settles it" : "An estimate from the live price"} · filed to this project’s takes</p> : null}
        {running ? (
          <div className="bz-running" role="status" data-testid="image-ad-running">
            <span className="gx-gen-note">{runningWords} · {aboutCredits(running.credits)}</span>
            {mayCancel ? <button type="button" className="gx-hbtn" disabled={take.cancelling === running.jobId} onClick={() => void take.cancel(running.jobId)} data-testid="image-ad-cancel">{take.cancelling === running.jobId ? "Cancelling…" : "Cancel"}</button> : null}
          </div>
        ) : null}
      </section>
      {run.phase === "done" ? <LatestKeyTake generation={run.generation} scope={scope} project={project} onLibrary={() => shell.openLibrary("assets")} /> : null}
    </div>
  );
}

/** The finished still beside the composer (below it on a phone), with the way into Takes. */
function LatestKeyTake({ generation, scope, project, onLibrary }: { generation: Generation; scope: string; project: Project | null; onLibrary: () => void }) {
  const { openTake, opening } = useOpenTake(scope, project);
  const url = generation.storedUrl ?? `/api/media/${encodeURIComponent(generation.id)}`;
  return (
    <section className="gx-gen-results bz-latest" aria-label="Latest take" data-testid="image-ad-done">
      <div className="gx-gen-results-head">
        <span className="gx-panel-title">Latest take</span>
        <span className="bz-done-actions">
          <button type="button" className="gx-hbtn" disabled={opening !== null} onClick={() => void openTake(generation.id, generation.id, generation.createdAt)} data-testid="image-ad-done-open">{opening ? "Opening…" : "Open in Takes"}</button>
          <button type="button" className="gx-hbtn" onClick={onLibrary}>Open Library</button>
        </span>
      </div>
      <div className="bz-latest-media" data-testid="image-ad-done-take">
        <LazyMedia url={url} kind="image" alt="Latest take" name="Latest take" className="gx-lazy" />
      </div>
      <p className="gx-gen-note" role="status">Rendered and filed to this project.</p>
    </section>
  );
}
