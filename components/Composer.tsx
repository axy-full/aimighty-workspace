"use client";

/**
 * The island: one floating surface with everything a render needs, the way
 * the best generation tools do it — references ride on top, the prompt in
 * the middle, and every control is a chip on the bottom row rather than a
 * settings list somewhere else. Menus open upward; the cost is on the
 * button before it is pressed.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { menuPlacement, type Placement } from "@/lib/menuPlacement";
import { useMoney } from "@/lib/price";

/**
 * Close on any pointer-down outside `ref` and on Escape. Menus used to rely
 * on a fixed full-screen backdrop, but the island's backdrop-filter makes
 * it the containing block for fixed descendants, so that backdrop only ever
 * covered the island and a click on the wall never closed anything.
 */
function useDismiss(ref: React.RefObject<HTMLElement | null>, open: boolean, onClose: () => void, also?: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      // The menu itself may be rendered at the top of the document, away from its chip.
      if (!ref.current?.contains(t) && !also?.current?.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, onClose, also]);
}
import References, { type RefItem, type RefPicker } from "./References";
import { Switch } from "./Panel";
import type { Gen } from "./GenCard";
import { ParticlSpinner } from "./ParticlMark";
import { compactTokens } from "@/lib/format";
import { MODELS, estimateCostUsd, estimateImageCostUsd, type ModelDef, perSecondRate } from "@/lib/models";
import { IconArrowUp, IconCaret, IconAttach, IconSliders, IconClose } from "./Icons";
import LazyMedia from "./LazyMedia";
import { readDraggedAsset, readDraggedCast } from "@/lib/dnd";
import { movesFor, getTask, type EditMove, type TaskId, type LockedTaskId } from "@/lib/tasks";
import type { Params } from "./Workspace";
import { COUNTS } from "@/lib/variations";
import { ruleLine } from "@/lib/approvalRule";

type Menu = null | "model" | "dur" | "ratio" | "res" | "more" | "cost" | "orient";

export type Engine = { id: string; label: string; configured: boolean };
export type ApprovalInfo = { rule: "anyone" | "cap" | "producer"; shotCapCredits: number };
export type WriterInfo = { writer: "none" | "byteplus" | "claude"; label: string; via: string; configured: boolean; usdPerCall?: number };

export type ComposerProps = {
  prompt: string; setPrompt: (v: string) => void;
  promptRef: React.RefObject<HTMLTextAreaElement | null>;
  params: Params; patch: (p: Partial<Params>) => void;
  model: ModelDef; engines: Engine[]; writer?: WriterInfo | null;
  /** The workspace's cost approval rule, said before the press when it applies (brief 2.2). */
  approval?: ApprovalInfo | null;
  /** The engine rule surfaced as a suggestion, and the plateau's offer of a fresh render (brief 2.5). */
  suggestion?: { label: string; why: string } | null; onSuggestion?: () => void;
  plateau?: { passes: number } | null; onFresh?: () => void;
  refs: RefItem[]; setRefs: React.Dispatch<React.SetStateAction<RefItem[]>>;
  picker: React.MutableRefObject<RefPicker>; cite: (token: string) => void;
  /** The source is null until a clip is chosen — a mode can be picked first. */
  taskOn: { id: LockedTaskId; gen: Gen | null } | null; cancelTask: () => void;
  /** The uploaded clip standing in as the task's source, when the tray's one video is it. */
  uploadSource?: { filename: string } | null;
  /** Choose an engine and what to do with it, in one act. */
  pickMode: (modelId: string, task: TaskId) => void;
  onPickSource: () => void;
  /** The message to show, whatever its cause. */
  problem: string | null;
  /** The problem is informational, not a fault. */
  notice?: boolean;
  /** Whether the references make a submit impossible — the only thing that
   *  disables the button. A failed submit is shown, never locked in. */
  blocked: boolean;
  est: { net: number } | null; estTokens: number | null; dims: { w: number; h: number } | null;
  /** The frame the vendor bills, when it differs from the file's own. */
  billed?: { w: number; h: number } | null;
  /** The trained cast name the prompt cites, when one does (brief 1.3). */
  trainedCited?: string | null;
  /** How many variations one press makes (brief 1.6): 1–4 for video, 1–8 for stills. */
  count?: number; setCount?: (n: number) => void;
  /** What the prompt writer will add to this press, in dollars — zero when it will not run (brief 1.8). */
  writerUsd?: number;
  inputSeconds: number; hasVideoInput: boolean; imageRefCount: number;
  busy: boolean; onRender: () => void;
  /** Our own renders attached to this one, and how to take one off. */
  ownRefs: Gen[];
  dropOwnRef: (id: string) => void;
  /** A render dragged in from the rail. */
  onDropAsset: (gen: Gen) => void;
  setupCount: number; setupOpen: boolean; toggleSetup: () => void;
  /** Which kind of thing this composer makes — the model menu shows only those. */
  kind: "video" | "image";
  /** Rendered inside the right rail: the rail's foot owns the Render button
   *  and the price, and the rail's blocks own Setup, so those go. */
  rail?: boolean;
};

export default function Composer(p: ComposerProps) {
  const {
    prompt, setPrompt, promptRef, params, patch, model, engines, writer, approval = null, suggestion = null, onSuggestion, plateau = null, onFresh,
    refs, setRefs, picker, cite, taskOn, cancelTask, uploadSource = null, problem, blocked, notice,
    est, estTokens, dims, billed = null, trainedCited = null, count = 1, setCount, writerUsd = 0, inputSeconds, hasVideoInput, imageRefCount,
    busy, onRender, setupCount, setupOpen, toggleSetup, kind, ownRefs, dropOwnRef,
    pickMode, onPickSource, onDropAsset, rail = false,
  } = p;
  const [menu, setMenu] = useState<Menu>(null);
  const money = useMoney();
  const price = money.price;
  const [drag, setDrag] = useState(false);
  const overlayEl = useRef<HTMLDivElement>(null);
  const costRef = useRef<HTMLSpanElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  /** Write a recognised phrasing and put the caret where the words go. */
  const applyMove = useCallback((m: EditMove) => {
    const at = m.template.indexOf("{}");
    const text = m.template.replace("{}", "");
    setPrompt(text);
    // After the value has landed, or the selection would be clobbered by it.
    requestAnimationFrame(() => {
      const el = promptRef.current;
      if (!el) return;
      el.focus();
      const pos = at >= 0 ? at : text.length;
      el.setSelectionRange(pos, pos);
    });
  }, [setPrompt, promptRef]);
  useDismiss(costRef, menu === "cost", closeMenu);
  const isImage = model.kind === "image";
  /* The chip says what you are about to do, not merely which engine. */
  const modeLabel = taskOn ? `${model.label} ${getTask(taskOn.id).label}` : model.label;
  /* Tasks that follow a clip: no duration or ratio to choose, and the price
     is the clip's seconds times the rate. */
  const taskDef = taskOn ? getTask(taskOn.id) : null;
  const followsSource = taskDef?.forceDuration === "source";
  /* A still whose prompt cites a trained name renders through Flux with that
     identity (brief 1.3): the parent priced it so; the margin key follows. */
  const priceModelId = trainedCited ? "fal-ai/flux-lora" : params.modelId;
  const promptOptional = Boolean(taskDef?.promptOptional);
  const falTask = taskOn?.id === "motion" || taskOn?.id === "upscale" || taskOn?.id === "reframe";
  const sourceSecs = taskOn?.gen ? Number((taskOn.gen.params as { duration?: number }).duration ?? 0) || 0 : 0;
  const billedSecs = followsSource ? sourceSecs : params.duration;
  const estOpts = { audio: params.generateAudio, task: taskOn?.id, fps60: params.fps60 };
  const secondRate = perSecondRate(params.modelId, params.resolution, estOpts);

  // The prompt box grows with its text, and the highlight layer must track
  // the textarea's scroll exactly or the coloured @cites drift.
  const fit = useCallback(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    if (overlayEl.current) overlayEl.current.scrollTop = el.scrollTop;
  }, [promptRef]);
  useEffect(() => { fit(); }, [prompt, fit]);
  useEffect(() => {
    const el = promptRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, promptRef]);

  // Prompt text with @cites picked out, painted under a transparent textarea.
  const segments = useMemo(() => {
    const out: { t: string; tag: boolean }[] = [];
    // @image1 counts as much as @Image1 — the server reads both — while a
    // cast name still has to start with a capital.
    for (const part of prompt.split(/(@(?:[Ii]mage|[Vv]ideo)\d+|@[A-Z][A-Za-z0-9]{1,30})/g)) {
      if (part) out.push({ t: part, tag: /^@(?:image|video)\d+$/i.test(part) || /^@[A-Z][A-Za-z0-9]{1,30}$/.test(part) });
    }
    if (prompt.endsWith("\n") || prompt === "") out.push({ t: "​", tag: false });
    return out;
  }, [prompt]);

  const configured = (id: string) => engines.find((e) => e.id === id)?.configured ?? true;
  /* What a row in the mode menu would cost at the current settings — one
     number next to each engine, so the choice is made with the price. */
  const rowPrice = (m: ModelDef): string | null => {
    const res = m.resolutions.includes(params.resolution) ? params.resolution : m.resolutions[0];
    const c = m.kind === "image"
      ? estimateImageCostUsd(m.id, res, imageRefCount)
      : estimateCostUsd(m.id, res, m.ratios.includes(params.ratio) ? params.ratio : m.ratios[0],
          m.durations.includes(params.duration) ? params.duration : (m.durations[0] ?? 5), inputSeconds, hasVideoInput, estOpts);
    return c ? price(c.net, m.id) : null;
  };
  const engineOf = (m: ModelDef) => engines.find((e) => e.id === m.provider);

  const placeholder = taskOn
    ? (taskOn.id === "edit" ? "What changes in this shot…"
      : taskOn.id === "extend" ? "What happens next…"
      : taskOn.id === "motion" ? "Describe the movement, or leave it to the clip…"
      : "Optional — the clip is the brief.")
    : isImage ? "Describe the still…" : "Describe the shot…";

  return (
    <div
      className={`${rail ? "rail-composer" : "island-card"} ${drag ? "is-drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault(); setDrag(false);
        // A render dragged from the rail is one of OURS: it goes to the
        // separate ownRefs list, never into the upload strip, because
        // removing something from that strip deletes the file.
        const asset = readDraggedAsset(e);
        if (asset) { onDropAsset(asset.gen as Gen); return; }
        // A cast member dropped in is cited, so the prompt can address them.
        const cast = readDraggedCast(e);
        if (cast) { cite(`@${cast.name}`); return; }
        if (e.dataTransfer.files.length) picker.current?.add(e.dataTransfer.files);
      }}
    >
      {taskOn && (
        <>
          <div className="island-task">
            <span className="font-medium text-blue">{taskOn.id === "edit" ? "Editing" : taskOn.id === "extend" ? "Continuing" : taskOn.id === "motion" ? "Moving" : taskOn.id === "upscale" ? "Upscaling" : "Reframing"}</span>
            {/* The one place on the island already conditional on a mode, so
                the one place the missing clip belongs. */}
            <button type="button" onClick={onPickSource}
              className={`min-w-0 truncate ${taskOn.gen || uploadSource ? "text-dim hover:text-ink" : "font-medium text-blue"}`}
              title={taskOn.gen || uploadSource ? "Choose a different clip" : "Choose the clip to work on, or upload one"}>
              {taskOn.gen
                ? (taskOn.gen.title || (taskOn.gen.shotCode ? `${taskOn.gen.shotCode} v${taskOn.gen.version}` : "this render"))
                : uploadSource ? uploadSource.filename
                : "Choose a clip →"}
            </button>
            <span className="text-[12px] text-mute">
              {taskOn.id === "edit" ? "aspect and length follow the source" : taskOn.id === "reframe" ? "length follows the source — pick the aspect" : "aspect follows the source"}
            </span>
            <button type="button" onClick={cancelTask} className="ml-auto text-[12px] text-lift">Cancel</button>
          </div>

          {/* The engine reads the INTENT off the words, so a change described
              in the wrong ones is a different request or no request at all.
              These write a phrasing it recognises and leave the caret where
              the specifics go. */}
          <div className="mx-1 mb-1.5 flex flex-wrap items-center gap-1.5">
            {movesFor(taskOn.id).map((m) => (
              <button key={m.id} type="button" title={m.blurb}
                onClick={() => applyMove(m)}
                className="chip !py-1 !text-[12.5px]">
                {m.label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* A blocked render and a signed-out visitor are not the same thing.
          One is a fault to fix, the other is simply not being a member yet —
          so the notice drops the alarm colour when nothing is wrong. */}
      {problem && (
        <p className={`island-problem ${notice ? "is-notice" : ""}`}>{problem}</p>
      )}

      {/* Our own renders, kept visually apart from uploaded references
          because they behave differently: taking one off drops it from this
          prompt, where taking an upload off deletes the file outright. */}
      {ownRefs.length > 0 && (
        <div className="mx-1 mb-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] text-mute">From the library</span>
          {ownRefs.map((g) => (
            <span key={g.id} className="relative block h-[42px] w-[42px] overflow-hidden rounded-[8px] bg-thumb"
              title={g.title || g.prompt}>
              {g.storedUrl && (
                <LazyMedia url={g.storedUrl} kind={g.kind === "image" ? "image" : "video"}
                  alt="" className="!absolute inset-0" />
              )}
              <button type="button" onClick={() => dropOwnRef(g.id)} title="Take it off"
                className="absolute right-0 top-0 grid h-4 w-4 place-items-center rounded-bl-[6px] bg-black/60 text-white">
                <IconClose className="!h-2.5 !w-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      <References refs={refs} setRefs={setRefs} onCite={cite} model={model} pickerRef={picker} />

      <div className="island-text">
        <div ref={overlayEl} aria-hidden className="island-overlay">
          {segments.map((s, i) =>
            s.tag ? (
              <span key={i} className="island-cite">{s.t}</span>
            ) : <span key={i}>{s.t}</span>
          )}
        </div>
        <textarea
          ref={promptRef} rows={1}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onScroll={(e) => { if (overlayEl.current) overlayEl.current.scrollTop = e.currentTarget.scrollTop; }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onRender(); }
          }}
          placeholder={placeholder}
          spellCheck={false}
          style={{ scrollbarGutter: "stable" }}
          className="island-input"
        />
      </div>

      <div className="island-bar">
        <button type="button" onClick={() => picker.current?.open()} className="chip-ctl" title="Attach stills or clips — never recompressed">
          <IconAttach /> {refs.length ? refs.length : "Add"}
        </button>

        {/* A menu of MODES, not of engines. Editing is a thing the engine
            does, and you know you are editing before you know which clip —
            so it belongs here, chosen first, rather than hidden behind a
            button on a render you have to go and find. The id underneath
            stays the real one: it is what gets sent to the vendor. */}
        <ChipMenu label={modeLabel} open={menu === "model"} onOpen={() => setMenu("model")} onClose={() => setMenu(null)} wide>
          {MODELS.filter((m) => !m.hidden && m.kind === kind).flatMap((m) => {
            const on = configured(m.provider);
            const tasks = m.supportsTasks ?? ["generate"];
            return tasks.map((t) => {
              const def = getTask(t);
              const label = t === "generate" ? m.label : `${m.label} ${def.label}`;
              const picked = params.modelId === m.id &&
                (t === "generate" ? !taskOn : taskOn?.id === t);
              return (
                <button key={`${m.id}:${t}`} disabled={!on}
                  onClick={() => { pickMode(m.id, t); setMenu(null); }}
                  className="menu-item disabled:opacity-50">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{label}
                      {t !== "generate" && (
                        <span className="ml-1.5 text-[11px] font-normal uppercase tracking-wide text-mute">
                          needs a clip
                        </span>
                      )}
                    </span>
                    <span className="text-[12.5px] text-mute">
                      {!on
                        ? `Needs a ${engineOf(m)?.label ?? "vendor"} key — see Settings › Vendors.`
                        : t === "generate" ? (m.use ?? m.note) : def.blurb}
                    </span>
                  </span>
                  {on && t === "generate" && rowPrice(m) && <span className="text-[12.5px] text-mute">{rowPrice(m)}</span>}
                  <span className={picked ? "text-blue" : "text-transparent"}>✓</span>
                </button>
              );
            });
          })}
        </ChipMenu>
        {/* The engine rule, where the choice is made (brief 2.5): one tap to take it. */}
        {suggestion && onSuggestion && (
          <button type="button" className="chip-ctl is-hint" title={suggestion.why} onClick={onSuggestion}>{suggestion.label}</button>
        )}
        {/* The plateau (brief 2.5): after two edit passes on a still, a fresh render with the full look, not a third edit. */}
        {plateau && onFresh && (
          <button type="button" className="chip-ctl is-hint" title="Relative edits on a still stop landing after a couple of passes. This writes the whole final look into one prompt and renders it fresh." onClick={onFresh}>
            {plateau.passes} passes on this still — regenerate fresh
          </button>
        )}

        {(!falTask || taskDef?.forceRatio === null) && (
          <ChipMenu label={params.ratio === "adaptive" ? "Auto" : params.ratio} open={menu === "ratio"} onOpen={() => setMenu("ratio")} onClose={() => setMenu(null)}>
            {model.ratios.map((r) => (
              <button key={r} onClick={() => { patch({ ratio: r }); setMenu(null); }}
                className={`menu-item ${params.ratio === r ? "text-blue" : ""}`}>
                {r === "adaptive" ? "Auto — follows the reference" : r}
              </button>
            ))}
          </ChipMenu>
        )}

        <ChipMenu label={resLabel(params.resolution, isImage)} hint={dims ? `${dims.w}×${dims.h}` : undefined}
          title={dims && billed && (billed.w !== dims.w || billed.h !== dims.h)
            ? `The master is ${dims.w}×${dims.h}. The engine meters on a sixteen-pixel grid, so it bills ${billed.w}×${billed.h}.`
            : undefined}
          open={menu === "res"} onOpen={() => setMenu("res")} onClose={() => setMenu(null)}>
          {model.resolutions.map((r) => {
            const c = isImage ? estimateImageCostUsd(params.modelId, r, imageRefCount)
              : estimateCostUsd(params.modelId, r, params.ratio, billedSecs, inputSeconds, hasVideoInput, estOpts);
            return (
              <button key={r} onClick={() => { patch({ resolution: r }); setMenu(null); }} className="menu-item">
                <span className={`flex-1 ${params.resolution === r ? "text-blue" : ""}`}>{resLabel(r, isImage)}</span>
                {c && <span className="text-[13px] text-mute">{price(c.net, params.modelId)}</span>}
              </button>
            );
          })}
        </ChipMenu>

        {!isImage && !followsSource && (
          <ChipMenu label={`${params.duration}s`} open={menu === "dur"} onOpen={() => setMenu("dur")} onClose={() => setMenu(null)}
            disabled={Boolean(taskOn && taskOn.id === "edit")}>
            {model.durations.map((d) => {
              const c = estimateCostUsd(params.modelId, params.resolution, params.ratio, d, inputSeconds, hasVideoInput, estOpts);
              return (
                <button key={d} onClick={() => { patch({ duration: d }); setMenu(null); }} className="menu-item">
                  <span className={`flex-1 ${params.duration === d ? "text-blue" : ""}`}>{d}s</span>
                  <span className="text-[13px] text-mute">{c ? price(c.net, params.modelId) : ""}</span>
                </button>
              );
            })}
          </ChipMenu>
        )}

        {taskOn?.id === "motion" && (
          <ChipMenu label={params.orientation === "image" ? "Faces the still" : "Faces the clip"} open={menu === "orient"} onOpen={() => setMenu("orient")} onClose={() => setMenu(null)} wide>
            {([["video", "Faces the clip", "The character turns as the reference does — clips up to 30s."], ["image", "Faces the still", "The character keeps the still's orientation — clips up to 10s."]] as const).map(([v, l, note]) => (
              <button key={v} onClick={() => { patch({ orientation: v }); setMenu(null); }} className="menu-item">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={`font-medium ${params.orientation === v ? "text-blue" : ""}`}>{l}</span>
                  <span className="text-[12.5px] text-mute">{note}</span>
                </span>
              </button>
            ))}
          </ChipMenu>
        )}
        {!taskOn && setCount && (
          <label className="chip-dd" title={isImage ? "How many stills from this prompt, filed as siblings" : "How many takes from this prompt, filed as siblings under the same shot"}>
            ×<select value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="How many variations">
              {COUNTS[isImage ? "image" : "video"].map((n) => <option key={n} value={n}>{n}</option>)}
            </select><span className="hdr-caret" aria-hidden="true">▼</span>
          </label>
        )}
        {taskOn?.id === "upscale" && (
          <button type="button" onClick={() => patch({ fps60: !params.fps60 })}
            aria-pressed={params.fps60} className={`chip-ctl ${params.fps60 ? "is-on" : ""}`} title="Interpolate to 60 frames a second — doubles the price">
            {params.fps60 ? "60 fps" : "Source fps"}
          </button>
        )}

        {!isImage && model.supportsAudio && (
          <button type="button" onClick={() => patch({ generateAudio: !params.generateAudio })}
            aria-pressed={params.generateAudio} className={`chip-ctl ${params.generateAudio ? "is-on" : ""}`}
            title={taskOn?.id === "motion" ? "Keep the reference clip's own sound" : "Native audio, generated with the picture"}>
            {taskOn?.id === "motion" ? `Clip sound${params.generateAudio ? " on" : ""}` : `Audio${params.generateAudio ? " on" : ""}`}
          </button>
        )}

        {!isImage && model.provider !== "fal" && (
          <ChipMenu label="More" open={menu === "more"} onOpen={() => setMenu("more")} onClose={() => setMenu(null)} wide>
            <div className="px-3 py-2">
              <label className="flex items-center gap-3 py-1.5 text-[14px]">
                Seed
                <input className="ctl !h-8 ml-auto w-[120px] text-right" value={params.seed}
                  inputMode="numeric" placeholder="Random"
                  onChange={(e) => patch({ seed: e.target.value.replace(/\D/g, "") })} />
              </label>
              <div className="flex items-center gap-3 py-1.5 text-[14px]">
                Watermark
                <span className="ml-auto"><Switch checked={params.watermark} onChange={(v) => patch({ watermark: v })} /></span>
              </div>
            </div>
          </ChipMenu>
        )}

        {!rail && (
          <button type="button" onClick={toggleSetup}
            aria-pressed={setupOpen} className={`chip-ctl ${setupOpen ? "is-on" : ""}`}
            title="Shot filing, shot control and the cast — carried into every take">
            <IconSliders /> Setup{setupCount > 0 ? ` · ${setupCount}` : ""}
          </button>
        )}

        <span className="ml-auto" />

        {!rail && <span className="relative" ref={costRef}>
          <button type="button" onClick={() => setMenu(menu === "cost" ? null : "cost")} className="island-cost"
            title="What this take will cost">
            <span className="font-semibold text-bone">{est ? (count > 1 && !taskOn ? `${price(est.net * count, priceModelId)} · ${count} × ${price(est.net, priceModelId)}` : price(est.net, priceModelId)) : "—"}{writerUsd > 0 && <span className="font-normal text-mute"> + {price(writerUsd * (taskOn ? 1 : count), "text")} writer</span>}</span>
            {/* The price and nothing else — the same reason the rail button
                dropped it. The token figure is the vendor's billing unit, and
                the popover below is where how-it-bills is explained. */}
          </button>
          {menu === "cost" && (
            <>
              <span className="menu-pop island-menu island-menu-right block w-[280px] px-3.5 py-3 text-left text-[13px] leading-relaxed text-dim">
                {isImage ? (
                  trainedCited ? <>Rendered by Flux with @{trainedCited}&rsquo;s trained likeness — {price(est?.net ?? 0, priceModelId)} a still. Your prompt goes as written.</> :
                  <>Flat per still on Google — {price(est?.net ?? 0, params.modelId)} at {params.resolution.toUpperCase()}{imageRefCount ? ` with ${imageRefCount} reference${imageRefCount === 1 ? "" : "s"}` : ""}. The model thinks before it draws; your prompt goes as written. A refusal costs nothing.</>
                ) : secondRate != null ? (
                  <>Billed per second on fal.ai: {money.rate(secondRate, params.modelId)}/s × {billedSecs || "the clip's"}s{params.fps60 ? ", doubled for 60 fps" : ""}.{followsSource ? " The length follows the clip." : ""} {taskOn?.id === "upscale" || taskOn?.id === "reframe" ? "Nothing has to be written: the clip is the brief." : "Your words go as written."}</>
                ) : (
                  <>Billed by frame tokens: {estTokens != null ? compactTokens(estTokens) : "—"} at {billed ? `${billed.w}×${billed.h}` : "the source size"} for {params.duration}s{billed && dims && (billed.w !== dims.w || billed.h !== dims.h) ? ` — the file is ${dims.w}×${dims.h}, and the engine bills on a sixteen-pixel grid` : ""}.{" "}
                    {!writer || writer.writer === "none"
                      ? <>Pro mode: your words go as written, the camera as a module from the bank.</>
                      : <>Your words go as written; an idea too thin to film is finished by {writer.label}{writer.usdPerCall ? ` for ${price(writer.usdPerCall, "text")} a call` : ""}{writer.configured ? "" : " (not reachable right now, so it goes raw)"}{writerUsd > 0 ? " — this one is that thin, so it will run" : ""}. The camera comes from the bank.</>}
                    {" "}Start with <span className="font-medium text-blue">raw:</span> to bypass everything.
                    {approval && ruleLine(approval.rule, approval.shotCapCredits, (n) => `${n} cr`) ? <> {ruleLine(approval.rule, approval.shotCapCredits, (n) => `${n} cr`)}</> : null}</>
                )}
              </span>
            </>
          )}
        </span>}

        {!rail && (
          <button type="button" onClick={onRender}
            disabled={busy || !(prompt.trim() || promptOptional) || blocked}
            title="Render  ⌘↵"
            className="btn-render island-send">
            {busy ? <ParticlSpinner size={18} className="text-on-ink" /> : <IconArrowUp />}
          </button>
        )}
      </div>
    </div>
  );
}

/** A control chip that opens its options above itself. */
function ChipMenu({ label, hint, title, open, onOpen, onClose, children, disabled, wide, on }: {
  label: string; hint?: string; title?: string; open: boolean; onOpen: () => void; onClose: () => void;
  children: React.ReactNode; disabled?: boolean; wide?: boolean; on?: boolean;
}) {
  const wrap = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  useDismiss(wrap, open, onClose, pop);
  /* The menu is rendered at the top of the document, because the composer's
     sheet is a transformed, overflow-hidden box: anything fixed inside it is
     contained and clipped by it, which is how a menu came to open inside a
     window of its own. Placed here from the chip's rectangle, and kept in
     step with a scroll or a resize while it is open. */
  useLayoutEffect(() => {
    if (!open) return;
    const put = () => {
      const r = wrap.current?.getBoundingClientRect();
      if (r) setPlace(menuPlacement(r, { width: window.innerWidth, height: window.innerHeight }, wide ? 300 : 220));
    };
    put();
    window.addEventListener("resize", put);
    window.addEventListener("scroll", put, true);
    return () => { window.removeEventListener("resize", put); window.removeEventListener("scroll", put, true); };
  }, [open, wide]);
  return (
    <span ref={wrap} className="relative">
      <button type="button" disabled={disabled} onClick={open ? onClose : onOpen} title={title}
        aria-haspopup="true" aria-expanded={open}
        className={`chip-ctl ${open ? "is-open" : ""} ${on ? "is-on" : ""}`}>
        {hint && <span className="chip-hint">{hint}</span>}
        {label}
        <IconCaret className="chip-caret" />
      </button>
      {open && place && typeof document !== "undefined" && createPortal(
        <span ref={pop} className={`menu-pop island-menu ${wide ? "w-[300px]" : ""}`}
          style={{ position: "fixed", left: place.left, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}>
          {children}
        </span>, document.body)}
    </span>
  );
}

/** The resolution chip's word: a video says its class and shows its pixel
 *  size beside it; a still says its pixel size outright. */
function resLabel(r: string, still: boolean): string {
  if (!still) return r.toLowerCase();
  const px: Record<string, number> = { "512": 512, "1K": 1024, "2K": 2048, "4K": 4096 };
  const n = px[r.toUpperCase()] ?? px[r];
  return n ? `${r.toUpperCase()} · ${n}px` : r.toUpperCase();
}
