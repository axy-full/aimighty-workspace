"use client";

/**
 * The island: one floating surface with everything a render needs, the way
 * the best generation tools do it — references ride on top, the prompt in
 * the middle, and every control is a chip on the bottom row rather than a
 * settings list somewhere else. Menus open upward; the cost is on the
 * button before it is pressed.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * Close on any pointer-down outside `ref` and on Escape. Menus used to rely
 * on a fixed full-screen backdrop, but the island's backdrop-filter makes
 * it the containing block for fixed descendants, so that backdrop only ever
 * covered the island and a click on the wall never closed anything.
 */
function useDismiss(ref: React.RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, onClose]);
}
import References, { type RefItem, type RefPicker } from "./References";
import { Switch } from "./Panel";
import type { Gen } from "./GenCard";
import { ParticlSpinner } from "./ParticlMark";
import { usd, compactTokens } from "@/lib/format";
import { MODELS, estimateCostUsd, estimateImageCostUsd, type ModelDef } from "@/lib/models";
import { IconArrowUp, IconCaret, IconAttach, IconSliders } from "./Icons";
import type { Params } from "./Workspace";

type Menu = null | "model" | "dur" | "ratio" | "res" | "more" | "cost";

export type Engine = { id: string; label: string; configured: boolean };

export type ComposerProps = {
  prompt: string; setPrompt: (v: string) => void;
  promptRef: React.RefObject<HTMLTextAreaElement | null>;
  params: Params; patch: (p: Partial<Params>) => void; switchModel: (id: string) => void;
  model: ModelDef; engines: Engine[];
  refs: RefItem[]; setRefs: React.Dispatch<React.SetStateAction<RefItem[]>>;
  picker: React.MutableRefObject<RefPicker>; cite: (token: string) => void;
  taskOn: { id: "edit" | "extend"; gen: Gen } | null; cancelTask: () => void;
  /** The message to show, whatever its cause. */
  problem: string | null;
  /** Whether the references make a submit impossible — the only thing that
   *  disables the button. A failed submit is shown, never locked in. */
  blocked: boolean;
  est: { net: number } | null; estTokens: number | null; dims: { w: number; h: number } | null;
  inputSeconds: number; hasVideoInput: boolean; imageRefCount: number;
  busy: boolean; onRender: () => void;
  setupCount: number; setupOpen: boolean; toggleSetup: () => void;
};

export default function Composer(p: ComposerProps) {
  const {
    prompt, setPrompt, promptRef, params, patch, switchModel, model, engines,
    refs, setRefs, picker, cite, taskOn, cancelTask, problem, blocked,
    est, estTokens, dims, inputSeconds, hasVideoInput, imageRefCount,
    busy, onRender, setupCount, setupOpen, toggleSetup,
  } = p;
  const [menu, setMenu] = useState<Menu>(null);
  const [drag, setDrag] = useState(false);
  const overlayEl = useRef<HTMLDivElement>(null);
  const costRef = useRef<HTMLSpanElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(costRef, menu === "cost", closeMenu);
  const isImage = model.kind === "image";

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
  const engineOf = (m: ModelDef) => engines.find((e) => e.id === m.provider);

  const placeholder = taskOn
    ? (taskOn.id === "edit" ? "What changes in this shot…" : "What happens next…")
    : isImage ? "Describe the still…" : "Describe the shot…";

  return (
    <div
      className={`island-card ${drag ? "is-drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault(); setDrag(false);
        if (e.dataTransfer.files.length) picker.current?.add(e.dataTransfer.files);
      }}
    >
      {taskOn && (
        <div className="island-task">
          <span className="font-medium text-blue">{taskOn.id === "edit" ? "Editing" : "Continuing"}</span>
          <span className="truncate text-dim">
            {taskOn.gen.shotCode ? `${taskOn.gen.shotCode} v${taskOn.gen.version}` : "this render"}
          </span>
          <span className="text-[12px] text-mute">
            {taskOn.id === "edit" ? "aspect and length follow the source" : "aspect follows the source"}
          </span>
          <button type="button" onClick={cancelTask} className="ml-auto text-[12px] text-lift">Cancel</button>
        </div>
      )}

      {problem && <p className="island-problem">{problem}</p>}

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

        <ChipMenu label={model.label} open={menu === "model"} onOpen={() => setMenu("model")} onClose={() => setMenu(null)} wide>
          {MODELS.map((m) => {
            const on = configured(m.provider);
            return (
              <button key={m.id} disabled={!on} onClick={() => { switchModel(m.id); setMenu(null); }} className="menu-item disabled:opacity-50">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{m.label}
                    <span className="ml-1.5 text-[11px] font-normal uppercase tracking-wide text-mute">{m.kind === "image" ? "still" : "video"}</span>
                  </span>
                  <span className="text-[12.5px] text-mute">{on ? m.note : `Needs a ${engineOf(m)?.label ?? "vendor"} key — see Settings › Engines.`}</span>
                </span>
                <span className={params.modelId === m.id ? "text-blue" : "text-transparent"}>✓</span>
              </button>
            );
          })}
        </ChipMenu>

        <ChipMenu label={params.ratio === "adaptive" ? "Auto" : params.ratio} open={menu === "ratio"} onOpen={() => setMenu("ratio")} onClose={() => setMenu(null)}>
          {model.ratios.map((r) => (
            <button key={r} onClick={() => { patch({ ratio: r }); setMenu(null); }}
              className={`menu-item ${params.ratio === r ? "text-blue" : ""}`}>
              {r === "adaptive" ? "Auto — follows the reference" : r}
            </button>
          ))}
        </ChipMenu>

        <ChipMenu label={params.resolution.toUpperCase()} hint={dims ? `${dims.w}×${dims.h}` : undefined}
          open={menu === "res"} onOpen={() => setMenu("res")} onClose={() => setMenu(null)}>
          {model.resolutions.map((r) => {
            const c = isImage ? estimateImageCostUsd(r, imageRefCount)
              : estimateCostUsd(params.modelId, r, params.ratio, params.duration, inputSeconds, hasVideoInput);
            return (
              <button key={r} onClick={() => { patch({ resolution: r }); setMenu(null); }} className="menu-item">
                <span className={`flex-1 ${params.resolution === r ? "text-blue" : ""}`}>{r.toUpperCase()}</span>
                {c && <span className="text-[13px] text-mute">{usd(c.net, 2)}</span>}
              </button>
            );
          })}
        </ChipMenu>

        {!isImage && (
          <ChipMenu label={`${params.duration}s`} open={menu === "dur"} onOpen={() => setMenu("dur")} onClose={() => setMenu(null)}
            disabled={Boolean(taskOn && taskOn.id === "edit")}>
            {model.durations.map((d) => {
              const c = estimateCostUsd(params.modelId, params.resolution, params.ratio, d, inputSeconds, hasVideoInput);
              return (
                <button key={d} onClick={() => { patch({ duration: d }); setMenu(null); }} className="menu-item">
                  <span className={`flex-1 ${params.duration === d ? "text-blue" : ""}`}>{d}s</span>
                  <span className="text-[13px] text-mute">{c ? usd(c.net, 2) : ""}</span>
                </button>
              );
            })}
          </ChipMenu>
        )}

        {!isImage && model.supportsAudio && (
          <button type="button" onClick={() => patch({ generateAudio: !params.generateAudio })}
            className={`chip-ctl ${params.generateAudio ? "is-on" : ""}`} title="Native audio, generated with the picture">
            Audio{params.generateAudio ? " on" : ""}
          </button>
        )}

        {!isImage && (
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

        <button type="button" onClick={toggleSetup}
          className={`chip-ctl ${setupOpen ? "is-on" : ""}`}
          title="Shot filing, shot control and the cast — carried into every render">
          <IconSliders /> Setup{setupCount > 0 ? ` · ${setupCount}` : ""}
        </button>

        <span className="ml-auto" />

        <span className="relative" ref={costRef}>
          <button type="button" onClick={() => setMenu(menu === "cost" ? null : "cost")} className="island-cost"
            title="What this render will cost">
            <span className="font-semibold text-bone">{est ? usd(est.net, 2) : "—"}</span>
            {!isImage && estTokens != null && (
              <span className="text-mute max-[560px]:hidden"> · {compactTokens(estTokens)} tok</span>
            )}
          </button>
          {menu === "cost" && (
            <>
              <span className="menu-pop island-menu island-menu-right block w-[280px] px-3.5 py-3 text-left text-[13px] leading-relaxed text-dim">
                {isImage ? (
                  <>Flat per still on Google — {usd(est?.net ?? 0, 3)} at {params.resolution.toUpperCase()}{imageRefCount ? ` with ${imageRefCount} reference${imageRefCount === 1 ? "" : "s"}` : ""}. The model thinks before it draws; your prompt goes as written. A refusal costs nothing.</>
                ) : (
                  <>Billed by frame tokens: {estTokens != null ? compactTokens(estTokens) : "—"} at {dims ? `${dims.w}×${dims.h}` : "the source size"} for {params.duration}s. Prompts go library-first — your words as written, the camera as a module from the bank. Start with <span className="font-medium text-blue">raw:</span> to send exactly what you typed.</>
                )}
              </span>
            </>
          )}
        </span>

        <button type="button" onClick={onRender}
          disabled={busy || !prompt.trim() || blocked}
          title="Render  ⌘↵"
          className="btn-render island-send">
          {busy ? <ParticlSpinner size={18} className="text-white" /> : <IconArrowUp />}
        </button>
      </div>
    </div>
  );
}

/** A control chip that opens its options above itself. */
function ChipMenu({ label, hint, open, onOpen, onClose, children, disabled, wide }: {
  label: string; hint?: string; open: boolean; onOpen: () => void; onClose: () => void;
  children: React.ReactNode; disabled?: boolean; wide?: boolean;
}) {
  const wrap = useRef<HTMLSpanElement>(null);
  const [alignRight, setAlignRight] = useState(false);
  useDismiss(wrap, open, onClose);
  useLayoutEffect(() => {
    if (!open) return;
    const r = wrap.current?.getBoundingClientRect();
    // A menu anchored near the right edge would leave the screen — flip it.
    if (r) setAlignRight(r.left + (wide ? 320 : 220) > window.innerWidth - 12);
  }, [open, wide]);
  return (
    <span ref={wrap} className="relative">
      <button type="button" disabled={disabled} onClick={open ? onClose : onOpen}
        className={`chip-ctl ${open ? "is-open" : ""}`}>
        {hint && <span className="chip-hint">{hint}</span>}
        {label}
        <IconCaret className="chip-caret" />
      </button>
      {open && (
        <span className={`menu-pop island-menu ${alignRight ? "island-menu-right" : ""} ${wide ? "w-[300px]" : ""}`}>
          {children}
        </span>
      )}
    </span>
  );
}
