"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PromptAttach, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { dropToIds, isDroppable, readDrop } from "@/lib/drop";
import LazyMedia from "@/components/LazyMedia";
import { resolveGenInput } from "@/lib/genAssetInput";
import type { ConsumerGenerationInput } from "@/lib/higgsfield-consumer/generation-contract";
import { connectedOriginal, type ConnectedJob } from "@/lib/higgsfield-consumer/generation-client";
import {
  AD_ASPECTS, AD_DURATIONS, AD_FORMATS_COPY, AD_MEDIA_MAX, AD_MEDIA_ROLES, AD_MODES, AD_RESOLUTIONS, ADS_MODEL, DTC_BATCH, DTC_COPY, DTC_PRODUCTS_MAX, DTC_QUALITIES, IMAGE_AD_ENGINES, IMAGE_AD_RESOLUTIONS, INITIAL_ADS, INITIAL_IMAGE_ADS, isDtc,
  PRESET_KEY, PRESET_TYPES, SETUP_TYPES, adsBlock, adsChipState, adsFromPreset, adsMedias, adsParameters, clampedDuration, draftKey, imageAdsBlock, imageAdsFromPreset, imageAdsMedias,
  isOwnedSetup, parsePreset, presetFor, presetSpent, pruneAds, pruneImageAds, restoreAds, restoreImageAds, withAdReference, withImageStill, withMode, withProductId, withSetup, withStill,
  type AdMediaRole, type AdMode, type AdStill, type AdsState, type BusinessPage, type ImageAdsState, type SetupItem, type SetupPreset, type SetupType,
} from "@/lib/shell/business";
import { useShell } from "@/lib/shell/state";
import { MarketingTemplateBrowser, MarketingTemplateCreator } from "@/components/suites/MarketingTemplates";
import { useBusiness, type CatalogueModel } from "@/lib/shell/use-business";
import { composerBusy, useConnectedJob, type ConnectedJobState } from "@/lib/shell/use-connected-job";
import { useEnhancer } from "@/lib/shell/use-enhancer";
import type { Project } from "@/lib/workbench/studio";
import { uploadFilesToProject, useProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * Business = Marketing Studio (FINAL_SPEC §2): Ads on
 * `marketing_studio_video`, Image ads on `marketing_studio_image`, and Setup.
 * Both composers ride the catalogue-generation route (quote → the exact
 * price on the button → submit with that price → poll), which validates
 * every parameter against the account's live schema and imports the
 * reference stills before the quote.
 *
 * Particl is standalone: a product or a setting is a still from this
 * project's Library (picked, dropped or uploaded); avatars, hooks, settings
 * and ad styles are the engine's presets; the account's own library is never
 * listed (lib/higgsfield-consumer/marketing-records.ts).
 */
const cr = (n: number) => `${n.toLocaleString("en-US")} cr`;

export function BusinessView({ scope, project, page }: { scope: string; project: Project | null; page: "ads" | "dtc" | "setup" }) {
  const business = useBusiness(Boolean(scope));
  if (page === "setup") return <SetupView business={business} />;
  if (page === "dtc") return <ImageAdsView scope={scope} project={project} business={business} />;
  return <AdsView scope={scope} project={project} business={business} />;
}

type Business = ReturnType<typeof useBusiness>;
type Media = { id: string; name: string; sourceId: string; origin: "upload" | "generation"; url: string };
type Library = ReturnType<typeof useProjectLibrary>;

/**
 * What Setup handed over with Use in Ads / Use in Image ads, for this page
 * only (a pure read, so a second render reads the same); useSpentPreset
 * clears it once the page has it, so it never pre-selects anything later.
 */
function takePreset(page: BusinessPage): SetupPreset | null {
  if (typeof window === "undefined") return null;
  try { return parsePreset(sessionStorage.getItem(PRESET_KEY), page, Date.now()); } catch { return null; }
}
/** Setup → a page: leave the pick for that page to read once. */
function leavePreset(item: SetupItem, page: BusinessPage) {
  try { sessionStorage.setItem(PRESET_KEY, JSON.stringify(presetFor(item, page, Date.now()))); } catch { /* the pick is still on screen */ }
}
function useSpentPreset(page: BusinessPage) {
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(PRESET_KEY);
      if (presetSpent(raw, page, Date.now())) sessionStorage.removeItem(PRESET_KEY);
    } catch { /* nothing stored */ }
  }, [page]);
}

function readDraft<T>(key: string | null, restore: (raw: unknown) => T | null): T | null {
  if (!key) return null;
  try { const raw = sessionStorage.getItem(key); return raw ? restore(JSON.parse(raw)) : null; } catch { return null; }
}
/**
 * The composer's draft for this project (lib/shell/business.ts › Drafts): a
 * trip to Setup, Cast or the Library and back finds the ad as it was, and
 * Setup's pick lands on top of it. Read before paint and never on the server,
 * so the first render matches the server's.
 */
function useComposerDraft<T>(page: BusinessPage, scope: string, projectId: string | null, initial: T, restore: (raw: unknown) => T | null, apply: (preset: SetupPreset | null, current: T) => T): [T, (next: T) => void] {
  const key = projectId ? draftKey(scope, projectId, page) : null;
  const [draft, setDraft] = useState<{ key: string | null; value: T; ready: boolean }>({ key: null, value: initial, ready: false });
  /* Setup's pick is read once per mount and kept: a second strict-mode pass runs after useSpentPreset has cleared the store. */
  const pick = useRef<SetupPreset | null | undefined>(undefined);
  /* The first project the pick landed on; another project opened later starts from its own draft. */
  const landedOn = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (draft.ready && draft.key === key) return;
    if (pick.current === undefined) pick.current = takePreset(page);
    const landing = Boolean(pick.current) && (landedOn.current === null || landedOn.current === key);
    if (landing && key) landedOn.current = key;
    /* What was built before the project was known carries over; a switch between projects does not. */
    const base = readDraft(key, restore) ?? (!draft.ready || draft.key === null ? draft.value : initial);
    setDraft({ key, value: landing ? apply(pick.current!, base) : base, ready: true });
  }, [key, draft, page, initial, restore, apply]);
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

/** Drag a Library still in; the roles cycle image → start_image → end_image on click. */
function Well({ scope, projectId, medias, roles, max, onAdd, onRemove, onRole, hint }: {
  scope: string; projectId?: string | null; medias: (Media & { role?: AdMediaRole })[]; roles: readonly string[]; max: number; hint: string;
  onAdd: (m: Media) => void; onRemove: (id: string) => void; onRole?: (id: string, role: AdMediaRole) => void;
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
            {onRole && m.role ? (
              <button type="button" className="bz-role" title="Click to cycle the role" onClick={() => onRole(m.id, roles[(roles.indexOf(m.role!) + 1) % roles.length] as AdMediaRole)}>{m.role}</button>
            ) : null}
            <span className="gx-ref-name">{m.name}</span>
            <button type="button" className="gx-ref-x" aria-label={`Remove ${m.name}`} onClick={() => onRemove(m.id)}>×</button>
          </span>
        )) : <span className="gx-well-hint">Drag stills from the Library{onRole ? " — roles image · start_image · end_image" : ""}</span>}
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

/** A catalogue preview that is a picture (never a clip), for a chip's face. */
const pictureOf = (item: SetupItem) => (item.previewUrl && !/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(item.previewUrl) ? item.previewUrl : null);

/** The chips of one setup read: None plus what Particl may use. `still`: a still fills the slot, so None is not pressed. `faces`: show each preview. */
function SetupChips({ label, items, value, onPick, disabled, why, still, faces }: {
  label: string; items: readonly SetupItem[]; value: string | null; onPick: (id: string | null) => void; disabled?: boolean; why?: string | null; still?: boolean; faces?: boolean;
}) {
  return (
    <div className="gx-chips" role="group" aria-label={label}>
      <button type="button" className="gx-chip" aria-pressed={value === null && !still} aria-disabled={disabled || undefined} data-off={disabled || undefined} title={disabled ? why ?? undefined : undefined} onClick={() => { if (!disabled) onPick(null); }}>None</button>
      {items.map((item) => {
        const face = faces ? pictureOf(item) : null;
        return (
          <button key={item.id} type="button" className={face ? "gx-chip bz-chip-face" : "gx-chip"} aria-pressed={value === item.id} aria-disabled={disabled || undefined} data-off={disabled || undefined} title={disabled ? why ?? undefined : item.meta} onClick={() => { if (!disabled) onPick(item.id); }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- A catalogue preview, as the ad-format cards show theirs. */}
            {face ? <img src={face} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.hidden = true; }} /> : null}
            <span>{item.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A setup-item picker. While the read is in flight it shows its shape; once
 * read, a type with nothing Particl may use is not shown at all.
 */
function SetupPicker({ label, note, type, business, value, onPick, disabled, why, testId, faces }: {
  label: string; note?: string; type: SetupType; business: Business; value: string | null; onPick: (id: string | null) => void; disabled?: boolean; why?: string | null; testId?: string; faces?: boolean;
}) {
  const read = business.setup.reads[type];
  if (!read) return business.setup.loading ? <SetupSkeleton label={label} testId={testId} /> : null;
  if (!read.items.length) return null;
  return (
    <div className="gx-gen-row" data-testid={testId} data-off={disabled || undefined}>
      <Label label={label} note={note} />
      {disabled && why ? <span className="gx-reason">{why}</span> : null}
      <SetupChips label={label} items={read.items} value={value} onPick={onPick} disabled={disabled} why={why} faces={faces} />
    </div>
  );
}

function SetupSkeleton({ label, testId }: { label: string; testId?: string }) {
  return (
    <div className="gx-gen-row" data-testid={testId} aria-busy="true">
      <Label label={label} />
      <div className="gx-chips" aria-hidden="true"><span className="bz-skel" /><span className="bz-skel bz-skel--wide" /><span className="bz-skel" /></div>
    </div>
  );
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

/** After a failed price, a failed job or a finished take: the same input, priced again (a failure with its own Try again needs no second button). */
function PriceAgain({ job, blocked, testId }: { job: ReturnType<typeof useConnectedJob>; blocked: string | null; testId: string }) {
  if (blocked || job.canRetry || (job.state.phase !== "failed" && job.state.phase !== "done")) return null;
  return <button type="button" className="gx-hbtn" onClick={job.requote} data-testid={testId}>Price again</button>;
}

function priceLabel(state: ConnectedJobState, verb: string, blocked: string | null) {
  if (blocked) return verb;
  if (state.phase === "resuming") return "Checking the last take…";
  if (state.phase === "quoting") return `${verb} · pricing…`;
  if (state.phase === "quoted") return `${verb} · ${cr(state.job.quoteCredits)}`;
  if (state.phase === "submitting") return "Submitting…";
  if (state.phase === "running") return "Rendering…";
  return verb;
}

/** A failed quote or submit: the account's words, and Try again when nothing prices it again on its own. */
function JobError({ job, testId }: { job: ReturnType<typeof useConnectedJob>; testId: string }) {
  if (job.state.phase !== "failed") return null;
  return (
    <div className="gx-retry" role="alert" data-testid={testId}>
      <span className="gx-gen-error" data-testid={`${testId}-text`}>{job.state.error}</span>
      {job.canRetry ? <button type="button" className="gx-hbtn" onClick={job.requote}>Try again</button> : null}
    </div>
  );
}

/** After a few failed catalogue reads, the account is asked again only on request. */
function CatalogueAgain({ business }: { business: Business }) {
  return <div className="gx-retry"><button type="button" className="gx-hbtn" onClick={business.readCatalogue} data-testid="catalogue-again">Read again</button></div>;
}

/**
 * The finished take beside the composer. It stays while Price again (or a
 * change to the ad) prices the next run.
 */
function LatestTake({ job, testId, onTakes, onLibrary }: { job: ConnectedJob; testId: string; onTakes: () => void; onLibrary: () => void }) {
  const original = connectedOriginal(job), kind = original?.kind;
  const media = original && (kind === "image" || kind === "video") ? { url: original.url, kind } : null;
  return (
    <section className="gx-gen-results bz-latest" aria-label="Latest take" data-testid={testId}>
      <div className="gx-gen-results-head">
        <span className="gx-panel-title">Latest take</span>
        <span className="bz-done-actions">
          <button type="button" className="gx-hbtn" onClick={onTakes}>Open Takes</button>
          <button type="button" className="gx-hbtn" onClick={onLibrary}>Open Library</button>
        </span>
      </div>
      {media ? (
        <div className="bz-latest-media" data-testid={`${testId}-take`}>
          <LazyMedia url={media.url} kind={media.kind} alt="Latest take" name="Latest take" className="gx-lazy" hoverPlay={media.kind === "video"} />
        </div>
      ) : null}
      <p className="gx-gen-note" role="status">Rendered and filed to this project.</p>
    </section>
  );
}

/** The last finished take, shown while the composer is free: while a newer job is resumed, submitted or rendering, it is not "the latest". */
const latestTake = (job: ReturnType<typeof useConnectedJob>) => (composerBusy(job.state.phase) ? null : job.finished);

function Connection({ business, testId }: { business: Business; testId?: string }) {
  if (!business.connection || business.connection.connected) return null;
  return <p className="gx-reason" data-testid={testId}>{business.connection.owner ? "Connect the account in Workspace › Engines." : "Only the workspace owner can run the connected account."}</p>;
}

/* ── Ads ─────────────────────────────────────────────────────────────── */
function AdsView({ scope, project, business }: { scope: string; project: Project | null; business: Business }) {
  const shell = useShell();
  const library = useProjectLibrary(scope, project?.id ?? null);
  const [raw, set] = useComposerDraft("ads", scope, project?.id ?? null, INITIAL_ADS, restoreAds, adsFromPreset);
  useSpentPreset("ads");
  /* Once Setup is read, a pick it does not list (not Particl's, or gone) is dropped rather than sent. */
  const s = useMemo(() => pruneAds(raw, business.setup.reads), [raw, business.setup.reads]);
  /* One remembered job per composer (lib/shell/use-connected-job.ts): a switch away and back resumes it. */
  const job = useConnectedJob(project?.id ?? null, "ads", scope);
  const model: CatalogueModel | undefined = business.models[ADS_MODEL];
  const connected = business.connection?.connected ?? false;
  const chips = adsChipState(s);
  const sent = adsMedias(s);
  const enhancer = useEnhancer({ prompt: s.prompt, mode: "video", model: ADS_MODEL, anchored: s.medias.some((m) => m.role === "start_image"), editing: false });
  /* Read once; after a failure only Try again reads (never a loop against a refusing account). */
  const readSetup = business.readSetup, hasSetup = Boolean(business.setup.reads.hook), setupLoading = business.setup.loading, setupFailed = Boolean(business.setup.error);
  useEffect(() => { if (connected && !hasSetup && !setupLoading && !setupFailed) void readSetup([...PRESET_TYPES.ads]); }, [connected, hasSetup, setupLoading, setupFailed, readSetup]);

  const aspects = (model?.aspectRatios?.length ? model.aspectRatios : AD_ASPECTS) as readonly string[];
  const resolutions = (model?.parameters?.find((p) => p.name === "resolution")?.options as string[] | undefined) ?? AD_RESOLUTIONS;
  const range = model?.durationRange ?? null;
  const blocked = adsBlock(s, { connected, hasProject: Boolean(project) }) ?? business.modelBlock(ADS_MODEL);
  const clamped = clampedDuration(s, range);
  const input: ConsumerGenerationInput | null = useMemo(() => project && !blocked ? {
    type: "video", model: ADS_MODEL, prompt: enhancer.auto && enhancer.enhanced ? enhancer.enhanced : s.prompt.trim(),
    parameters: adsParameters(s, range),
    medias: adsMedias(s).map((m) => ({ role: m.role, source: m.origin === "upload" ? { uploadId: m.sourceId } : { genId: m.sourceId } })),
  } : null, [project, blocked, s, range, enhancer.auto, enhancer.enhanced]);
  const inputKey = JSON.stringify(input);
  /* The button wears the account's exact price for exactly this input. */
  const quoteJob = job.quote, quotedFor = job.quotedFor, phase = job.state.phase;
  /* Nothing is priced while a job is resumed, submitted or rendering; after a finished take, Price again prices the next one. */
  useEffect(() => {
    if (!input || quotedFor === inputKey || composerBusy(phase)) return;
    const timer = setTimeout(() => void quoteJob(input, inputKey), 700);
    return () => clearTimeout(timer);
  }, [input, inputKey, quoteJob, quotedFor, phase]);

  const media = (m: Media) => ({ ...m, role: "image" as AdMediaRole });
  const products = business.setup.reads.product?.items ?? [];
  const settings = business.setup.reads.setting?.items ?? [];
  const room = AD_MEDIA_MAX - (sent.length - s.medias.length);
  return (
    <div className="gx-gen bz gx-enter" data-testid="ads-view">
      <section className="gx-gen-card" aria-label="Marketing Studio">
        <Connection business={business} testId="ads-connect" />
        {business.setup.error ? <p className="gx-gen-error" role="alert" data-testid="ads-setup-error">{business.setup.error} <button type="button" className="cw-link" disabled={setupLoading} onClick={() => void readSetup([...PRESET_TYPES.ads])}>Try again</button></p> : null}
        <Chips label="Mode" note="ugc is the default" options={AD_MODES} value={s.mode} onPick={(m) => set(withMode(s, m as AdMode))} testId="ads-mode" />
        <StillSlot scope={scope} projectId={project?.id ?? null} library={library} label="Product" note="rides first among the references" testId="ads-product"
          still={s.productStill} onStill={(still) => set(withStill(s, "product", still))}>
          {products.length ? <SetupChips label="Product" items={products} value={s.productId} still={Boolean(s.productStill)} onPick={(id) => set(id ? withProductId(s, id) : withStill(withProductId(s, null), "product", null))} /> : null}
        </StillSlot>
        <SetupPicker label="Avatar" note="optional for UGC" type="avatar" business={business} value={s.avatarId} onPick={(id) => set({ ...s, avatarId: id })} testId="ads-avatar" faces />
        <SetupPicker label="Hook" note={chips.hook.disabled ? undefined : "prepended to your prompt"} type="hook" business={business} value={s.hookId} onPick={(id) => set(withSetup(s, { hookId: id }))} disabled={chips.hook.disabled} why={chips.hook.why} testId="ads-hook" />
        {/* A setting still is a reference still and rides with any mode; the engine's preset settings follow the hook rule. */}
        <StillSlot scope={scope} projectId={project?.id ?? null} library={library} label="Setting" note="scene context" testId="ads-setting"
          still={s.settingStill} onStill={(still) => set(withStill(s, "setting", still))}>
          {settings.length ? (<>
            {chips.setting.disabled && chips.setting.why ? <span className="gx-reason">{chips.setting.why}</span> : null}
            <SetupChips label="Setting" items={settings} value={s.settingId} still={Boolean(s.settingStill)} onPick={(id) => set(id ? withSetup(s, { settingId: id }) : withStill(withSetup(s, { settingId: null }), "setting", null))} disabled={chips.setting.disabled} why={chips.setting.why} />
          </>) : null}
        </StillSlot>
        <SetupPicker label="Ad reference" note="reference-driven — excludes hooks and settings" type="ad_reference" business={business} value={s.adReferenceId} onPick={(id) => set(withAdReference(s, id))} disabled={chips.adReference.disabled} why={chips.adReference.why} testId="ads-adref" />
        <Chips label="Aspect" options={aspects} value={s.aspect} onPick={(v) => set({ ...s, aspect: v as AdsState["aspect"] })} testId="ads-aspect" />
        <Chips label="Duration" note={range ? `${range.min}–${range.max} s` : "≥ 4 s"} options={AD_DURATIONS.map((d) => [d, `${d} s`] as const)} value={s.duration} onPick={(d) => set({ ...s, duration: d })} testId="ads-duration" />
        {clamped != null ? <p className="gx-gen-note" role="status" data-testid="ads-clamped">The account caps this at {clamped} s; that is what will be sent.</p> : null}
        <Chips label="Resolution" options={resolutions} value={s.resolution} onPick={(v) => set({ ...s, resolution: v as AdsState["resolution"] })} testId="ads-resolution" />
        <div className="gx-gen-row" data-testid="ads-audio">
          <span className="gx-eyebrow" data-functional-label="">Audio<span className="bz-note"> · generate_audio</span></span>
          <div className="gx-chips" role="group" aria-label="Audio">
            <button type="button" className="gx-chip" aria-pressed={s.audio} onClick={() => set({ ...s, audio: true })}>On</button>
            <button type="button" className="gx-chip" aria-pressed={!s.audio} onClick={() => set({ ...s, audio: false })}>Off</button>
          </div>
        </div>
        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">Prompt</span>
          <PromptAttach scope={scope} projectId={project?.id} testId="ads-attach" onAttach={async (attached) => { const { stills, note } = await attachStills(scope, attached, sent.length, AD_MEDIA_MAX); if (stills.length) set({ ...s, medias: [...s.medias, ...stills.map(media)] }); return note; }}><textarea className="gx-textarea" aria-label="Prompt" rows={4} placeholder="What the presenter says and shows. The hook is prepended automatically." value={s.prompt} onChange={(e) => set({ ...s, prompt: e.target.value })} data-testid="ads-prompt" /></PromptAttach>
          <div className="gx-gen-enhance">
            <button type="button" className="gx-toggle" role="switch" aria-checked={enhancer.auto} onClick={() => enhancer.setAuto(!enhancer.auto)}><span className="gx-toggle-dot" aria-hidden="true" /><span>Auto</span></button>
            <span className="gx-spacer" />
            {enhancer.blocked ? <span className="gx-reason">{enhancer.blocked}</span> : null}
            <button type="button" className="gx-hbtn" disabled={Boolean(enhancer.blocked) || enhancer.busy} onClick={enhancer.enhance}>{enhancer.busy ? "Enhancing…" : enhancer.credits == null ? "Enhance" : `Enhance · ${cr(enhancer.credits)}`}</button>
          </div>
          {enhancer.enhanced ? (
            <div className="gx-enhanced"><span className="gx-eyebrow">Enhanced</span><p>{enhancer.enhanced}</p>
              <div className="gx-enhanced-actions"><button type="button" className="gx-hbtn" onClick={() => { set({ ...s, prompt: enhancer.enhanced! }); enhancer.dismiss(); }}>Use this</button><button type="button" className="gx-hbtn" onClick={enhancer.dismiss}>Keep mine</button></div>
            </div>
          ) : null}
        </div>
        <Well scope={scope} projectId={project?.id} medias={s.medias} roles={AD_MEDIA_ROLES} max={room} hint="Reference stills · optional"
          onAdd={(m) => set({ ...s, medias: [...s.medias, media(m)] })} onRemove={(id) => set({ ...s, medias: s.medias.filter((m) => m.id !== id) })} onRole={(id, role) => set({ ...s, medias: s.medias.map((m) => (m.id === id ? { ...m, role } : m)) })} />
        {blocked ? <p className="gx-reason" id="bz-blocked" data-testid="ads-blocked">{blocked}</p> : null}
        {blocked && business.catalogueStalled ? <CatalogueAgain business={business} /> : null}
        <JobError job={job} testId="ads-error" />
        <PriceAgain job={job} blocked={blocked} testId="ads-requote" />
        <button type="button" className="gx-primary gx-gen-go" disabled={Boolean(blocked) || job.state.phase !== "quoted" || job.quotedFor !== inputKey} aria-describedby={blocked ? "bz-blocked" : undefined} onClick={() => void job.submit(inputKey)} data-testid="ads-generate">
          {priceLabel(job.state, "Generate ad", blocked)}
        </button>
        {job.state.phase === "quoted" ? <p className="gx-gen-foot">{job.state.job.workspaceName ?? "Connected wallet"} · exact price from the account · filed to this project</p> : null}
      </section>
      {latestTake(job) ? <LatestTake job={latestTake(job)!} testId="ads-done" onTakes={() => { job.reset(); shell.goSuite("studio", "takes"); }} onLibrary={() => shell.openLibrary("assets")} /> : null}
    </div>
  );
}

/* ── Image ads ───────────────────────────────────────────────────────── */
function ImageAdsView({ scope, project, business }: { scope: string; project: Project | null; business: Business }) {
  const shell = useShell();
  const library = useProjectLibrary(scope, project?.id ?? null);
  const [raw, set] = useComposerDraft("dtc", scope, project?.id ?? null, INITIAL_IMAGE_ADS, restoreImageAds, imageAdsFromPreset);
  useSpentPreset("dtc");
  const s = useMemo(() => pruneImageAds(raw, business.setup.reads), [raw, business.setup.reads]);
  const job = useConnectedJob(project?.id ?? null, "dtc", scope);
  const dtc = isDtc(s);
  const model: CatalogueModel | undefined = business.models[s.engine];
  const connected = business.connection?.connected ?? false;
  /* DTC needs the account's styles (the ad formats), brand kits and products; read once the engine is chosen. */
  const readSetup = business.readSetup, hasStyles = Boolean(business.setup.reads.image_style), setupLoading = business.setup.loading, setupFailed = Boolean(business.setup.error);
  useEffect(() => { if (dtc && connected && !hasStyles && !setupLoading && !setupFailed) void readSetup([...PRESET_TYPES.dtc]); }, [dtc, connected, hasStyles, setupLoading, setupFailed, readSetup]);
  const styles = business.setup.reads.image_style ? business.setup.reads.image_style.items.length : null;
  const sent = imageAdsMedias(s);
  const aspects = (model?.aspectRatios?.length ? model.aspectRatios : ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "9:16", "16:9", "21:9"]) as readonly string[];
  const resolutions = (model?.parameters?.find((p) => p.name === "resolution")?.options as string[] | undefined) ?? IMAGE_AD_RESOLUTIONS;
  const blocked = imageAdsBlock(s, { connected, hasProject: Boolean(project), styles }) ?? business.modelBlock(s.engine);
  const input: ConsumerGenerationInput | null = useMemo(() => project && !blocked ? {
    type: "image", model: s.engine, prompt: s.prompt.trim(),
    parameters: {
      aspect_ratio: s.aspect, resolution: s.resolution,
      ...(isDtc(s) ? { style_id: s.styleId!, quality: s.quality, batch_size: s.batch, ...(s.brandKitId ? { brand_kit_id: s.brandKitId } : {}), ...(s.productIds.length ? { product_ids: s.productIds } : {}) } : {}),
    },
    medias: imageAdsMedias(s).map((m) => ({ role: "image", source: m.id.startsWith("generation:") ? { genId: m.id.slice("generation:".length) } : { uploadId: m.id.slice("upload:".length) } })),
  } as ConsumerGenerationInput : null, [project, blocked, s]);
  const inputKey = JSON.stringify(input);
  const quoteJob = job.quote, quotedFor = job.quotedFor, phase = job.state.phase;
  /* Nothing is priced while a job is resumed, submitted or rendering; after a finished take, Price again prices the next one. */
  useEffect(() => {
    if (!input || quotedFor === inputKey || composerBusy(phase)) return;
    const timer = setTimeout(() => void quoteJob(input, inputKey), 700);
    return () => clearTimeout(timer);
  }, [input, inputKey, quoteJob, quotedFor, phase]);
  const products = business.setup.reads.product?.items ?? [];
  const room = AD_MEDIA_MAX - (sent.length - s.medias.length);
  return (
    <div className="gx-gen bz gx-enter" data-testid="image-ads-view">
      <section className="gx-gen-card" aria-label="Image ads">
        <div className="gx-gen-row" data-testid="dtc-engine">
          <span className="gx-eyebrow" data-functional-label="">Engine</span>
          <div className="gx-seg gx-seg--sm" role="tablist" aria-label="Image ads engine">
            {IMAGE_AD_ENGINES.map(([id, label]) => (
              <button key={id} type="button" role="tab" className="gx-seg-btn" aria-selected={s.engine === id} onClick={() => set({ ...s, engine: id })} data-testid={`dtc-engine-${id}`}><span>{label}</span></button>
            ))}
          </div>
          {dtc ? <p className="gx-hint" data-testid="dtc-copy">{DTC_COPY}</p> : null}
        </div>
        {business.setup.error && dtc ? <p className="gx-gen-error" role="alert">{business.setup.error} <button type="button" className="cw-link" disabled={setupLoading} onClick={() => void readSetup([...PRESET_TYPES.dtc])}>Try again</button></p> : null}
        {dtc ? (<>
          <SetupPicker label="Style" note="the ad format · required, no default" type="image_style" business={business} value={s.styleId} onPick={(id) => set({ ...s, styleId: id })} testId="dtc-style" />
          <SetupPicker label="Brand kit" note="optional · a completed kit" type="brand_kit" business={business} value={s.brandKitId} onPick={(id) => set({ ...s, brandKitId: id })} testId="dtc-brand-kit" />
          {products.length ? (
            <div className="gx-gen-row" data-testid="dtc-products">
              <Label label="Products" note={`made in Particl · up to ${DTC_PRODUCTS_MAX}`} />
              <div className="gx-chips" role="group" aria-label="Products">
                {products.map((p) => {
                  const on = s.productIds.includes(p.id);
                  return <button key={p.id} type="button" className="gx-chip" aria-pressed={on} title={p.meta} onClick={() => set({ ...s, productIds: on ? s.productIds.filter((id) => id !== p.id) : [...s.productIds, p.id].slice(0, DTC_PRODUCTS_MAX) })}>{p.name}</button>;
                })}
              </div>
            </div>
          ) : null}
          <Chips label="Quality" note="affects cost" options={DTC_QUALITIES} value={s.quality} onPick={(v) => set({ ...s, quality: v })} testId="dtc-quality" />
          <div className="gx-gen-row" data-testid="dtc-batch">
            <span className="gx-eyebrow" data-functional-label="">Batch<span className="bz-note"> · {DTC_BATCH.min}–{DTC_BATCH.max} images per job · cost scales</span></span>
            <div className="gx-stepper" role="group" aria-label="Images per job">
              <button type="button" aria-label="Fewer" disabled={s.batch <= DTC_BATCH.min} onClick={() => set({ ...s, batch: s.batch - 1 })}>–</button>
              <span data-testid="dtc-batch-count">{s.batch}</span>
              <button type="button" aria-label="More" disabled={s.batch >= DTC_BATCH.max} onClick={() => set({ ...s, batch: s.batch + 1 })}>+</button>
            </div>
          </div>
        </>) : null}
        <Connection business={business} />
        <StillSlot scope={scope} projectId={project?.id ?? null} library={library} label="Product" note="rides first among the references" testId="dtc-product"
          still={s.productStill} onStill={(still) => set(withImageStill(s, still))} />
        <Chips label="Aspect" options={aspects} value={s.aspect} onPick={(v) => set({ ...s, aspect: v })} testId="dtc-aspect" />
        <Chips label="Resolution" options={resolutions} value={s.resolution} onPick={(v) => set({ ...s, resolution: v as ImageAdsState["resolution"] })} testId="dtc-resolution" />
        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">Prompt</span>
          <PromptAttach scope={scope} projectId={project?.id} testId="dtc-attach" onAttach={async (attached) => { const { stills, note } = await attachStills(scope, attached, sent.length, AD_MEDIA_MAX); if (stills.length) set({ ...s, medias: [...s.medias, ...stills.map((m) => ({ id: m.id, name: m.name }))] }); return note; }}><textarea className="gx-textarea" aria-label="Prompt" rows={4} placeholder="Bold hero shot on marble…" value={s.prompt} onChange={(e) => set({ ...s, prompt: e.target.value })} data-testid="dtc-prompt" /></PromptAttach>
        </div>
        <Well scope={scope} projectId={project?.id} medias={s.medias.map((m) => ({ ...m, sourceId: m.id.replace(/^(upload|generation):/, ""), origin: m.id.startsWith("generation:") ? "generation" : "upload", url: m.id.startsWith("generation:") ? `/api/media/${m.id.slice(11)}` : `/api/uploads/${m.id.replace(/^upload:/, "")}` }))} roles={["image"]} max={room} hint={`Reference media · ≤ ${AD_MEDIA_MAX}`}
          onAdd={(m) => set({ ...s, medias: [...s.medias, { id: m.id, name: m.name }] })} onRemove={(id) => set({ ...s, medias: s.medias.filter((m) => m.id !== id) })} />
        {blocked ? <p className="gx-reason" id="bz-blocked2" data-testid="dtc-blocked">{blocked}</p> : null}
        {blocked && business.catalogueStalled ? <CatalogueAgain business={business} /> : null}
        <JobError job={job} testId="dtc-error" />
        <PriceAgain job={job} blocked={blocked} testId="dtc-requote" />
        <button type="button" className="gx-primary gx-gen-go" disabled={Boolean(blocked) || job.state.phase !== "quoted" || job.quotedFor !== inputKey} aria-describedby={blocked ? "bz-blocked2" : undefined} onClick={() => void job.submit(inputKey)} data-testid="dtc-generate">
          {priceLabel(job.state, "Generate image", blocked)}
        </button>
      </section>
      {latestTake(job) ? <LatestTake job={latestTake(job)!} testId="dtc-done" onTakes={() => { job.reset(); shell.goSuite("studio", "takes"); }} onLibrary={() => shell.openLibrary("assets")} /> : null}
      {/* Ad formats: the account's Marketing Studio templates, through the existing template client (browse → pick → create at the quoted price). */}
      <section className="gx-gen-card bz-formats" aria-label={AD_FORMATS_COPY.title} data-testid="ad-formats">
        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">Connected · Marketing Studio templates</span>
          <h2 className="gx-workflow-title">{AD_FORMATS_COPY.title}</h2>
          <p className="gx-hint">{AD_FORMATS_COPY.line}</p>
        </div>
        {project ? (
          <div className="pxw gx-legacy" data-testid="ad-formats-client">
            <MarketingTemplateBrowser key={`${scope}:${project.id}`} project={project} scope={scope} enabled={connected && business.connection?.owner !== false} />
            <MarketingTemplateCreator key={`template:${scope}:${project.id}`} project={project} scope={scope} enabled={connected && business.connection?.owner !== false} />
          </div>
        ) : <p className="gx-reason" role="status">Save your project first.</p>}
      </section>
      <section className="gx-gen-results" aria-label="About">
        <div className="gx-gen-results-head"><span className="gx-panel-title">{dtc ? "DTC Ads" : "Marketing Studio Image"}</span></div>
        <p className="cw-dim">{dtc ? "A style is required; a completed brand kit is optional; up to four products; 1–20 images per job. Priced by the account before it runs." : "Aspect auto needs a reference still; a prompt or at least one reference is required. Priced by the account before it runs."}</p>
      </section>
    </div>
  );
}

/* ── Setup ───────────────────────────────────────────────────────────── */
const PAGE_LABEL: Record<BusinessPage, string> = { ads: "Ads", dtc: "Image ads" };
function SetupView({ business }: { business: Business }) {
  const shell = useShell();
  const { dispatch } = useWorkspace();
  const connected = business.connection?.connected ?? false;
  const readSetup = business.readSetup, setupLoading = business.setup.loading, setupEmpty = !Object.keys(business.setup.reads).length, setupFailed = Boolean(business.setup.error);
  /* Read once; after a failure only Try again or Read again reads. */
  useEffect(() => { if (connected && !setupLoading && setupEmpty && !setupFailed) void readSetup(); }, [connected, setupLoading, setupEmpty, setupFailed, readSetup]);
  const [selected, setSelected] = useState<SetupItem | null>(null);
  const detail = useRef<HTMLElement>(null);
  useEffect(() => {
    /* Under 1024px the detail sits under the list: bring it into view, and then its actions — a short landscape stage cannot show all of it.
       On a portrait phone it is a sheet above the tab bar (business.css) and needs no scroll. */
    const el = detail.current;
    if (!selected || !el || typeof window === "undefined" || !window.matchMedia("(max-width: 1023px)").matches || getComputedStyle(el).position === "fixed") return;
    el.scrollIntoView({ block: "nearest" });
    el.querySelector<HTMLElement>(".gx-insp-actions")?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const read = !setupEmpty;
  const groups = SETUP_TYPES.filter(([type]) => (business.setup.reads[type]?.items.length ?? 0) > 0);
  const rows = groups.reduce((n, [type]) => n + (business.setup.reads[type]?.items.length ?? 0), 0);
  const sendTo = (item: SetupItem, page: BusinessPage) => {
    leavePreset(item, page);
    dispatch({ type: "toast", text: `${item.name} selected for ${PAGE_LABEL[page]}` });
    shell.goSuite("business", page);
  };
  return (
    <div className="bz-setup gx-enter" data-testid="setup-view" data-detail={selected ? "" : undefined}>
      <div className="bz-setup-list">
        <Connection business={business} testId="setup-connect" />
        {business.setup.error ? <p className="gx-gen-error" role="alert" data-testid="setup-error">{business.setup.error} <button type="button" className="cw-link" disabled={setupLoading} onClick={() => void readSetup()}>Try again</button></p> : null}
        {connected && !read && !setupFailed && (setupLoading || business.setup.connected === null) ? (
          <div className="bz-group" aria-busy="true" data-testid="setup-loading">
            <span className="gx-eyebrow">Reading…</span>
            {[0, 1, 2].map((i) => <span key={i} className="bz-skel bz-skel--row" aria-hidden="true" />)}
          </div>
        ) : null}
        {groups.map(([type, label, whose]) => (
          <div className="bz-group" key={type} data-testid={`setup-${type}`}>
            <div className="bz-group-head">
              <span className="gx-eyebrow" data-functional-label="">{label}</span>
              <span className="cw-dim">{whose === "owned" ? "Made in Particl" : "Engine presets"} · {business.setup.reads[type]!.items.length}</span>
            </div>
            {business.setup.reads[type]!.items.map((item) => (
              <button type="button" className="bz-row" key={item.id} aria-pressed={selected?.id === item.id && selected.type === item.type} onClick={() => setSelected(item)}>
                <span className="bz-row-name">{item.name}</span><span className="cw-dim">{item.meta}</span>
              </button>
            ))}
          </div>
        ))}
        {connected && read && !setupLoading && !rows ? (
          <div className="bz-group bz-empty" data-testid="setup-empty">
            <span className="bz-empty-title">Nothing to set up yet</span>
            <span className="cw-dim">Products and settings are stills from this project.</span>
            <div className="bz-done-actions">
              <button type="button" className="gx-hbtn bz-make" onClick={() => shell.goSuite("business", "ads")}>Open Ads</button>
              <button type="button" className="gx-hbtn" onClick={() => shell.openLibrary("assets")}>Open Library</button>
            </div>
          </div>
        ) : null}
        {connected && !setupFailed ? (
          <div className="bz-setup-foot">
            <span className="cw-dim" data-testid="setup-count">{rows} {rows === 1 ? "item" : "items"}</span>
            <button type="button" className="gx-hbtn" disabled={business.setup.loading} onClick={() => void business.readSetup()}>{business.setup.loading ? "Reading…" : "Read again"}</button>
          </div>
        ) : null}
      </div>
      {selected ? (
        <aside className="bz-detail" aria-label="Setup item" data-testid="setup-detail" ref={detail}>
          <div className="bz-detail-head">
            <span className="gx-eyebrow">{SETUP_TYPES.find((t) => t[0] === selected.type)?.[1]}{isOwnedSetup(selected.type) ? " · Particl’s" : ""}</span>
            <button type="button" className="gx-ref-x bz-detail-x" aria-label="Close" onClick={() => setSelected(null)}>×</button>
          </div>
          <div className="gx-insp-title">{selected.name}</div>
          {selected.meta ? <div className="gx-insp-sub">{selected.meta}</div> : null}
          <div className="gx-insp-actions">
            {(Object.keys(PRESET_TYPES) as BusinessPage[]).filter((page) => PRESET_TYPES[page].includes(selected.type)).map((page) => (
              <button key={page} type="button" className="gx-hbtn" onClick={() => sendTo(selected, page)}>Use in {PAGE_LABEL[page]}</button>
            ))}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
