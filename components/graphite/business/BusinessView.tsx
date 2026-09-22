"use client";
import { useEffect, useMemo, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { resolveGenInput } from "@/lib/genAssetInput";
import type { ConsumerGenerationInput } from "@/lib/higgsfield-consumer/generation-contract";
import {
  AD_ASPECTS, AD_DURATIONS, AD_FORMATS_COPY, AD_MEDIA_MAX, AD_MEDIA_ROLES, AD_MODES, AD_RESOLUTIONS, ADS_MODEL, DTC_UNAVAILABLE, IMAGE_AD_RESOLUTIONS, IMAGE_ADS_MODEL,
  INITIAL_ADS, INITIAL_IMAGE_ADS, SETUP_TYPES, adsBlock, adsChipState, adsParameters, clampedDuration, imageAdsBlock, withAdReference, withMode, withSetup,
  type AdMediaRole, type AdMode, type AdsState, type ImageAdsState, type SetupItem, type SetupType,
} from "@/lib/shell/business";
import { useShell } from "@/lib/shell/state";
import { MarketingTemplateBrowser, MarketingTemplateCreator } from "@/components/suites/MarketingTemplates";
import { useBusiness, type CatalogueModel } from "@/lib/shell/use-business";
import { useConnectedJob, type ConnectedJobState } from "@/lib/shell/use-connected-job";
import { useEnhancer } from "@/lib/shell/use-enhancer";
import type { Project } from "@/lib/workbench/studio";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * Business = Higgsfield Marketing Studio (FINAL_SPEC §2): Ads on
 * `marketing_studio_video`, Image ads on `marketing_studio_image`, and Setup.
 * Both composers ride the catalogue-generation route (quote → the exact
 * price on the button → submit with that price → poll), which validates
 * every parameter against the account's live schema and imports the
 * reference stills before the quote.
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

/** Drag a Library still in; the roles cycle image → start_image → end_image on click. */
function Well({ scope, medias, roles, max, onAdd, onRemove, onRole, hint }: {
  scope: string; medias: (Media & { role?: AdMediaRole })[]; roles: readonly string[]; max: number; hint: string;
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
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const id = e.dataTransfer.getData("text/plain"); if (id) void drop(id); }}>
        {medias.length ? medias.map((m) => (
          <span className="gx-ref" key={m.id}>
            <span className="gx-ref-thumb"><LazyMedia url={m.url} kind="image" alt="" className="gx-lazy" /></span>
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

/** A setup-item picker: the account's items when it lists them, else the reason and a field for an id from the CLI. */
function SetupPicker({ label, note, type, business, value, onPick, disabled, why, testId }: {
  label: string; note?: string; type: SetupType; business: Business; value: string | null; onPick: (id: string | null) => void; disabled?: boolean; why?: string | null; testId?: string;
}) {
  const read = business.setup.reads[type];
  const [typed, setTyped] = useState("");
  const items = read?.items ?? [];
  return (
    <div className="gx-gen-row" data-testid={testId} data-off={disabled || undefined}>
      <span className="gx-eyebrow" data-functional-label="">{label}{note ? <span className="bz-note"> · {note}</span> : null}</span>
      {disabled && why ? <span className="gx-reason">{why}</span> : null}
      <div className="gx-chips" role="group" aria-label={label}>
        <button type="button" className="gx-chip" aria-pressed={value === null} aria-disabled={disabled || undefined} data-off={disabled || undefined} title={disabled ? why ?? undefined : undefined} onClick={() => { if (!disabled) onPick(null); }}>None</button>
        {items.map((item) => (
          <button key={item.id} type="button" className="gx-chip" aria-pressed={value === item.id} aria-disabled={disabled || undefined} data-off={disabled || undefined} title={disabled ? why ?? undefined : item.meta} onClick={() => { if (!disabled) onPick(item.id); }}>{item.name}</button>
        ))}
        {value && !items.some((i) => i.id === value) ? <button type="button" className="gx-chip" aria-pressed disabled title={value}>{value.slice(0, 8)}…</button> : null}
      </div>
      {read && !read.available ? (
        <div className="bz-idrow">
          <span className="cw-dim">The connected account does not list {label.toLowerCase()}s through its tools. Paste an id from <code>higgsfield marketing-studio {SETUP_TYPES.find((t) => t[0] === type)?.[2].split(" ·")[0]} --json</code>.</span>
          <input className="gx-field" aria-label={`${label} id`} placeholder={`${label} id`} value={typed} disabled={disabled} onChange={(e) => setTyped(e.target.value)} onBlur={() => { const id = typed.trim(); if (id) { onPick(id); setTyped(""); } }} />
        </div>
      ) : read && read.available && !items.length ? <span className="cw-dim">The account has no {label.toLowerCase()}s yet.</span> : null}
    </div>
  );
}

/** What Setup handed over with Use in Ads / Use in Image ads (this view only renders in the browser). */
const PRESET_KEY = "particl-business-preset";
function takePreset(): { type: SetupType; id: string } | null {
  try {
    const raw = sessionStorage.getItem(PRESET_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PRESET_KEY);
    const parsed = JSON.parse(raw) as { type?: string; id?: string };
    return typeof parsed.id === "string" && typeof parsed.type === "string" ? { type: parsed.type as SetupType, id: parsed.id } : null;
  } catch { return null; }
}

function priceLabel(state: ConnectedJobState, verb: string, blocked: string | null) {
  if (blocked) return verb;
  if (state.phase === "quoting") return `${verb} · pricing…`;
  if (state.phase === "quoted") return `${verb} · ${cr(state.job.quoteCredits)}`;
  if (state.phase === "submitting") return "Submitting…";
  if (state.phase === "running") return "Rendering…";
  return verb;
}

/* ── Ads ─────────────────────────────────────────────────────────────── */
function AdsView({ scope, project, business }: { scope: string; project: Project | null; business: Business }) {
  const shell = useShell();
  const ws = useWorkspace();
  const [s, set] = useState<AdsState>(() => {
    const preset = takePreset();
    if (!preset) return INITIAL_ADS;
    if (preset.type === "product") return { ...INITIAL_ADS, productId: preset.id };
    if (preset.type === "avatar") return { ...INITIAL_ADS, avatarId: preset.id };
    if (preset.type === "hook") return { ...INITIAL_ADS, hookId: preset.id };
    if (preset.type === "setting") return { ...INITIAL_ADS, settingId: preset.id };
    if (preset.type === "ad_reference") return { ...INITIAL_ADS, adReferenceId: preset.id };
    return INITIAL_ADS;
  });
  const job = useConnectedJob(project?.id ?? null);
  const model: CatalogueModel | undefined = business.models[ADS_MODEL];
  const connected = business.connection?.connected ?? false;
  const chips = adsChipState(s);
  const enhancer = useEnhancer({ prompt: s.prompt, mode: "video", model: ADS_MODEL, anchored: s.medias.some((m) => m.role === "start_image"), editing: false });
  const readSetup = business.readSetup, hasSetup = Boolean(business.setup.reads.hook), setupLoading = business.setup.loading;
  useEffect(() => { if (connected && !hasSetup && !setupLoading) void readSetup(["product", "avatar", "hook", "setting", "ad_reference"]); }, [connected, hasSetup, setupLoading, readSetup]);

  const aspects = (model?.aspectRatios?.length ? model.aspectRatios : AD_ASPECTS) as readonly string[];
  const resolutions = (model?.parameters?.find((p) => p.name === "resolution")?.options as string[] | undefined) ?? AD_RESOLUTIONS;
  const range = model?.durationRange ?? null;
  const blocked = adsBlock(s, { connected, hasProject: Boolean(project) }) ?? (model ? null : connected ? "Reading the connected catalogue…" : null);
  const clamped = clampedDuration(s, range);
  const input: ConsumerGenerationInput | null = useMemo(() => project && !blocked ? {
    type: "video", model: ADS_MODEL, prompt: enhancer.auto && enhancer.enhanced ? enhancer.enhanced : s.prompt.trim(),
    parameters: adsParameters(s, range),
    medias: s.medias.map((m) => ({ role: m.role, source: m.origin === "upload" ? { uploadId: m.sourceId } : { genId: m.sourceId } })),
  } : null, [project, blocked, s, range, enhancer.auto, enhancer.enhanced]);
  const inputKey = JSON.stringify(input);
  /* The button wears the account's exact price for exactly this input. */
  const quoteJob = job.quote, quotedFor = job.quotedFor, phase = job.state.phase;
  useEffect(() => {
    if (!input || quotedFor === inputKey || phase === "submitting" || phase === "running") return;
    const timer = setTimeout(() => void quoteJob(input, inputKey), 700);
    return () => clearTimeout(timer);
  }, [input, inputKey, quoteJob, quotedFor, phase]);
  useEffect(() => { if (phase === "done") ws.toast("Ad rendered and saved to your takes."); }, [phase, ws]);

  const media = (m: Media) => ({ ...m, role: "image" as AdMediaRole });
  return (
    <div className="gx-gen bz gx-enter" data-testid="ads-view">
      <section className="gx-gen-card" aria-label="Marketing Studio">
        <p className="bz-intro">Branded video: a product, who presents it, an optional hook or setting — or one ad reference — and the mode. Quoted before it runs; saved to your takes.</p>
        {!connected && business.connection ? <p className="gx-reason" data-testid="ads-connect">{business.connection.owner ? "Connect the account in Workspace › Engines." : "Only the workspace owner can run the connected account."}</p> : null}
        {business.catalogueError ? <p className="gx-gen-error" role="alert">{business.catalogueError}</p> : null}
        <Chips label="Mode" note="ugc is the default" options={AD_MODES} value={s.mode} onPick={(m) => set(withMode(s, m as AdMode))} testId="ads-mode" />
        <div className="gx-gen-row" data-testid="ads-product">
          <span className="gx-eyebrow" data-functional-label="">Product<span className="bz-note"> · product_ids · hooks are weak without one</span></span>
          <div className="gx-chips" role="group" aria-label="Product">
            <button type="button" className="gx-chip" aria-pressed={!s.productId && !s.fromUrl} onClick={() => set({ ...s, productId: null, fromUrl: false })}>None</button>
            {(business.setup.reads.product?.items ?? []).map((p) => <button key={p.id} type="button" className="gx-chip" aria-pressed={s.productId === p.id && !s.fromUrl} title={p.meta} onClick={() => set({ ...s, productId: p.id, fromUrl: false })}>{p.name}</button>)}
            <button type="button" className="gx-chip" aria-pressed={s.fromUrl} onClick={() => set({ ...s, fromUrl: true })}>From URL…</button>
          </div>
          {s.fromUrl ? <input className="gx-field" aria-label="Product URL" placeholder="https://… the product page (Click-to-Ad)" value={s.productUrl} onChange={(e) => set({ ...s, productUrl: e.target.value })} data-testid="ads-url" /> : null}
          {business.setup.reads.product && !business.setup.reads.product.available ? <span className="cw-dim">The connected account does not list products through its tools; From URL… fetches one by its page.</span> : null}
        </div>
        <SetupPicker label="Avatar" note="optional for UGC · the backend can synthesise a Soul Character" type="avatar" business={business} value={s.avatarId} onPick={(id) => set({ ...s, avatarId: id })} testId="ads-avatar" />
        <SetupPicker label="Hook" note={chips.hook.disabled ? undefined : "prepended to your prompt"} type="hook" business={business} value={s.hookId} onPick={(id) => set(withSetup(s, { hookId: id }))} disabled={chips.hook.disabled} why={chips.hook.why} testId="ads-hook" />
        <SetupPicker label="Setting" note="scene context" type="setting" business={business} value={s.settingId} onPick={(id) => set(withSetup(s, { settingId: id }))} disabled={chips.setting.disabled} why={chips.setting.why} testId="ads-setting" />
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
          <textarea className="gx-textarea" aria-label="Prompt" rows={4} placeholder="What the presenter says and shows. The hook is prepended automatically." value={s.prompt} onChange={(e) => set({ ...s, prompt: e.target.value })} data-testid="ads-prompt" />
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
        <Well scope={scope} medias={s.medias} roles={AD_MEDIA_ROLES} max={AD_MEDIA_MAX} hint="Reference stills · optional"
          onAdd={(m) => set({ ...s, medias: [...s.medias, media(m)] })} onRemove={(id) => set({ ...s, medias: s.medias.filter((m) => m.id !== id) })} onRole={(id, role) => set({ ...s, medias: s.medias.map((m) => (m.id === id ? { ...m, role } : m)) })} />
        {blocked ? <p className="gx-reason" id="bz-blocked" data-testid="ads-blocked">{blocked}</p> : null}
        {job.state.phase === "failed" ? <p className="gx-gen-error" role="alert" data-testid="ads-error">{job.state.error}</p> : null}
        <button type="button" className="gx-primary gx-gen-go" disabled={Boolean(blocked) || job.state.phase !== "quoted"} aria-describedby={blocked ? "bz-blocked" : undefined} onClick={() => void job.submit()} data-testid="ads-generate">
          {priceLabel(job.state, "Generate ad", blocked)}
        </button>
        {job.state.phase === "quoted" ? <p className="gx-gen-foot">{job.state.job.workspaceName ?? "Connected wallet"} · exact price from the account · saved to your takes</p> : null}
        {job.state.phase === "done" ? <p className="gx-gen-note" role="status" data-testid="ads-done">Rendered. It is in Takes and in Library › Assets. <button type="button" className="cw-link" onClick={() => { job.reset(); shell.goSuite("studio", "takes"); }}>Open Takes</button></p> : null}
      </section>
      <section className="gx-gen-results" aria-label="Setup items">
        <div className="gx-gen-results-head"><span className="gx-panel-title">Setup items</span><button type="button" className="gx-hbtn" onClick={() => shell.goSuite("business", "setup")}>Open Setup</button></div>
        <p className="cw-dim">Products, avatars, hooks, settings and ad references come from the connected account. Hooks and settings ride only with UGC, Tutorial, Unboxing, Product review and UGC try-on, and never with an ad reference.</p>
      </section>
    </div>
  );
}

/* ── Image ads ───────────────────────────────────────────────────────── */
function ImageAdsView({ scope, project, business }: { scope: string; project: Project | null; business: Business }) {
  const shell = useShell();
  const ws = useWorkspace();
  const [s, set] = useState<ImageAdsState>(INITIAL_IMAGE_ADS);
  const job = useConnectedJob(project?.id ?? null);
  const model: CatalogueModel | undefined = business.models[IMAGE_ADS_MODEL];
  const connected = business.connection?.connected ?? false;
  const aspects = (model?.aspectRatios?.length ? model.aspectRatios : ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "9:16", "16:9", "21:9"]) as readonly string[];
  const resolutions = (model?.parameters?.find((p) => p.name === "resolution")?.options as string[] | undefined) ?? IMAGE_AD_RESOLUTIONS;
  const blocked = imageAdsBlock(s, { connected, hasProject: Boolean(project) }) ?? (model ? null : connected ? "Reading the connected catalogue…" : null);
  const input: ConsumerGenerationInput | null = useMemo(() => project && !blocked ? {
    type: "image", model: IMAGE_ADS_MODEL, prompt: s.prompt.trim(), parameters: { aspect_ratio: s.aspect, resolution: s.resolution },
    medias: s.medias.map((m) => ({ role: "image", source: m.id.startsWith("generation:") ? { genId: m.id.slice("generation:".length) } : { uploadId: m.id.slice("upload:".length) } })),
  } : null, [project, blocked, s]);
  const inputKey = JSON.stringify(input);
  const quoteJob = job.quote, quotedFor = job.quotedFor, phase = job.state.phase;
  useEffect(() => {
    if (!input || quotedFor === inputKey || phase === "submitting" || phase === "running") return;
    const timer = setTimeout(() => void quoteJob(input, inputKey), 700);
    return () => clearTimeout(timer);
  }, [input, inputKey, quoteJob, quotedFor, phase]);
  useEffect(() => { if (phase === "done") ws.toast("Image ad rendered and saved to your takes."); }, [phase, ws]);
  return (
    <div className="gx-gen bz gx-enter" data-testid="image-ads-view">
      <section className="gx-gen-card" aria-label="Image ads">
        <p className="bz-intro">A branded ad image: the prompt, an optional product, avatar and up to 14 reference stills.</p>
        <p className="gx-reason" data-testid="dtc-unavailable">{DTC_UNAVAILABLE}</p>
        {!connected && business.connection ? <p className="gx-reason">{business.connection.owner ? "Connect the account in Workspace › Engines." : "Only the workspace owner can run the connected account."}</p> : null}
        <Chips label="Aspect" options={aspects} value={s.aspect} onPick={(v) => set({ ...s, aspect: v })} testId="dtc-aspect" />
        <Chips label="Resolution" options={resolutions} value={s.resolution} onPick={(v) => set({ ...s, resolution: v as ImageAdsState["resolution"] })} testId="dtc-resolution" />
        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">Prompt</span>
          <textarea className="gx-textarea" aria-label="Prompt" rows={4} placeholder="Bold hero shot on marble…" value={s.prompt} onChange={(e) => set({ ...s, prompt: e.target.value })} data-testid="dtc-prompt" />
        </div>
        <Well scope={scope} medias={s.medias.map((m) => ({ ...m, sourceId: m.id.replace(/^(upload|generation):/, ""), origin: m.id.startsWith("generation:") ? "generation" : "upload", url: "" }))} roles={["image"]} max={AD_MEDIA_MAX} hint="Reference media · ≤ 14"
          onAdd={(m) => set({ ...s, medias: [...s.medias, { id: m.id, name: m.name }] })} onRemove={(id) => set({ ...s, medias: s.medias.filter((m) => m.id !== id) })} />
        {blocked ? <p className="gx-reason" id="bz-blocked2" data-testid="dtc-blocked">{blocked}</p> : null}
        {job.state.phase === "failed" ? <p className="gx-gen-error" role="alert">{job.state.error}</p> : null}
        <button type="button" className="gx-primary gx-gen-go" disabled={Boolean(blocked) || job.state.phase !== "quoted"} aria-describedby={blocked ? "bz-blocked2" : undefined} onClick={() => void job.submit()} data-testid="dtc-generate">
          {priceLabel(job.state, "Generate image", blocked)}
        </button>
        {job.state.phase === "done" ? <p className="gx-gen-note" role="status">Rendered. It is in Takes and in Library › Assets. <button type="button" className="cw-link" onClick={() => { job.reset(); shell.goSuite("studio", "takes"); }}>Open Takes</button></p> : null}
      </section>
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
        <div className="gx-gen-results-head"><span className="gx-panel-title">Marketing Studio Image</span></div>
        <p className="cw-dim">Aspect auto needs a reference still; a prompt or at least one reference is required. Priced by the account before it runs.</p>
      </section>
    </div>
  );
}

/* ── Setup ───────────────────────────────────────────────────────────── */
function SetupView({ business }: { business: Business }) {
  const shell = useShell();
  const { dispatch } = useWorkspace();
  const connected = business.connection?.connected ?? false;
  const readSetup = business.readSetup, setupLoading = business.setup.loading, setupEmpty = !Object.keys(business.setup.reads).length;
  useEffect(() => { if (connected && !setupLoading && setupEmpty) void readSetup(); }, [connected, setupLoading, setupEmpty, readSetup]);
  const [selected, setSelected] = useState<SetupItem | null>(null);
  const rows = SETUP_TYPES.flatMap(([type]) => business.setup.reads[type]?.items ?? []);
  const sendTo = (item: SetupItem, page: "ads" | "dtc") => {
    try { sessionStorage.setItem(PRESET_KEY, JSON.stringify({ type: item.type, id: item.id })); } catch { /* the id is still on screen */ }
    dispatch({ type: "toast", text: `${item.name} selected for ${page === "ads" ? "Ads" : "Image ads"}` });
    shell.goSuite("business", page);
  };
  return (
    <div className="bz-setup gx-enter" data-testid="setup-view">
      <div className="bz-setup-list">
        {!connected && business.connection ? <p className="gx-reason">{business.connection.owner ? "Connect the account in Workspace › Engines." : "Only the workspace owner can run the connected account."}</p> : null}
        {business.setup.error ? <p className="gx-gen-error" role="alert">{business.setup.error}</p> : null}
        {SETUP_TYPES.map(([type, label, cli]) => {
          const read = business.setup.reads[type];
          return (
            <div className="bz-group" key={type} data-testid={`setup-${type}`}>
              <div className="bz-group-head"><span className="gx-eyebrow" data-functional-label="">{label}</span><span className="cw-mono">{cli}</span></div>
              {!read ? <span className="cw-dim">{business.setup.loading ? "Reading…" : connected ? "Not read yet." : "Connect the account to read these."}</span>
                : !read.available ? <span className="cw-dim">The connected account does not list {label.toLowerCase()} through its tools. Create and list them with <code>higgsfield marketing-studio {cli}</code>.</span>
                : !read.items.length ? <span className="cw-dim">None yet. <code>higgsfield marketing-studio {cli}</code></span>
                : read.items.map((item) => (
                  <button type="button" className="bz-row" key={item.id} aria-pressed={selected?.id === item.id} onClick={() => setSelected(item)}>
                    <span className="bz-row-name">{item.name}</span><span className="cw-dim">{item.meta}</span>
                  </button>
                ))}
            </div>
          );
        })}
        {connected ? <button type="button" className="gx-hbtn" disabled={business.setup.loading} onClick={() => void business.readSetup()}>{business.setup.loading ? "Reading…" : "Read again"}</button> : null}
        <p className="cw-dim">{rows.length} {rows.length === 1 ? "item" : "items"} · every row opens the Inspector with Use in Ads / Use in Image ads.</p>
      </div>
      {selected ? (
        <aside className="bz-detail" aria-label="Setup item" data-testid="setup-detail">
          <span className="gx-eyebrow">{SETUP_TYPES.find((t) => t[0] === selected.type)?.[1]}</span>
          <div className="gx-insp-title">{selected.name}</div>
          <div className="gx-insp-sub">{selected.meta}</div>
          <code className="cw-mono">{selected.id}</code>
          <div className="gx-insp-actions">
            {["product", "avatar", "hook", "setting", "ad_reference"].includes(selected.type) ? <button type="button" className="gx-hbtn" onClick={() => sendTo(selected, "ads")}>Use in Ads</button> : null}
            {["product", "avatar", "brand_kit"].includes(selected.type) ? <button type="button" className="gx-hbtn" onClick={() => sendTo(selected, "dtc")}>Use in Image ads</button> : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
