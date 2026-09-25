"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PromptAttach, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { dropToIds, isDroppable, readDrop } from "@/lib/drop";
import { createPortal } from "react-dom";
import LazyMedia from "@/components/LazyMedia";
import { entryPreview, previewAttrs } from "@/lib/preview";
import { resolveGenInput } from "@/lib/genAssetInput";
import { ENHANCER_LABEL, isRawPrompt, type EnhanceMode } from "@/lib/shell/enhancer";
import { GEN_PRESET_KEY, readGenPreset, type GenPreset } from "@/lib/shell/assets";
import { useGenPresetInbox } from "@/lib/shell/gen-preset-inbox";
import { useReferenceInbox } from "@/lib/shell/reference-inbox";
import { useShell } from "@/lib/shell/state";
import { useEnhancer } from "@/lib/shell/use-enhancer";
import type { Project } from "@/lib/workbench/studio";
import { COMPOSER_TYPES, TAKES_MAX, type BillingSource, type ComposerType } from "@/lib/workspace/composer";
import { WORKFLOW_SURFACES } from "@/lib/shell/workflows";
import { WorkflowHost } from "./tools/WorkflowHost";
import { SeedanceEditHost } from "./tools/SeedanceEditHost";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { CONNECTED_GENERATION_ENDPOINT } from "@/lib/higgsfield-consumer/generation-client";
import type { ConnectedCharacter } from "@/lib/higgsfield-consumer/characters";
import { useComposer } from "@/lib/workspace/use-composer";
import { VirtualItems } from "@/components/workspace/VirtualItems";

const TYPE_TAB: Record<ComposerType, string> = { video: "Video", image: "Images", audio: "Audio" };
const ORDER: ComposerType[] = ["video", "image", "audio"];
const PLACEHOLDER: Record<ComposerType, string> = {
  video: "Describe the shot: subject, setting, camera move, light. @name cites a reference; raw: sends your words as written.",
  image: "Describe the frame: subject, setting, lens, light, medium. @name cites a reference; raw: sends your words as written.",
  audio: "Describe the sound, the voice or the music: source, setting, pace, texture.",
};
const GROUPS: { id: BillingSource; label: string }[] = [{ id: "workspace", label: "Studio engines" }, { id: "connected", label: "Higgsfield catalogue" }];
const FILTERS = ["All", "Images", "Video", "Audio"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_MEDIA: Record<Filter, LibraryEntry["media"] | "all"> = { All: "all", Images: "image", Video: "video", Audio: "audio" };

/** Gen (README › Gen): one composer on the left, this project's results on the right. */
export function GenView({ scope, project, items, workspaceName, onProject }: {
  scope: string; project: Project | null; items: LibraryEntry[]; workspaceName: string | null; onProject: (id: string) => void;
}) {
  const shell = useShell();
  const ws = useWorkspace();
  const composer = useComposer({ scope, open: true, project, onProject, workspaceName, initialType: "video" });
  const { state, model, offered, settings, blocked, buttonLabel, submitting } = composer;
  const [mode, setMode] = useState<"compose" | "analysis" | "edit">("compose");
  /* Soul models carry a trained character: the account's list is read once a Soul model is chosen. */
  const scopedFetch = useScopedFetch(scope);
  const [characters, setCharacters] = useState<{ list: ConnectedCharacter[] | null; note: string }>({ list: null, note: "Reading the account’s characters…" });
  const wantsCharacters = Boolean(model?.soulId) && state.billing === "connected";
  useEffect(() => {
    if (!wantsCharacters || characters.list) return;
    let live = true;
    void scopedFetch(CONNECTED_GENERATION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "characters" }) })
      .then(async (r) => { const json = await r.json().catch(() => null) as { connected?: boolean; available?: boolean; characters?: ConnectedCharacter[]; error?: string } | null; if (!r.ok) throw new Error(json?.error ?? "The account’s characters could not be read."); return json; })
      .then((json) => {
        if (!live) return;
        const list = json?.characters ?? [];
        const ready = list.filter((c) => c.status !== "training" && c.status !== "failed").length;
        setCharacters({ list, note: json?.connected === false ? "Connect the owner’s account in Workspace › Engines." : json?.available === false ? "The connected account does not advertise its characters." : ready ? `${ready} ${ready === 1 ? "identity" : "identities"} built in Particl.` : "No identity built in Particl yet — Cast › Build identity." });
      })
      .catch((error: unknown) => { if (live) setCharacters({ list: [], note: error instanceof Error ? error.message : "The account’s characters could not be read." }); });
    return () => { live = false; };
  }, [wantsCharacters, characters.list, scopedFetch]);
  const [sheet, setSheet] = useState(false);
  const [wellError, setWellError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [filter, setFilter] = useState<Filter>("All");
  const anchored = state.references.some((r) => r.kind === "video") || (state.type === "video" && state.references.length > 0);
  const enhancer = useEnhancer({
    prompt: state.prompt, mode: state.type as EnhanceMode, model: model?.id ?? null,
    anchored, editing: state.type === "image" && state.references.length > 0,
  });

  const dispatchComposer = composer.dispatch;
  const drop = useCallback(async (id: string) => {
    setWellError(null);
    try {
      const asset = await resolveGenInput(id, scope);
      if (asset.kind !== "image" && asset.kind !== "video") throw new Error("References are images and videos.");
      dispatchComposer({ type: "addReference", value: { key: asset.key, id: asset.id, origin: asset.origin, kind: asset.kind, name: asset.name, url: asset.url } });
    } catch (error) {
      setWellError(error instanceof Error ? error.message : "This file cannot be used as a reference.");
    }
  }, [scope, dispatchComposer]);

  /* A prompt handed over from elsewhere in the shell (Crew › Open in Gen, an
     asset's Retry generation) arrives once, then is forgotten. Read at mount
     (this view only renders in the browser) and applied to the composer. */
  const [preset] = useState(() => {
    try {
      const found = readGenPreset(sessionStorage.getItem(GEN_PRESET_KEY));
      if (found) sessionStorage.removeItem(GEN_PRESET_KEY);
      return found;
    } catch { return null; }
  });
  const applyPreset = useCallback((next: GenPreset) => {
    if (next.billing) dispatchComposer({ type: "billing", value: next.billing });
    if (next.type) dispatchComposer({ type: "type", value: next.type });
    if (next.model) dispatchComposer({ type: "model", value: next.model });
    if (next.prompt) dispatchComposer({ type: "prompt", value: next.prompt });
  }, [dispatchComposer]);
  useEffect(() => { if (preset) applyPreset(preset); }, [preset, applyPreset]);
  /* A preset sent while Gen is already open (⌘K › a model) applies at once. */
  useGenPresetInbox(applyPreset);
  const presetNote = preset?.note ?? null;

  /* The Library's `+`, a right-click or a drop on any page lands here as a reference. */
  const inbox = useCallback((letter: { id: string }) => { void drop(letter.id); }, [drop]);
  useReferenceInbox(inbox);

  /* Auto also asks a connected model whose schema declares enhance_prompt to enhance on the account (FINAL_SPEC §4). */
  const enhanceAuto = enhancer.auto;
  useEffect(() => { dispatchComposer({ type: "enhance", value: enhanceAuto }); }, [enhanceAuto, dispatchComposer]);

  /* Auto: when an enhancement is on the card, it is what gets submitted. */
  const pending = useRef(false);
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    composer.generate();
  }, [state.prompt, composer]);
  const generate = () => {
    if (enhancer.auto && enhancer.enhanced && enhancer.enhanced !== state.prompt && !isRawPrompt(state.prompt)) {
      pending.current = true;
      composer.dispatch({ type: "prompt", value: enhancer.enhanced });
      enhancer.dismiss();
      return;
    }
    composer.generate();
  };


  const results = useMemo(() => {
    const media = FILTER_MEDIA[filter];
    return items.filter((entry) => entry.take.kind === "GEN" && (media === "all" || entry.media === media));
  }, [items, filter]);
  const running = ws.state.gen;
  const takesReferences = state.type !== "audio" && (state.billing === "workspace" || Boolean(model?.referenceRoles?.length));
  /* The Direction box takes media: pictures and videos become references when this model takes them; the rest stays in the Library. */
  const attachToGen = async (attached: Attached) => {
    const { media, unreadable } = await resolveAttached(scope, attached);
    const used: string[] = [], kept = [...unreadable];
    for (const m of media) {
      if (takesReferences && (m.kind === "image" || m.kind === "video")) { dispatchComposer({ type: "addReference", value: { key: m.key, id: m.id, origin: m.origin, kind: m.kind, name: m.name, url: m.url } }); used.push(m.name); }
      else kept.push(m.name);
    }
    return [used.length ? `${used.join(", ")} ${used.length === 1 ? "is a reference" : "are references"}.` : "", keptNote(kept, takesReferences ? "references are pictures and video." : `${model?.label ?? "this model"} takes a prompt only.`) ?? ""].filter(Boolean).join(" ") || null;
  };
  const footer = [settings.ratio, model?.durations?.length ? `${settings.duration} s` : null, "Saved to your takes"].filter(Boolean).join(" · ");

  const analysis = WORKFLOW_SURFACES["gen:analysis"][0];
  const tabs = (
    <div className="gx-seg gx-seg--fill" role="tablist" aria-label="Output">
      {ORDER.filter((t) => COMPOSER_TYPES.includes(t)).map((t) => (
        <button key={t} type="button" role="tab" className="gx-seg-btn" aria-selected={mode === "compose" && state.type === t} onClick={() => { setMode("compose"); composer.dispatch({ type: "type", value: t }); }}><span>{TYPE_TAB[t]}</span></button>
      ))}
      <button type="button" role="tab" className="gx-seg-btn" aria-selected={mode === "edit"} onClick={() => setMode("edit")} data-testid="gen-tab-edit"><span>Edit</span></button>
      <button type="button" role="tab" className="gx-seg-btn" aria-selected={mode === "analysis"} onClick={() => setMode("analysis")} data-testid="gen-tab-analysis"><span>Analysis</span></button>
    </div>
  );
  if (mode === "edit") {
    return (
      <div className="gx-gen gx-enter" data-testid="gen-view">
        <div className="gx-gen-col">
          <section className="gx-gen-card" aria-label="Output">{tabs}</section>
          <SeedanceEditHost scope={scope} project={project} onBack={() => setMode("compose")} />
        </div>
      </div>
    );
  }
  if (mode === "analysis") {
    return (
      <div className="gx-gen gx-enter" data-testid="gen-view">
        <div className="gx-gen-col">
          <section className="gx-gen-card" aria-label="Output">{tabs}</section>
          <WorkflowHost surface={analysis} scope={scope} project={project} />
        </div>
      </div>
    );
  }
  return (
    <div className="gx-gen gx-enter" data-testid="gen-view">
      <section className="gx-gen-card" aria-label="Composer">
        {tabs}

        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">01 / Direction</span>
          {presetNote ? <p className="gx-gen-note" role="status" data-testid="gen-preset-note">{presetNote}</p> : null}
          <PromptAttach scope={scope} projectId={project?.id} onAttach={attachToGen} testId="gen-attach"><textarea className="gx-textarea" aria-label="Direction" rows={5} placeholder={PLACEHOLDER[state.type]} value={state.prompt}
            onChange={(e) => composer.dispatch({ type: "prompt", value: e.target.value })} data-testid="gen-prompt" /></PromptAttach>
          <div className="gx-gen-enhance">
            <button type="button" className="gx-toggle" role="switch" aria-checked={enhancer.auto} onClick={() => enhancer.setAuto(!enhancer.auto)} title="When an enhancement is on the card, it is what gets generated.">
              <span className="gx-toggle-dot" aria-hidden="true" /><span>Auto</span>
            </button>
            <span className="gx-spacer" />
            {enhancer.blocked ? <span className="gx-reason" data-testid="enhance-reason">{enhancer.blocked}</span> : null}
            <button type="button" className="gx-hbtn" disabled={Boolean(enhancer.blocked) || enhancer.busy} onClick={enhancer.enhance} data-testid="enhance">
              {enhancer.busy ? "Enhancing…" : enhancer.credits == null ? "Enhance" : `Enhance · ${enhancer.credits.toLocaleString("en-US")} cr`}
            </button>
          </div>
          {enhancer.error ? <p className="gx-gen-error" role="alert">{enhancer.error}</p> : null}
          {enhancer.enhanced ? (
            <div className="gx-enhanced" data-testid="enhanced-card">
              <span className="gx-eyebrow" data-functional-label="">Enhanced · {ENHANCER_LABEL[enhancer.provider ?? "higgsfield"]}{enhancer.charged != null ? ` · ${enhancer.charged.toLocaleString("en-US")} cr` : ""}</span>
              <p>{enhancer.enhanced}</p>
              <div className="gx-enhanced-actions">
                <button type="button" className="gx-hbtn" onClick={() => { composer.dispatch({ type: "prompt", value: enhancer.enhanced! }); enhancer.dismiss(); }} data-testid="enhanced-use">Use this</button>
                <button type="button" className="gx-hbtn" onClick={enhancer.dismiss} data-testid="enhanced-keep">Keep mine</button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">02 / Model</span>
          <button type="button" className="gx-model" aria-haspopup="dialog" aria-expanded={sheet} onClick={() => setSheet(true)} data-testid="gen-model">
            <span className="gx-tool-tag" aria-hidden="true">{(model?.label ?? "—").slice(0, 2).toUpperCase()}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span className="gx-model-name">{model?.label ?? "Choose a model"}</span>
              <span className="gx-model-sub">{state.billing === "connected" ? "Higgsfield catalogue" : "Studio engine"}</span>
            </span>
            <span aria-hidden="true" style={{ color: "var(--gx-text-3)" }}>▾</span>
          </button>
        </div>

        {model?.promptOnly ? <p className="cw-dim" data-testid="gen-prompt-only">{model.label} takes a prompt only — no references.</p> : null}
        {takesReferences ? (
          <div className="gx-gen-row">
            <span className="gx-eyebrow" data-functional-label="">References</span>
            <div className="gx-well" data-over={over} data-testid="gen-well"
              onDragOver={(e) => { if (isDroppable(e.dataTransfer)) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault(); setOver(false);
                /* A tile from anywhere, or files from the device (uploaded into the project first). */
                const payload = readDrop(e.dataTransfer, project?.assets);
                void dropToIds(payload, { scope, projectId: project?.id }).then(({ ids, notes }) => { ids.forEach((id) => void drop(id)); if (notes.length) setWellError(notes.join(" ")); })
                  .catch((error: unknown) => setWellError(error instanceof Error ? error.message : "The files could not be uploaded."));
              }}>
              {state.references.length ? state.references.map((r, i) => (
                <span className="gx-ref" key={r.key}>
                  <span className="gx-ref-thumb">{r.kind === "image" || r.kind === "video" ? <LazyMedia url={r.url} kind={r.kind} alt="" name={r.name} className="gx-lazy" /> : null}</span>
                  {model?.connected && (model.referenceRoles?.length ?? 0) > 1 ? (
                    <button type="button" className="bz-role" title="Click to cycle the role" data-testid="gen-ref-role" onClick={() => { const roles = model.referenceRoles!; const at = roles.indexOf(r.role ?? roles[0]); composer.dispatch({ type: "referenceRole", key: r.key, role: roles[(at + 1) % roles.length] }); }}>{r.role ?? model.referenceRoles![0]}</button>
                  ) : null}
                  <span className="gx-ref-name">@{r.kind === "video" ? "Video" : "Image"}{i + 1} · {r.name}</span>
                  <button type="button" className="gx-ref-x" aria-label={`Remove ${r.name}`} onClick={() => composer.dispatch({ type: "removeReference", key: r.key })}>×</button>
                </span>
              )) : <span className="gx-well-hint">Drag an asset here from the Library.</span>}
              {!shell.wide ? <button type="button" className="gx-hbtn" onClick={() => shell.openLibrary("assets")}>Open Library</button> : null}
            </div>
            {wellError ? <p className="gx-gen-error" role="alert">{wellError}</p> : null}
          </div>
        ) : null}

        {model?.soulId ? (
          <div className="gx-gen-row" data-testid="gen-identity">
            <label className="gx-eyebrow" htmlFor="gx-identity" data-functional-label="">Identity</label>
            <select id="gx-identity" className="gx-select" value={settings.soulId ?? ""} onChange={(e) => composer.dispatch({ type: "pick", value: { soulId: e.target.value } })} data-testid="gen-identity-pick">
              <option value="">No identity · prompt only</option>
              {(characters.list ?? []).map((c) => <option key={c.soulId} value={c.soulId} disabled={c.status === "training" || c.status === "failed"}>{c.name}{c.status && c.status !== "ready" ? ` · ${c.status}` : ""}</option>)}
            </select>
            <p className="gx-hint" data-testid="gen-identity-note">
              {characters.note}{" "}
              <button type="button" className="cw-link" onClick={() => shell.goSuite("studio", "cast")}>Build identity in Cast</button>
            </p>
          </div>
        ) : null}
        {model?.ratios?.length ? (
          <div className="gx-gen-row">
            <span className="gx-eyebrow" data-functional-label="">Aspect</span>
            <div className="gx-chips" role="group" aria-label="Aspect">
              {model.ratios.map((r) => <button key={r} type="button" className="gx-chip" aria-pressed={settings.ratio === r} onClick={() => composer.dispatch({ type: "pick", value: { ratio: r } })}>{r}</button>)}
            </div>
          </div>
        ) : null}
        {model?.resolutions?.length ? (
          <div className="gx-gen-row">
            <span className="gx-eyebrow" data-functional-label="">Resolution</span>
            <div className="gx-chips" role="group" aria-label="Resolution">
              {model.resolutions.map((r) => <button key={r} type="button" className="gx-chip" aria-pressed={settings.resolution === r} onClick={() => composer.dispatch({ type: "pick", value: { resolution: r } })}>{r}</button>)}
            </div>
          </div>
        ) : null}
        {model?.durations?.length ? (
          <div className="gx-gen-row">
            <label className="gx-eyebrow" htmlFor="gx-length" data-functional-label="">Length</label>
            <select id="gx-length" className="gx-select" value={settings.duration} onChange={(e) => composer.dispatch({ type: "pick", value: { duration: Number(e.target.value) } })} data-testid="gen-length">
              {model.durations.map((d) => <option key={d} value={d}>{d} s</option>)}
            </select>
          </div>
        ) : null}

        {state.notice ? <p className="gx-gen-note" role="status">{state.notice}</p> : null}
        {composer.projectNotice ? <p className="gx-gen-note" role="status">{composer.projectNotice}</p> : null}
        {blocked ? <p className="gx-reason" id="gx-gen-blocked" data-testid="gen-blocked">{blocked}</p> : null}
        {/* The takes stepper and the billing line sit outside the sticky block: on a phone the
            sticky Generate (GLASS_SPEC §3) is the button and its one-line foot, nothing taller. */}
        <div className="gx-gen-takes" data-testid="gen-takes">
            <span className="gx-hint">Takes</span>
            <div className="gx-stepper" role="group" aria-label="Takes per generate">
              <button type="button" aria-label="Fewer" disabled={state.count <= 1} onClick={() => composer.dispatch({ type: "count", value: state.count - 1 })}>–</button>
              <span data-testid="gen-takes-count">{state.count}</span>
              <button type="button" aria-label="More" disabled={state.count >= TAKES_MAX} onClick={() => composer.dispatch({ type: "count", value: state.count + 1 })}>+</button>
            </div>
        </div>
        <div className="gx-gen-cta">
          <button type="button" className="gx-primary gx-gen-go" disabled={Boolean(blocked) || submitting} aria-describedby={blocked ? "gx-gen-blocked" : undefined} onClick={generate} data-testid="gen-generate">
            {submitting ? "Submitting…" : buttonLabel}
          </button>
          <p className="gx-gen-foot">{footer}{enhancer.auto && enhancer.enhanced ? " · enhanced first" : ""}{model?.enhanceable && enhancer.auto && !isRawPrompt(state.prompt) ? " · enhanced on Higgsfield" : ""}</p>
        </div>
        <p className="gx-gen-foot">{composer.wording}</p>
      </section>

      <section className="gx-gen-results" aria-label="Results">
        <div className="gx-gen-results-head">
          <span className="gx-panel-title">Results</span>
          <div className="gx-chips" role="group" aria-label="Result kind">
            {FILTERS.map((f) => <button key={f} type="button" className="gx-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>)}
          </div>
        </div>
        <VirtualItems
          className="gx-gen-grid" items={results} getKey={(entry) => entry.take.id} layout={{ minColumnWidth: 180 }} gap={12} estimateRowHeight={190} scroll="ancestor"
          before={<>
          {running ? (
            <div className="gx-asset" data-testid="gen-running">
              <span className="gx-asset-thumb gx-running"><span className="gx-ring" style={{ background: "var(--gx-accent)" }} aria-hidden="true" /></span>
              <span className="gx-asset-name">{running.name ?? "Rendering"}</span>
              <span className="gx-asset-meta">{running.label ?? "Running"}</span>
            </div>
          ) : null}
          {composer.connectedEnhanced ? (
            <p className="gx-gen-note" role="status" data-testid="gen-enhanced-on-account"><span className="gx-eyebrow">Enhanced on the account</span> {composer.connectedEnhanced.slice(0, 400)}</p>
          ) : null}
          </>}
          renderItem={(entry) => (
            <div className="gx-asset" data-selected={ws.state.selKind === "take" && ws.state.selId === entry.take.id}>
              <button type="button" className="gx-asset-thumb" title={entry.take.name} draggable data-ctx={`asset:${entry.take.id}`} {...previewAttrs(entryPreview(entry))}
                onDragStart={(e) => { e.dataTransfer.setData("text/plain", entry.take.id); e.dataTransfer.effectAllowed = "copy"; }}
                onClick={() => { ws.dispatch({ type: "patch", patch: { selKind: "take", selId: entry.take.id } }); shell.openInspector(); }}>
                {entry.url && (entry.media === "image" || entry.media === "video") ? <LazyMedia url={entry.url} kind={entry.media} alt="" name={entry.take.name} className="gx-lazy" /> : entry.media === "audio" ? <span className="gx-badge">AUDIO</span> : null}
              </button>
              <span className="gx-asset-name">{entry.take.name}</span>
              <span className="gx-asset-meta">{entry.take.meta}</span>
            </div>
          )}
        />
        {!running && !results.length ? <p className="gx-empty">{project ? "Nothing generated in this project yet. What you make lands here, in Takes, and in Library › Assets." : "Open a project, or generate — the composer files a first project for you."}</p> : null}
      </section>

      {/* The veil leaves the stage island: a `backdrop-filter` ancestor would contain its `position: fixed`
          (the sheet then rises inside the scroll region, under the phone's tab bar). It lands on the shell
          root so the tokens still reach it. */}
      {sheet ? createPortal(
        <div className="gx-veil" onClick={() => setSheet(false)} data-testid="model-sheet-veil">
          <div className="gx-sheet" role="dialog" aria-modal="true" aria-label="Choose a model" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setSheet(false); } }}>
            <div className="gx-sheet-head">
              <span className="gx-panel-title">Model</span>
              <div className="gx-seg gx-seg--sm" role="tablist" aria-label="Catalogue">
                {GROUPS.map((g) => <button key={g.id} type="button" role="tab" className="gx-seg-btn" aria-selected={state.billing === g.id} onClick={() => composer.dispatch({ type: "billing", value: g.id })}><span>{g.label}</span></button>)}
              </div>
              <button type="button" className="gx-hbtn" onClick={() => setSheet(false)}>Close</button>
            </div>
            <div className="gx-sheet-list gx-scroll" role="listbox" aria-label={`${TYPE_TAB[state.type]} models`}>
              {offered.map((m) => (
                <button key={m.id} type="button" role="option" aria-selected={m.id === model?.id} className="gx-sheet-row" onClick={() => { composer.dispatch({ type: "model", value: m.id }); setSheet(false); }}>
                  <span className="gx-tool-tag" aria-hidden="true">{m.label.slice(0, 2).toUpperCase()}</span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="gx-model-name">{m.label}</span>
                    <span className="gx-model-sub">{m.description ? m.description.slice(0, 90) : TYPE_TAB[m.type]}</span>
                    <span className="gx-model-sub" data-testid="gen-sheet-facts">{[m.ratios?.length ? `${m.ratios.length} aspects` : null, m.durations?.length ? (m.durations.length > 4 && m.durations[m.durations.length - 1] - m.durations[0] === m.durations.length - 1 ? `${m.durations[0]}–${m.durations[m.durations.length - 1]} s, every second` : m.durations.map((d) => `${d}`).join("/") + " s") : null, m.promptOnly ? "prompt only" : m.referenceRoles?.length ? m.referenceRoles.join(" · ") : null, m.enhanceable ? "enhances on the account" : null].filter(Boolean).join(" · ")}</span>
                  </span>
                  {m.id === model?.id ? <span aria-hidden="true" style={{ color: "var(--gx-accent-text)" }}>✓</span> : null}
                </button>
              ))}
              {!offered.length ? <p className="gx-empty">{state.billing === "connected" ? "No Higgsfield models for this output. Connect the account in Workspace › Engines, or choose a Studio engine." : "No Studio engine is connected for this output."}</p> : null}
            </div>
          </div>
        </div>,
        document.querySelector(".gx") ?? document.body,
      ) : null}
    </div>
  );
}
