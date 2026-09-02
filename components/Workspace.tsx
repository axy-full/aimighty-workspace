"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import References, { referenceProblem, type RefItem, type RefPicker } from "./References";
import { appAlert, appConfirm } from "./dialog";
import { Switch } from "./Panel";
import type { Gen } from "./GenCard";
import { useApi } from "@/lib/useApi";
import { usd, compactTokens, timeAgo, downloadHref } from "@/lib/format";
import LazyMedia from "./LazyMedia";
import Cast from "./Cast";
import Studio from "./Studio";
import ShotRow from "./ShotRow";
import { composePrompt, type ShotSpec } from "@/lib/studio";
import Review from "./Review";
import {
  MODELS, DEFAULT_MODEL_ID, getModel, shortLabel, dimensionsFor,
  estimateCostUsd, estimateTokens, estimateImageCostUsd,
} from "@/lib/models";
import { usePrefs } from "@/lib/prefs";
import { useProject } from "@/lib/projectContext";
import { IconDown, IconTrash, IconSparkle, IconArrowUp, IconChevron } from "./Icons";

export type Params = {
  modelId: string; ratio: string; resolution: string; duration: number;
  watermark: boolean; generateAudio: boolean; seed: string;
};

const clipId = (id: string) => id.split("_").pop()!.slice(-6).toUpperCase();

const STATUS: Record<string, { cls: string; label: string; live?: boolean }> = {
  queued:    { cls: "text-mute", label: "Queued", live: true },
  running:   { cls: "text-blue", label: "Rendering", live: true },
  succeeded: { cls: "text-ok",   label: "Ready" },
  failed:    { cls: "text-lift", label: "Failed" },
  cancelled: { cls: "text-mute", label: "Cancelled" },
};

type Menu = null | "model" | "dur" | "ratio" | "res" | "refine";

export default function Workspace() {
  const { selection: bin, refreshProjects } = useProject();
  const prefs = usePrefs();
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  /** Artlist-style shot control: one choice per category, appended at submit. */
  const [spec, setSpec] = useState<ShotSpec>({});
  /** Which shot this take belongs to — what makes it v3 of SH110. */
  const [shotId, setShotId] = useState<string>("");
  /** Editing or extending an existing render, rather than making a new one.
   *  Both are LOCKED tasks: the source decides the output's shape. */
  const [taskOn, setTaskOn] = useState<{ id: "edit" | "extend"; gen: Gen } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [menu, setMenu] = useState<Menu>(null);
  const [stripKind, setStripKind] = useState<"all" | "video" | "image">("all");
  const [advanced, setAdvanced] = useState(false);
  const promptEl = useRef<HTMLTextAreaElement>(null);
  const overlayEl = useRef<HTMLDivElement>(null);
  const picker = useRef<RefPicker>(null);

  // The composer opens on whatever Settings says, then stays where you put it.
  const [params, setParams] = useState<Params>(() => ({
    modelId: DEFAULT_MODEL_ID, ratio: "16:9", resolution: "1080p", duration: 5,
    watermark: false, generateAudio: false, seed: "",
  }));
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    // Work handed over from elsewhere — a card from the canvas, or a prompt
    // and shot spec built in the Studio. Read after mount, never in a
    // useState initializer: the server has no localStorage, so seeding at
    // first render hydrates wrong.
    try {
      const carried = window.localStorage.getItem("aw_compose_seed");
      const carriedSpec = window.localStorage.getItem("aw_compose_spec");
      if (carried) window.localStorage.removeItem("aw_compose_seed");
      if (carriedSpec) window.localStorage.removeItem("aw_compose_spec");
      if (carried || carriedSpec) {
        Promise.resolve().then(() => {
          if (carried) setPrompt(carried);
          if (carriedSpec) {
            try { setSpec(JSON.parse(carriedSpec) as ShotSpec); }
            catch { /* a spec we can't read is one we don't apply */ }
          }
        });
      }
    } catch { /* private mode — nothing carried, nothing lost */ }
    const m = getModel(prefs.modelId);
    setParams((s) => ({
      ...s,
      modelId: m.id,
      resolution: m.resolutions.includes(prefs.resolution) ? prefs.resolution : s.resolution,
      duration: m.durations.includes(prefs.duration) ? prefs.duration : s.duration,
    }));
  }, [prefs]);

  const patch = (p: Partial<Params>) => setParams((s) => ({ ...s, ...p }));

  function switchModel(next: string) {
    setErr(null);          // the old failure was about the old engine
    const m = getModel(next);
    patch({
      modelId: next,
      ratio: m.ratios.includes(params.ratio) ? params.ratio : m.ratios.includes("16:9") ? "16:9" : m.ratios[0],
      resolution: m.resolutions.includes(params.resolution)
        ? params.resolution
        : m.kind === "image" ? "2K" : m.resolutions[0],
      duration: m.durations.includes(params.duration) ? params.duration : m.durations[0] ?? params.duration,
      generateAudio: m.supportsAudio ? params.generateAudio : false,
    });
    if (m.kind === "image") {
      setRefs((prev) => prev.map((r) =>
        r.kind === "image" && r.role !== "reference_image" ? { ...r, role: "reference_image" } : r
      ));
    }
  }

  const query =
    bin === "all" || bin === "unfiled" ? "" : `&projectId=${encodeURIComponent(bin)}`;
  const { data, refresh } = useApi<{ generations: Gen[] }>(`/api/jobs?limit=40${query}`, 5000);
  const gens = useMemo(() => {
    const all = data?.generations ?? [];
    return bin === "unfiled" ? all.filter((g) => !g.projectId) : all;
  }, [data, bin]);

  // The viewer shows a clip ONLY after an explicit filmstrip click — no
  // auto-loading of the newest render, no fallback.
  const activeId = selected && gens.some((g) => g.id === selected) ? selected : null;
  const clip = gens.find((g) => g.id === activeId) ?? null;

  // Clicking outside the clip dismisses it — the viewer, the strip and the
  // composer all count as "inside", and we listen for a completed click so a
  // touch that starts a scroll never blanks the viewer mid-gesture.
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

  // The composer grows with the prompt, and the highlight layer must track
  // the textarea's scroll exactly or the coloured @cites drift.
  const fitComposer = useCallback(() => {
    const el = promptEl.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    if (overlayEl.current) overlayEl.current.scrollTop = el.scrollTop;
  }, []);

  useEffect(() => { fitComposer(); }, [prompt, fitComposer]);

  /* A height in px computed for one width is wrong at the next one: the same
     text needs more lines when the box narrows, and the tail scrolled out of
     a fixed-height textarea with no scrollbar until the next keystroke. The
     box changes width on window resize, on crossing 860px, and whenever the
     reference chips or the error banner reflow the card — so observe it. */
  useEffect(() => {
    const el = promptEl.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fitComposer());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitComposer]);

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
    // The same conditions that disable the send button. The guard lives HERE
    // rather than only on the button, because Cmd/Ctrl+Enter calls render()
    // directly — it was posting reference payloads the UI had already
    // declared invalid, producing a failed render from a blocked control.
    if (!prompt.trim() || busy || refProblem) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: composePrompt(prompt, spec),
          model: params.modelId, ratio: params.ratio,
          resolution: params.resolution, duration: params.duration,
          watermark: params.watermark, generateAudio: params.generateAudio,
          seed: params.seed || null,
          projectId: bin !== "all" && bin !== "unfiled" ? bin : null,
          task: taskOn?.id ?? "generate",
          sourceGenId: taskOn?.gen.id ?? null,
          shotId: shotId || null,
          shotSpec: spec,
          references: refs.map((r) => ({ uploadId: r.id, role: r.role })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Submit failed");
      setPrompt("");
      setRefs([]);
      setTaskOn(null);
      if (Array.isArray(json?.notices) && json.notices.length) {
        await appAlert("Sent", json.notices.join("\n\n"));
      }
      // The spec and the shot deliberately survive: the reason to have shot
      // control at all is changing one chip and running the take again.
      if (!json?.id) throw new Error("Submit failed");
      afterChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  // Prompt text with @cites picked out, painted under a transparent textarea.
  const segments = useMemo(() => {
    const out: { t: string; tag: boolean }[] = [];
    for (const part of prompt.split(/(@(?:Image|Video)\d+)/gi)) {
      if (part) out.push({ t: part, tag: /^@(?:Image|Video)\d+$/i.test(part) });
    }
    if (prompt.endsWith("\n") || prompt === "") out.push({ t: "​", tag: false });
    return out;
  }, [prompt]);

  const clipCount = gens.filter((g) => g.kind !== "image").length;
  const stillCount = gens.length - clipCount;
  const mixed = clipCount > 0 && stillCount > 0;
  const strip = !mixed || stripKind === "all"
    ? gens
    : gens.filter((g) => (stripKind === "image" ? g.kind === "image" : g.kind !== "image"));

  return (
    <div className="generate">
      {/* ── The work ──────────────────────────────────────────────────── */}
      <div className="generate-main">
        <section ref={viewerRef as React.Ref<HTMLElement>}
          className="flex min-h-0 flex-1 flex-col gap-3 max-[860px]:flex-none">
          <ViewerBody clip={clip} onChanged={afterChange} />
          {clip && (
            <ClipDetail
              clip={clip}
              onChanged={afterChange}
              onEditExtend={(id) => {
                setTaskOn({ id, gen: clip });
                setPrompt(id === "edit"
                  ? "Replace "
                  : "Continue from the final frame: ");
                promptEl.current?.focus();
              }}
              onUse={async () => {
                if (prompt.trim() &&
                    !(await appConfirm("Replace the composer?", "This clip's prompt will replace what you've typed.", { confirmLabel: "Replace" }))) return;
                // Hand back what was typed — cast names, not the @ImageN they became.
                const typed = (clip.params as { rawPrompt?: string }).rawPrompt;
                setPrompt(typed || clip.prompt);
                promptEl.current?.focus();
              }}
            />
          )}
        </section>

        {/* ── Composer: one pill, the way a message box should feel ────── */}
        <div ref={islandRef} className="shrink-0">
          {refs.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {refs.map((r) => {
                const token = citeTokenFor(r);
                const citable = token.startsWith("@");
                return (
                  <span key={r.id} className="flex items-center gap-1.5 rounded-full bg-panel2 py-1 pl-2.5 pr-1.5 text-[13px]">
                    <button onClick={() => citable && cite(token)}
                      title={citable ? "Cite in the prompt" : r.role.replace("_", " ")}
                      className="flex items-center gap-1.5">
                      <span className="font-medium text-blue">{token}</span>
                      <span className="max-w-[130px] truncate text-dim">{r.filename}</span>
                    </button>
                    <button
                      onClick={() => {
                        setRefs((prev) => prev.filter((x) => x.id !== r.id));
                        fetch(`/api/uploads/${r.id}`, { method: "DELETE" }).catch(() => {});
                      }}
                      className="grid h-4 w-4 place-items-center rounded-full text-mute hover:bg-chip2 hover:text-bone"
                      title="Remove">×</button>
                  </span>
                );
              })}
            </div>
          )}

          {taskOn && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-[12px] bg-blue/8 px-3.5 py-2 text-[13.5px] text-blue">
              <span className="font-medium">
                {taskOn.id === "edit" ? "Editing" : "Continuing"}
              </span>
              <span className="truncate text-dim">
                {taskOn.gen.shotCode ? `${taskOn.gen.shotCode} v${taskOn.gen.version}` : "this render"}
              </span>
              <span className="text-[12px] text-mute">
                {taskOn.id === "edit"
                  ? "aspect and length follow the source"
                  : "aspect follows the source"}
              </span>
              <button onClick={() => setTaskOn(null)}
                className="ml-auto text-[12px] text-lift">Cancel</button>
            </div>
          )}

          {/* The blocking reason wins over a stale submit error — that error
              used to sit on top of it, so the send button went dead with no
              visible cause. */}
          {(err || refProblem) && (
            <p className="mb-2 rounded-[12px] bg-lift/8 px-3.5 py-2 text-[13.5px] leading-relaxed text-lift">
              {refProblem ?? err}
            </p>
          )}

          <div className="card flex items-end gap-2 rounded-[24px] px-4 py-2.5">
            <span className="pb-2 text-mute"><IconSparkle /></span>
            <div className="relative min-w-0 flex-1">
              <div ref={overlayEl} aria-hidden
                className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words py-2 text-[16px] leading-[1.45]">
                {segments.map((s, i) =>
                  s.tag ? (
                    <span key={i} className="rounded-[4px] font-medium text-blue"
                      style={{ background: "color-mix(in oklab, var(--color-blue) 12%, transparent)" }}>
                      {s.t}
                    </span>
                  ) : <span key={i}>{s.t}</span>
                )}
              </div>
              <textarea
                ref={promptEl} rows={1}
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  // A submit error describes a submit that already happened.
                  if (err) setErr(null);
                }}
                onScroll={(e) => { if (overlayEl.current) overlayEl.current.scrollTop = e.currentTarget.scrollTop; }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); render(); }
                }}
                placeholder="Describe the shot…"
                spellCheck={false}
                /* Stable gutter: past 160px the textarea scrolls, and on
                   platforms with classic scrollbars that gutter comes out of
                   its content box only — the transparent text then wrapped
                   earlier than the painted highlight underneath it. */
                style={{ scrollbarGutter: "stable" }}
                className="relative block max-h-[160px] w-full resize-none bg-transparent py-2 text-[16px] leading-[1.45] text-transparent caret-bone placeholder:text-mute focus:outline-none"
              />
            </div>
            <button
              type="button" onClick={render}
              disabled={busy || !prompt.trim() || Boolean(refProblem)}
              title="⌘ + ↵"
              className="btn-render mb-0.5 grid h-9 w-9 shrink-0 place-items-center"
            >
              <IconArrowUp />
            </button>
          </div>

          <div className="mt-1.5 flex items-center gap-3 px-4 text-[12px] text-mute">
            <button
              onClick={() => setMenu(menu === "refine" ? null : "refine")}
              className="relative transition-colors hover:text-dim"
            >
              {isImage ? "Thinks first" : "Auto-refined"}
              {menu === "refine" && (
                <>
                  <span className="fixed inset-0 z-50" onClick={() => setMenu(null)} />
                  <span className="menu-pop block w-[260px] px-3 py-2.5 text-left text-[13px] leading-relaxed text-dim">
                    Every prompt is rewritten with ByteDance&apos;s own Seedance recipe
                    before it renders. Start with{" "}
                    <span className="font-medium text-blue">raw:</span> to send your exact
                    words instead.
                  </span>
                </>
              )}
            </button>
            <span className="ml-auto tabular-nums">{prompt.trim().length}/10000</span>
          </div>
        </div>

        {/* ── The shelf ─────────────────────────────────────────────────── */}
        <section ref={stripRef as React.Ref<HTMLElement>} className="shrink-0">
          {mixed && (
            <div className="mb-2 flex items-center gap-1">
              {([
                ["all", `All ${gens.length}`],
                ["video", `Clips ${clipCount}`],
                ["image", `Stills ${stillCount}`],
              ] as const).map(([k, label]) => (
                <button key={k} onClick={() => setStripKind(k)}
                  className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    stripKind === k ? "bg-chip2 text-bone" : "text-mute hover:text-dim"
                  }`}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="pan-x flex gap-3 overflow-x-auto pb-1">
            {gens.length === 0 ? (
              <div className="flex h-[76px] w-full items-center justify-center rounded-[14px] bg-panel2">
                <p className="text-[13px] text-mute">Renders land here as they finish.</p>
              </div>
            ) : strip.length === 0 ? (
              <div className="flex h-[76px] w-full items-center justify-center rounded-[14px] bg-panel2">
                <p className="text-[13px] text-mute">Nothing of this kind yet.</p>
              </div>
            ) : (
              strip.map((g) => (
                <StripItem key={g.id} gen={g} active={g.id === activeId} onSelect={() => setSelected(g.id)} />
              ))
            )}
          </div>
        </section>
      </div>

      {/* ── The settings card ─────────────────────────────────────────── */}
      <aside className="generate-side">
        <div className="rows">
          <MenuRow
            label="Model" value={modelDef.label}
            open={menu === "model"} setOpen={(v) => setMenu(v ? "model" : null)}
          >
            {MODELS.map((m) => (
              <button key={m.id} onClick={() => { switchModel(m.id); setMenu(null); }} className="menu-item">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{m.label}</span>
                  <span className="text-[12.5px] text-mute">{m.note}</span>
                </span>
                <span className={params.modelId === m.id ? "text-blue" : "text-transparent"}>✓</span>
              </button>
            ))}
          </MenuRow>

          {!isImage && (
            <MenuRow
              label="Duration" value={`${params.duration}s`}
              open={menu === "dur"} setOpen={(v) => setMenu(v ? "dur" : null)}
            >
              {modelDef.durations.map((d) => {
                const c = estimateCostUsd(params.modelId, params.resolution, params.ratio, d, inputSeconds, hasVideoInput);
                return (
                  <button key={d} onClick={() => { patch({ duration: d }); setMenu(null); }} className="menu-item">
                    <span className={`flex-1 ${params.duration === d ? "text-blue" : ""}`}>{d}s</span>
                    <span className="text-[13px] text-mute">{c ? usd(c.net, 2) : ""}</span>
                  </button>
                );
              })}
            </MenuRow>
          )}

          <MenuRow
            label="Aspect" value={params.ratio === "adaptive" ? "Auto" : params.ratio}
            open={menu === "ratio"} setOpen={(v) => setMenu(v ? "ratio" : null)}
          >
            {modelDef.ratios.map((r) => (
              <button key={r} onClick={() => { patch({ ratio: r }); setMenu(null); }}
                className={`menu-item ${params.ratio === r ? "text-blue" : ""}`}>
                {r === "adaptive" ? "Auto" : r}
              </button>
            ))}
          </MenuRow>

          <MenuRow
            label="Resolution" value={params.resolution.toUpperCase()}
            hint={dims ? `${dims.w} × ${dims.h}` : undefined}
            open={menu === "res"} setOpen={(v) => setMenu(v ? "res" : null)}
          >
            {modelDef.resolutions.map((r) => {
              const c = isImage ? estimateImageCostUsd(r, imageRefCount) : null;
              return (
                <button key={r} onClick={() => { patch({ resolution: r }); setMenu(null); }} className="menu-item">
                  <span className={`flex-1 ${params.resolution === r ? "text-blue" : ""}`}>{r.toUpperCase()}</span>
                  {c && <span className="text-[13px] text-mute">{usd(c.net, 2)}</span>}
                </button>
              );
            })}
          </MenuRow>

          {!isImage && (
            <div className="row">
              <span className="flex flex-col">
                Audio
                {!modelDef.supportsAudio && (
                  <span className="text-[13px] text-mute">Seedance 2.5 only</span>
                )}
              </span>
              <span className="row-value">
                <Switch
                  checked={params.generateAudio}
                  disabled={!modelDef.supportsAudio}
                  onChange={(v) => patch({ generateAudio: v })}
                />
              </span>
            </div>
          )}

          <button className="row" onClick={() => setAdvanced(!advanced)}>
            Advanced
            <span className="row-value">
              <IconChevron className={`!text-mute transition-transform ${advanced ? "rotate-90" : ""}`} />
            </span>
          </button>

          {advanced && !isImage && (
            <>
              <div className="row">
                Seed
                <span className="row-value">
                  <input
                    className="ctl !h-8 w-[110px] text-right" value={params.seed}
                    inputMode="numeric" placeholder="Random"
                    onChange={(e) => patch({ seed: e.target.value.replace(/\D/g, "") })}
                  />
                </span>
              </div>
              <div className="row">
                Watermark
                <span className="row-value">
                  <Switch checked={params.watermark} onChange={(v) => patch({ watermark: v })} />
                </span>
              </div>
            </>
          )}
          {advanced && isImage && (
            <div className="row">
              <span className="text-[14px] leading-relaxed text-dim">
                Stills take their size and shape above; there are no seeds or
                watermark controls on this engine.
              </span>
            </div>
          )}
        </div>

        <div className="mt-4">
          <ShotRow projectId={bin} shotId={shotId} setShotId={setShotId} />
        </div>

        <div className="mt-4">
          <Studio spec={spec} setSpec={setSpec} />
        </div>

        <div className="mt-4">
          <Cast projectId={bin} onCite={cite} />
        </div>

        <div className="mt-4">
          <References refs={refs} setRefs={setRefs} onCite={cite} model={modelDef} pickerRef={picker} />
        </div>

        <p className="mt-4 text-center text-[13px] text-dim">
          This shot{" "}
          <span className="font-semibold text-bone">{est ? usd(est.net, 2) : "—"}</span>
          {!isImage && estTokens != null && (
            <span className="text-mute"> · {compactTokens(estTokens)} tokens</span>
          )}
        </p>
      </aside>
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────── */

/** A settings row that opens its options in a floating menu. */
function MenuRow({ label, value, hint, open, setOpen, children }: {
  label: string; value: string; hint?: string;
  open: boolean; setOpen: (v: boolean) => void;
  children: React.ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const r = wrapRef.current?.getBoundingClientRect();
    // Open downward when there isn't room above — these rows sit high on the page.
    if (r) setDrop(r.top < 280);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button className="row w-full" onClick={() => setOpen(!open)}>
        {label}
        <span className="row-value">
          {hint && <span className="text-[13px] text-mute">{hint}</span>}
          {value}
          <IconChevron className="!text-mute" />
        </span>
      </button>
      {open && (
        <>
          <button aria-label="Close menu" onClick={() => setOpen(false)}
            className="fixed inset-0 z-50 cursor-default" />
          <span
            className="menu-pop block right-3 !left-auto"
            style={drop ? { top: "calc(100% - 4px)", bottom: "auto" } : undefined}
          >
            {children}
          </span>
        </>
      )}
    </div>
  );
}

/** What the selected clip is, what it cost, and what to do with it. */
function ClipDetail({ clip, onUse, onChanged, onEditExtend }: {
  clip: Gen; onUse: () => void; onChanged: () => void;
  onEditExtend: (task: "edit" | "extend") => void;
}) {
  const [copied, setCopied] = useState(false);
  const p = clip.params as {
    resolution?: string; ratio?: string; duration?: number; seed?: number | string | null;
    rawPrompt?: string; cast?: string[];
  };
  // What a person wrote, when it differs from what was sent to the engine.
  const shown = p.rawPrompt || clip.prompt;

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — nothing sensible to do */ }
  }

  return (
    <div className="card shrink-0 px-4 py-3">
      <p className="max-h-[84px] select-text overflow-y-auto whitespace-pre-wrap text-[14px] leading-relaxed text-bone/90">
        {shown}
      </p>
      {p.cast && p.cast.length > 0 && (
        <p className="mt-1.5 flex flex-wrap gap-1.5">
          {p.cast.map((n) => (
            <span key={n} className="rounded-full bg-blue/10 px-2 py-0.5 text-[12px] font-medium text-blue">
              @{n}
            </span>
          ))}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-mute">
        <span className="font-medium text-dim">{shortLabel(clip.model)}</span>
        {p.resolution && <span>{String(p.resolution).toUpperCase()}</span>}
        {p.ratio && <span>{p.ratio}</span>}
        {p.duration != null && <span>{p.duration}s</span>}
        {p.seed != null && p.seed !== "" && <span>seed {p.seed}</span>}
        {clip.costUsd != null && (
          <span className="font-medium text-bone" title={clip.refineCostUsd ? "includes prompt refinement" : undefined}>
            {usd(clip.costUsd + (clip.refineCostUsd ?? 0))}
          </span>
        )}
        {clip.authorName && <span>· {clip.authorName}</span>}
        <span>· {timeAgo(clip.createdAt)}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <button onClick={copy} className="chip !py-1.5 !text-[12.5px]">
            {copied ? "Copied" : "Copy prompt"}
          </button>
          <button onClick={onUse} className="chip !py-1.5 !text-[12.5px]" title="Load into the composer">
            Use
          </button>
          {/* Editing and extension work on a finished video, so they only
              exist once there is one. */}
          {clip.status === "succeeded" && clip.storedUrl && clip.kind !== "image" && (
            <>
              <button onClick={() => onEditExtend("edit")}
                className="chip !py-1.5 !text-[12.5px]"
                title="Change something inside this shot; everything else stays">
                Edit
              </button>
              <button onClick={() => onEditExtend("extend")}
                className="chip !py-1.5 !text-[12.5px]"
                title="Continue this shot from its final frame">
                Extend
              </button>
            </>
          )}
        </span>
      </div>

      <Review
        genId={clip.id}
        state={clip.reviewState ?? ""}
        reviewBy={clip.reviewBy ?? null}
        onChanged={onChanged}
      />
    </div>
  );
}

function ViewerBody({ clip, onChanged }: { clip: Gen | null; onChanged: () => void }) {
  if (!clip) {
    return (
      <div className="viewer-stage grid min-h-0 flex-1 place-items-center">
        <div className="stage16 grid place-items-center overflow-hidden rounded-[var(--r-lg)] bg-thumb">
          <div className="text-center">
            <p className="text-[15px] font-medium text-dim">Nothing playing</p>
            <p className="mt-1 text-[13px] text-mute">Pick a render from the shelf below.</p>
          </div>
        </div>
      </div>
    );
  }

  const s = STATUS[clip.status] ?? STATUS.queued;
  const url = clip.storedUrl ?? clip.sourceUrl;
  const done = clip.status === "succeeded" && url;
  const still = clip.kind === "image";

  async function remove() {
    if (!(await appConfirm(`Delete ${clipId(clip!.id)}?`, "Its cost stays on the ledger.", { confirmLabel: "Delete", danger: true }))) return;
    await fetch(`/api/jobs/${clip!.id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <div className="viewer-stage grid min-h-0 flex-1 place-items-center"
      data-gen-id={clip.id} data-gen-prompt={clip.prompt} data-gen-label={clipId(clip.id)}>
      <div className={`stage16 group relative overflow-hidden rounded-[var(--r-lg)] shadow-[var(--shadow-media)] ${done ? "bg-black" : "bg-thumb"}`}>
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
          <div className="absolute inset-0 grid place-items-center px-6">
            {clip.error ? (
              <p className="max-w-[520px] text-center text-[13.5px] leading-relaxed text-lift">
                {clip.error}
              </p>
            ) : (
              <div className={`flex flex-col items-center gap-3 ${s.live ? "render-sweep" : ""}`}>
                <span className={`text-[15px] font-medium ${s.cls}`}>{s.label}…</span>
                {s.live && (
                  <span className="block h-[3px] w-[180px] overflow-hidden rounded-full bg-black/10">
                    <span className="block h-full w-1/3 rounded-full bg-blue"
                      style={{ animation: "stripSlide 1.6s ease-in-out infinite" }} />
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Actions ride the corner, revealed on approach so the frame stays clean. */}
        <span className="reveal absolute right-3 top-3 flex items-center gap-1.5">
          {url && (
            <a href={downloadHref(url)} download={`${clipId(clip.id)}.${still ? "png" : "mp4"}`} title="Download"
              className="grid h-8 w-8 place-items-center rounded-full bg-white/85 text-bone shadow-[var(--shadow-card)] backdrop-blur transition-colors hover:bg-white">
              <IconDown />
            </a>
          )}
          <button onClick={remove} title="Delete"
            className="grid h-8 w-8 place-items-center rounded-full bg-white/85 text-bone shadow-[var(--shadow-card)] backdrop-blur transition-colors hover:bg-white hover:text-lift">
            <IconTrash />
          </button>
        </span>
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
      className={`relative h-[76px] w-[134px] shrink-0 overflow-hidden rounded-[12px] bg-thumb text-left transition-all duration-150 ${
        active
          ? "ring-2 ring-blue ring-offset-2 ring-offset-desk"
          : "hover:-translate-y-0.5 hover:shadow-[var(--shadow-card)]"
      }`}
    >
      {done ? (
        <LazyMedia url={url!} kind={still ? "image" : "video"} />
      ) : (
        <span className={`grid h-full place-items-center ${s.live ? "render-sweep" : ""}`}>
          <span className={`text-[11px] font-medium ${s.cls}`}>{s.label}</span>
        </span>
      )}

      {gen.reviewState === "approved" && (
        <span className="absolute left-1.5 top-1.5 grid h-4 w-4 place-items-center rounded-full bg-ok text-[10px] font-bold text-white"
          title="Approved">✓</span>
      )}
      {gen.reviewState === "changes" && (
        <span className="absolute left-1.5 top-1.5 h-4 w-4 rounded-full bg-warn"
          title="Changes wanted" />
      )}
      {(still ? p.resolution : p.duration != null) && done && (
        <span className="absolute right-1.5 top-1.5 rounded-full bg-black/45 px-1.5 py-px text-[10px] font-medium text-white backdrop-blur-sm">
          {still ? String(p.resolution).toUpperCase() : `${p.duration}s`}
        </span>
      )}
    </button>
  );
}
