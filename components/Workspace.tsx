"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import References, { referenceProblem, type RefItem, type RefPicker } from "./References";
import { appConfirm } from "./dialog";
import type { Gen } from "./GenCard";
import { useApi } from "@/lib/useApi";
import { usd, compactTokens, timeAgo, posterSrc } from "@/lib/format";
import {
  MODELS, DEFAULT_MODEL_ID, getModel, shortLabel, dimensionsFor,
  estimateCostUsd, estimateTokens, estimateImageCostUsd,
} from "@/lib/models";
import { useProject } from "@/lib/projectContext";
import { IconDown, IconTrash } from "./Icons";

export type Params = {
  modelId: string; ratio: string; resolution: string; duration: number;
  watermark: boolean; generateAudio: boolean; seed: string;
};

const clipId = (id: string) => id.split("_").pop()!.slice(-6).toUpperCase();

const STATUS: Record<string, { cls: string; label: string; live?: boolean }> = {
  queued:    { cls: "text-mute", label: "QUEUED", live: true },
  running:   { cls: "text-run",  label: "RENDER", live: true },
  succeeded: { cls: "text-ok",   label: "OK" },
  failed:    { cls: "text-lift", label: "FAILED" },
  cancelled: { cls: "text-mute", label: "CANCELLED" },
};

type Menu = null | "model" | "dur" | "ratio" | "res" | "more" | "refine";

export default function Workspace() {
  const { selection: bin, refreshProjects } = useProject();
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [menu, setMenu] = useState<Menu>(null);
  const promptEl = useRef<HTMLTextAreaElement>(null);
  const overlayEl = useRef<HTMLDivElement>(null);
  const picker = useRef<RefPicker>(null);

  const [params, setParams] = useState<Params>({
    modelId: DEFAULT_MODEL_ID, ratio: "16:9", resolution: "720p", duration: 5,
    watermark: false, generateAudio: false, seed: "",
  });
  const patch = (p: Partial<Params>) => setParams((s) => ({ ...s, ...p }));

  function switchModel(next: string) {
    const m = getModel(next);
    patch({
      modelId: next,
      ratio: m.ratios.includes(params.ratio) ? params.ratio : m.ratios.includes("16:9") ? "16:9" : m.ratios[0],
      // Image engines: 2K costs the same as 1K — default to the pixels.
      resolution: m.resolutions.includes(params.resolution)
        ? params.resolution
        : m.kind === "image" ? "2K" : m.resolutions[0],
      duration: m.durations.includes(params.duration) ? params.duration : m.durations[0] ?? params.duration,
      generateAudio: m.supportsAudio ? params.generateAudio : false,
    });
    // Stills have no first/last-frame mode — every image is a plain reference.
    if (m.kind === "image") {
      setRefs((prev) => prev.map((r) =>
        r.kind === "image" && r.role !== "reference_image" ? { ...r, role: "reference_image" } : r
      ));
    }
  }

  const query =
    bin === "all" || bin === "unfiled" ? "" : `&projectId=${encodeURIComponent(bin)}`;
  const { data, refresh } = useApi<{ generations: Gen[] }>(`/api/jobs?limit=300${query}`, 5000);
  const gens = useMemo(() => {
    const all = data?.generations ?? [];
    return bin === "unfiled" ? all.filter((g) => !g.projectId) : all;
  }, [data, bin]);

  // The viewer shows a clip ONLY after an explicit filmstrip click — no
  // auto-loading of the newest render, no fallback. If the selected clip
  // disappears (deleted), the viewer simply empties.
  const activeId = selected && gens.some((g) => g.id === selected) ? selected : null;
  const clip = gens.find((g) => g.id === activeId) ?? null;

  // Clicking anywhere OUTSIDE the clip dismisses it. "The clip" is the viewer
  // plus its prompt panel (so Copy/Use don't dismiss what they act on), the
  // filmstrip (so choosing another clip never blanks the view), and the
  // island (typing a follow-up shouldn't blank the clip you just USEd).
  // Listening for click — not pointerdown — means a touch that starts a
  // scroll never blanks the viewer mid-gesture.
  const viewerRef = useRef<HTMLElement>(null);
  const stripRef = useRef<HTMLElement>(null);
  const islandRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onTap(e: MouseEvent) {
      const t = e.target as Node;
      if (viewerRef.current?.contains(t) || stripRef.current?.contains(t) ||
          islandRef.current?.contains(t)) return;
      setSelected(null);
    }
    document.addEventListener("click", onTap);
    return () => document.removeEventListener("click", onTap);
  }, []);

  // The composer grows with the prompt (to a lid), and the highlight layer
  // must track the textarea's scroll exactly or the colored @cites drift.
  useEffect(() => {
    const el = promptEl.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    if (overlayEl.current) overlayEl.current.scrollTop = el.scrollTop;
  }, [prompt]);

  const modelDef = getModel(params.modelId);
  const isImage = modelDef.kind === "image";
  const refProblem = referenceProblem(refs, modelDef, prompt);
  const hasVideoInput = refs.some((r) => r.kind === "video");
  const inputSeconds = refs
    .filter((r) => r.kind === "video")
    .reduce((a, r) => a + (r.durationS ?? 0), 0);
  const imageRefCount = refs.filter((r) => r.kind === "image").length;
  const est = isImage
    ? estimateImageCostUsd(params.resolution, imageRefCount)
    : estimateCostUsd(
        params.modelId, params.resolution, params.ratio, params.duration,
        inputSeconds, hasVideoInput
      );
  const estTokens = isImage
    ? null
    : estimateTokens(params.resolution, params.ratio, params.duration, inputSeconds);
  const dims = isImage ? null : dimensionsFor(params.resolution, params.ratio);

  const referenceImages = refs.filter((r) => r.kind === "image" && r.role === "reference_image");
  const referenceVideos = refs.filter((r) => r.kind === "video");
  const citeTokenFor = (r: RefItem) =>
    r.kind === "video"
      ? `@Video${referenceVideos.findIndex((x) => x.id === r.id) + 1}`
      : r.role === "reference_image"
        ? `@Image${referenceImages.findIndex((x) => x.id === r.id) + 1}`
        : r.role === "first_frame" ? "FIRST" : "LAST";

  function afterChange() { refresh(); refreshProjects(); }

  /** Drop an @ImageN token in at the caret so the prompt can address a reference. */
  function cite(token: string) {
    const el = promptEl.current;
    if (!el) { setPrompt((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}${token} `); return; }
    const start = el.selectionStart ?? prompt.length;
    const end = el.selectionEnd ?? start;
    const next = `${prompt.slice(0, start)}${token} ${prompt.slice(end)}`;
    setPrompt(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + token.length + 1;
      el.setSelectionRange(caret, caret);
    });
  }

  async function render() {
    if (!prompt.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt, model: params.modelId, ratio: params.ratio,
          resolution: params.resolution, duration: params.duration,
          watermark: params.watermark, generateAudio: params.generateAudio,
          seed: params.seed || null,
          // Renders file into the project you're working in.
          projectId: bin !== "all" && bin !== "unfiled" ? bin : null,
          references: refs.map((r) => ({ uploadId: r.id, role: r.role })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Submit failed");
      setPrompt("");
      setRefs([]);
      if (!json?.id) throw new Error("Submit failed");
      afterChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  // Prompt text with @cites picked out in accent, the design's overlay trick.
  const segments = useMemo(() => {
    const out: { t: string; tag: boolean }[] = [];
    for (const part of prompt.split(/(@(?:Image|Video)\d+)/gi)) {
      if (part) out.push({ t: part, tag: /^@(?:Image|Video)\d+$/i.test(part) });
    }
    if (prompt.endsWith("\n") || prompt === "") out.push({ t: "​", tag: false });
    return out;
  }, [prompt]);

  return (
    <div className="compose">
      <div className="compose-main">
        {/* ── PRO VIEWER ─────────────────────────────────────────────── */}
        <section ref={viewerRef as React.Ref<HTMLElement>} className="flex min-h-0 flex-1 flex-col gap-3" style={{ minHeight: 200 }}>
          <ViewerBody clip={clip} onChanged={afterChange} />
          {clip && (
            <ClipPrompt
              clip={clip}
              onUse={async () => {
                if (prompt.trim() &&
                    !(await appConfirm("Replace the composer?", "This clip's prompt will replace what you've typed.", { confirmLabel: "Replace" }))) return;
                setPrompt(clip.prompt);
                promptEl.current?.focus();
              }}
            />
          )}
        </section>

        {/* ── FILMSTRIP ──────────────────────────────────────────────── */}
        <section ref={stripRef as React.Ref<HTMLElement>}
          className="pan-x flex shrink-0 gap-2.5 overflow-x-auto pb-1 max-[860px]:-mx-3 max-[860px]:px-3">
          {gens.length === 0 ? (
            <div className="desk-grid flex h-[72px] w-full items-center justify-center rounded-[9px] border border-line">
              <p className="font-mono text-[10px] tracking-wide text-mute">
                Quiet in here — write a shot below and it lands on this strip.
              </p>
            </div>
          ) : (
            gens.map((g) => (
              <StripItem key={g.id} gen={g} active={g.id === activeId} onSelect={() => setSelected(g.id)} />
            ))
          )}
        </section>

        {/* ── THE ISLAND ─────────────────────────────────────────────── */}
        <div ref={islandRef} className="island">
          <div className="flex flex-wrap items-center gap-2">
            {refs.map((r) => {
              const token = citeTokenFor(r);
              const citable = token.startsWith("@");
              return (
                <span key={r.id}
                  className="flex items-center gap-1.5 rounded-[8px] border border-line bg-chip py-1 pl-2 pr-1.5 text-[11.5px]">
                  <button
                    onClick={() => citable && cite(token)}
                    title={citable ? "Cite in prompt" : r.role.replace("_", " ")}
                    className="flex items-center gap-1.5"
                  >
                    <span className={`h-2 w-2 rounded-[3px] ${r.kind === "video" ? "bg-ok" : "bg-warn"}`} />
                    <span className="font-mono text-[11px] text-lift">{token}</span>
                    <span className="max-w-[120px] truncate text-dim">{r.filename}</span>
                  </button>
                  <button
                    onClick={() => {
                      setRefs((prev) => prev.filter((x) => x.id !== r.id));
                      fetch(`/api/uploads/${r.id}`, { method: "DELETE" }).catch(() => {});
                    }}
                    className="px-0.5 text-[12px] text-mute hover:text-lift">×</button>
                </span>
              );
            })}
            <button onClick={() => picker.current?.open()}
              className="rounded-[8px] border border-dashed border-line px-2.5 py-1 text-[11.5px] text-dim transition-colors hover:border-lift/60 hover:text-bone">
              + Reference
            </button>
            <span className="ml-auto flex items-center gap-2.5 font-mono text-[9.5px] text-mute">
              <span className="relative">
                <button
                  onClick={() => setMenu(menu === "refine" ? null : "refine")}
                  className="font-mono text-[9.5px] tracking-wide text-mute transition-colors hover:text-dim"
                >
                  {isImage ? "✦ THINKS FIRST" : "✦ AUTO-REFINE"}
                </button>
                {menu === "refine" && (
                  <>
                    <button aria-label="Close" onClick={() => setMenu(null)}
                      className="fixed inset-0 z-50 cursor-default" />
                    <span className="menu-pop block w-[250px] !left-auto !right-0 px-2.5 py-2 font-sans text-[11.5px] normal-case leading-relaxed tracking-normal text-dim">
                      {isImage ? (
                        <>Nano Banana Pro reasons about your prompt itself before
                        drawing — your words go to Google exactly as typed. Every
                        still carries Google&apos;s invisible SynthID watermark.</>
                      ) : (
                        <>Every prompt is auto-refined with ByteDance&apos;s Seedance recipe
                        before rendering. Start with{" "}
                        <span className="font-mono text-lift">raw:</span> to send your
                        exact words instead.</>
                      )}
                    </span>
                  </>
                )}
              </span>
              <span className="tabular-nums">{prompt.trim().length}/10000</span>
            </span>
          </div>

          <div className="relative">
            {/* Must mirror the textarea's font metrics exactly — including the
                phone-size bump the global 16px input rule applies. */}
            <div ref={overlayEl} aria-hidden
              className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-0.5 pt-0.5 text-[14px] leading-[1.5] max-[860px]:text-[16px]">
              {segments.map((s, i) =>
                s.tag ? (
                  <span key={i} className="rounded-[4px] text-lift"
                    style={{ background: "color-mix(in oklab, var(--color-red) 16%, transparent)" }}>
                    {s.t}
                  </span>
                ) : (
                  <span key={i}>{s.t}</span>
                )
              )}
            </div>
            <textarea
              ref={promptEl}
              value={prompt} onChange={(e) => setPrompt(e.target.value)}
              onScroll={(e) => { if (overlayEl.current) overlayEl.current.scrollTop = e.currentTarget.scrollTop; }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); render(); }
              }}
              placeholder="Describe the shot — subject, action, setting, camera, mood"
              spellCheck={false}
              className="relative block max-h-[180px] min-h-[56px] w-full resize-none bg-transparent px-0.5 pt-0.5 text-[14px] leading-[1.5] text-transparent caret-bone placeholder:text-mute/60 focus:outline-none"
            />
          </div>

          {(err || refProblem) && (
            <p className="rounded-[8px] bg-lift/8 px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed text-lift">
              {err ?? refProblem}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <ChipMenu
              open={menu === "model"} setOpen={(v) => setMenu(v ? "model" : null)}
              label={<><span className="font-medium">{modelDef.label}</span></>}
              width={230}
            >
              {MODELS.map((m) => (
                <button key={m.id} onClick={() => { switchModel(m.id); setMenu(null); }} className="menu-item">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[12.5px] font-medium">{m.label}</span>
                    <span className="text-[10.5px] text-mute">{m.note}</span>
                  </span>
                  <span className={`text-[11px] ${params.modelId === m.id ? "text-lift" : "text-transparent"}`}>✓</span>
                </button>
              ))}
            </ChipMenu>

            {!isImage && (
            <ChipMenu
              open={menu === "dur"} setOpen={(v) => setMenu(v ? "dur" : null)}
              label={`${params.duration}s`}
            >
              {modelDef.durations.map((d) => {
                const c = estimateCostUsd(params.modelId, params.resolution, params.ratio, d, inputSeconds, hasVideoInput);
                return (
                  <button key={d} onClick={() => { patch({ duration: d }); setMenu(null); }} className="menu-item">
                    <span className={`flex-1 ${params.duration === d ? "text-lift" : ""}`}>{d}s</span>
                    <span className="font-mono text-[10.5px] text-mute">{c ? `≈ ${usd(c.net, 2)}` : ""}</span>
                  </button>
                );
              })}
            </ChipMenu>
            )}

            <ChipMenu
              open={menu === "ratio"} setOpen={(v) => setMenu(v ? "ratio" : null)}
              label={params.ratio === "adaptive" ? "Auto" : params.ratio} width={120}
            >
              {modelDef.ratios.map((r) => (
                <button key={r} onClick={() => { patch({ ratio: r }); setMenu(null); }}
                  className={`menu-item ${params.ratio === r ? "text-lift" : ""}`}>
                  {r === "adaptive" ? "Auto" : r}
                </button>
              ))}
            </ChipMenu>

            <ChipMenu
              open={menu === "res"} setOpen={(v) => setMenu(v ? "res" : null)}
              label={params.resolution.toUpperCase()} width={150}
            >
              {modelDef.resolutions.map((r) => {
                const c = isImage ? estimateImageCostUsd(r, imageRefCount) : null;
                return (
                  <button key={r} onClick={() => { patch({ resolution: r }); setMenu(null); }}
                    className="menu-item">
                    <span className={`flex-1 ${params.resolution === r ? "text-lift" : ""}`}>{r.toUpperCase()}</span>
                    {c && <span className="font-mono text-[10.5px] text-mute">≈ {usd(c.net, 2)}</span>}
                  </button>
                );
              })}
              {!isImage && (
                <p className="px-2.5 pb-1.5 pt-1 font-mono text-[9.5px] text-mute">
                  {dims ? `${dims.w} × ${dims.h} · 24 fps` : "frame set at render"}
                </p>
              )}
            </ChipMenu>

            {!isImage && (
            <button
              onClick={() => modelDef.supportsAudio && patch({ generateAudio: !params.generateAudio })}
              disabled={!modelDef.supportsAudio}
              title={modelDef.supportsAudio ? "Native audio track" : "Seedance 2.5 only"}
              className={`chip ${params.generateAudio ? "" : "!text-mute"}`}
            >
              <span className={`h-[7px] w-[7px] rounded-full ${params.generateAudio ? "bg-lift" : "bg-mute/60"}`} />
              {!modelDef.supportsAudio ? "Audio · 2.5 only" : params.generateAudio ? "Audio on" : "Audio off"}
            </button>
            )}

            {!isImage && (
            <ChipMenu
              open={menu === "more"} setOpen={(v) => setMenu(v ? "more" : null)}
              label="⋯" width={230} plain
            >
              <div className="flex flex-col gap-2 p-2">
                <label className="flex items-center gap-2">
                  <span className="lbl w-[64px] shrink-0">Seed</span>
                  <input
                    className="ctl !h-[28px] font-mono text-[11px]" value={params.seed}
                    inputMode="numeric" placeholder="random"
                    onChange={(e) => patch({ seed: e.target.value.replace(/\D/g, "") })}
                  />
                </label>
                <label className="flex items-center gap-2">
                  <span className="lbl w-[64px] shrink-0">Watermark</span>
                  <button
                    onClick={() => patch({ watermark: !params.watermark })}
                    className={`chip !py-1 !text-[11px] ${params.watermark ? "" : "!text-mute"}`}
                  >
                    {params.watermark ? "On" : "Off"}
                  </button>
                </label>
              </div>
            </ChipMenu>
            )}

            <span className="ml-auto flex items-center gap-3">
              <span className="hidden font-mono text-[9.5px] text-mute sm:block"
                title={hasVideoInput ? `includes ${inputSeconds.toFixed(1)}s reference video · with-video rate` : undefined}>
                {isImage
                  ? `flat per still${imageRefCount ? ` · ${imageRefCount} ref${imageRefCount === 1 ? "" : "s"}` : ""}`
                  : estTokens != null ? `≈ ${compactTokens(estTokens)} tok${hasVideoInput ? " ᵛ" : ""}` : "cost lands after render"}
              </span>
              <button
                type="button" onClick={render} disabled={busy || !prompt.trim() || Boolean(refProblem)}
                title="⌘ + ↵"
                className="btn-render flex h-[38px] items-center gap-2 px-4 text-[13px]"
              >
                {busy ? "Sending…" : "Generate"}
                {!busy && est && (
                  <span className="font-mono text-[11px] font-medium opacity-85">{usd(est.net, 2)}</span>
                )}
              </button>
            </span>
          </div>
        </div>
      </div>

      {/* ── REFERENCES — the right panel ─────────────────────────────── */}
      <aside className="compose-refs">
        <References refs={refs} setRefs={setRefs} onCite={cite} model={modelDef} pickerRef={picker} />
      </aside>
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────── */

/** A settings chip that opens an upward menu, per the design. The popover
 *  flips to right-aligned when left-anchoring would push it past the
 *  viewport edge — phone screens wrap the chips near the right margin. */
function ChipMenu({ open, setOpen, label, width = 150, plain, children }: {
  open: boolean; setOpen: (v: boolean) => void;
  label: React.ReactNode; width?: number; plain?: boolean;
  children: React.ReactNode;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [alignRight, setAlignRight] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setAlignRight(r.left + width > window.innerWidth - 16);
  }, [open, width]);

  return (
    <span ref={wrapRef} className="relative">
      <button onClick={() => setOpen(!open)} className={`chip ${open ? "!border-lift/50" : ""}`}>
        {label}
        {!plain && (
          <svg width="8" height="6" viewBox="0 0 8 6">
            <path d="M1 1.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          </svg>
        )}
      </button>
      {open && (
        <>
          <button aria-label="Close menu" onClick={() => setOpen(false)}
            className="fixed inset-0 z-50 cursor-default" />
          <span className="menu-pop block"
            style={{ minWidth: width, ...(alignRight ? { left: "auto", right: 0 } : {}) }}>
            {children}
          </span>
        </>
      )}
    </span>
  );
}

/** Full prompt of the selected clip — the team's shared memory, readable and
 *  reusable instead of clamped to two lines in a corner. */
function ClipPrompt({ clip, onUse }: { clip: Gen; onUse: () => void }) {
  const [copied, setCopied] = useState(false);
  const p = clip.params as {
    resolution?: string; ratio?: string; duration?: number; seed?: number | string | null;
  };

  async function copy() {
    try {
      await navigator.clipboard.writeText(clip.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — nothing sensible to do */ }
  }

  return (
    <div className="shrink-0 rounded-[var(--r)] border border-line bg-panel">
      <div className="flex items-center gap-2 px-3.5 pb-1 pt-2.5">
        <span className="lbl">Clip prompt</span>
        <span className="ml-auto flex items-center gap-1.5">
          <button onClick={copy}
            className="rounded-[7px] border border-line px-2 py-0.5 font-mono text-[9px] tracking-wider text-dim hover:border-lift hover:text-lift max-[860px]:px-3 max-[860px]:py-2 max-[860px]:text-[10.5px]">
            {copied ? "COPIED ✓" : "COPY"}
          </button>
          <button onClick={onUse} title="Load into the composer"
            className="rounded-[7px] border border-line px-2 py-0.5 font-mono text-[9px] tracking-wider text-dim hover:border-lift hover:text-lift max-[860px]:px-3 max-[860px]:py-2 max-[860px]:text-[10.5px]">
            USE
          </button>
        </span>
      </div>
      <p className="max-h-[96px] select-text overflow-y-auto whitespace-pre-wrap px-3.5 py-1.5 text-[12.5px] leading-relaxed text-bone/90">
        {clip.prompt}
      </p>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-hair px-3.5 py-1.5 font-mono text-[9.5px] text-mute">
        <span className="text-dim">{shortLabel(clip.model)}</span>
        {p.resolution && <span>{String(p.resolution).toUpperCase()}</span>}
        {p.ratio && <span>{p.ratio}</span>}
        {p.duration != null && <span>{p.duration}s</span>}
        {p.seed != null && p.seed !== "" && <span>seed {p.seed}</span>}
        {clip.totalTokens != null && <span>{compactTokens(clip.totalTokens)}t</span>}
        {clip.costUsd != null && (
          <span className="text-lift" title={clip.refineCostUsd ? "includes prompt refinement" : undefined}>
            {usd(clip.costUsd + (clip.refineCostUsd ?? 0))}
          </span>
        )}
        {clip.authorName && <span className="ml-auto text-dim">{clip.authorName}</span>}
      </div>
    </div>
  );
}

function ViewerBody({ clip, onChanged }: { clip: Gen | null; onChanged: () => void }) {
  if (!clip) {
    return (
      <div className="viewer-stage grid min-h-0 flex-1 place-items-center">
        <div className="stage16 desk-grid relative grid place-items-center overflow-hidden rounded-[14px] border border-line bg-thumb shadow-[var(--shadow)]">
          <div className="text-center">
            <p className="ptitle text-[13.5px] text-dim">The screening room</p>
            <p className="mt-1 font-mono text-[10px] tracking-wide text-mute">click any clip on the strip to play it here</p>
          </div>
        </div>
      </div>
    );
  }

  const s = STATUS[clip.status] ?? STATUS.queued;
  const url = clip.storedUrl ?? clip.sourceUrl;
  const p = clip.params as { resolution?: string; ratio?: string; duration?: number };
  const done = clip.status === "succeeded" && url;
  const still = clip.kind === "image";

  async function remove() {
    if (!(await appConfirm(`Delete clip ${clipId(clip!.id)}?`, "Its cost stays on the ledger.", { confirmLabel: "Delete", danger: true }))) return;
    await fetch(`/api/jobs/${clip!.id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <div className="viewer-stage grid min-h-0 flex-1 place-items-center"
      data-gen-id={clip.id} data-gen-prompt={clip.prompt} data-gen-label={clipId(clip.id)}>
      {/* Fixed 16:9 slate; non-16:9 clips letterbox inside it like any NLE viewer. */}
      <div className="stage16 relative overflow-hidden rounded-[14px] border border-line bg-black shadow-[var(--shadow)]">
        {done ? (
          still ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img key={clip.id} src={url!} alt={clip.prompt.slice(0, 120)}
              className="absolute inset-0 h-full w-full object-contain" />
          ) : (
            <video key={clip.id} src={url!} controls loop preload="metadata" playsInline
              className="absolute inset-0 h-full w-full object-contain" />
          )
        ) : (
          <div className={`desk-grid absolute inset-0 grid place-items-center bg-thumb px-6 ${s.live ? "render-sweep" : ""}`}>
            {clip.error ? (
              <p className="max-w-[520px] text-center font-mono text-[11px] leading-relaxed text-lift/85">
                {clip.error}
              </p>
            ) : (
              <div className="flex flex-col items-center gap-2.5">
                <span className={`font-mono text-[11px] tracking-[.24em] ${s.cls}`}>{s.label}…</span>
                {s.live && (
                  <span className="block h-[3px] w-[180px] overflow-hidden rounded-[2px] bg-white/15">
                    <span className="block h-full w-1/3 rounded-[2px] bg-red"
                      style={{ animation: "stripSlide 1.6s ease-in-out infinite" }} />
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* The pro chrome: shot header over a top gradient, actions at right. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2.5 bg-gradient-to-b from-black/55 to-transparent px-3.5 pb-6 pt-3 text-white">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px] font-semibold [text-shadow:0_1px_8px_rgba(0,0,0,.5)]">
              {clipId(clip.id)}
              <span className={`ml-2 font-mono text-[9px] tracking-[.14em] ${done ? "text-white/70" : s.cls}`}>{s.label}</span>
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9.5px] text-white/75">
              <span>{shortLabel(clip.model)}</span>
              {p.resolution && <span>{String(p.resolution).toUpperCase()}</span>}
              {p.ratio && <span>{p.ratio}</span>}
              {p.duration != null && <span>{p.duration}s</span>}
              {clip.totalTokens != null && <span>{compactTokens(clip.totalTokens)}t</span>}
              {clip.costUsd != null && <span>{usd(clip.costUsd + (clip.refineCostUsd ?? 0))}</span>}
              <span>{timeAgo(clip.createdAt)}</span>
              {clip.authorName && <span>{clip.authorName}</span>}
              {clip.projectName && <span className="rounded-[4px] bg-black/40 px-1.5 py-px">{clip.projectName}</span>}
            </span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {url && (
              <a href={url} download={`${clipId(clip.id)}.${still ? "png" : "mp4"}`} title="Download"
                className="pointer-events-auto grid h-[26px] w-[26px] place-items-center rounded-[7px] border border-white/20 bg-black/40 text-white/85 transition-colors hover:text-white max-[860px]:h-[34px] max-[860px]:w-[34px]">
                <IconDown />
              </a>
            )}
            <button onClick={remove} title="Delete"
              className="pointer-events-auto grid h-[26px] w-[26px] place-items-center rounded-[7px] border border-white/20 bg-black/40 text-white/85 transition-colors hover:text-white max-[860px]:h-[34px] max-[860px]:w-[34px]">
              <IconTrash />
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function StripItem({ gen, active, onSelect }: { gen: Gen; active: boolean; onSelect: () => void }) {
  const s = STATUS[gen.status] ?? STATUS.queued;
  const url = gen.storedUrl ?? gen.sourceUrl;
  const done = gen.status === "succeeded" && url;
  const still = gen.kind === "image";
  const p = gen.params as { duration?: number; resolution?: string };

  return (
    <button
      onClick={onSelect}
      title={gen.prompt}
      data-gen-id={gen.id} data-gen-prompt={gen.prompt} data-gen-label={clipId(gen.id)}
      className={`relative h-[72px] w-[128px] shrink-0 overflow-hidden rounded-[9px] border bg-thumb text-left transition-all ${
        active
          ? "border-red shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-red)_25%,transparent)]"
          : "border-line hover:border-white/25"
      }`}
    >
      {done ? (
        still ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={url!} alt="" className="h-full w-full object-cover" />
        ) : (
          <video src={posterSrc(url!)} muted preload="metadata" playsInline className="h-full w-full object-cover" />
        )
      ) : (
        <span className={`desk-grid grid h-full place-items-center ${s.live ? "render-sweep" : ""}`}>
          <span className={`font-mono text-[8.5px] tracking-[.16em] ${s.cls}`}>{s.label}</span>
        </span>
      )}

      {(still ? p.resolution : p.duration != null) && (
        <span className="absolute right-1.5 top-1.5 rounded-[4px] bg-black/55 px-1 py-px font-mono text-[8.5px] text-white">
          {still ? String(p.resolution).toUpperCase() : `${p.duration}s`}
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 flex items-baseline gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-1.5 pb-1 pt-3.5 font-mono text-[8.5px] text-white/90">
        <span className="truncate">{clipId(gen.id)}</span>
        {gen.costUsd != null && (
          <span className="ml-auto shrink-0 text-white/70">{usd(gen.costUsd + (gen.refineCostUsd ?? 0), 2)}</span>
        )}
      </span>
    </button>
  );
}
