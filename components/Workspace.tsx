"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Inspector, { type Params } from "./Inspector";
import References, { referenceProblem, type RefItem } from "./References";
import { Panel } from "./Panel";
import type { Gen } from "./GenCard";
import { useApi } from "@/lib/useApi";
import { usd, compactTokens, timeAgo, posterSrc } from "@/lib/format";
import { DEFAULT_MODEL_ID, getModel } from "@/lib/models";
import { IconBins, IconLibrary, IconDown, IconTrash, IconFilm, IconTeam } from "./Icons";

type Project = { id: string; name: string; genCount: number; spend: number };

const clipId = (id: string) => id.split("_").pop()!.slice(-6).toUpperCase();

const STATUS: Record<string, { cls: string; label: string; live?: boolean }> = {
  queued:    { cls: "text-mute", label: "QUEUED", live: true },
  running:   { cls: "text-run",  label: "RENDER", live: true },
  succeeded: { cls: "text-ok",   label: "OK" },
  failed:    { cls: "text-lift", label: "FAILED" },
  cancelled: { cls: "text-mute", label: "CANCELLED" },
};

export default function Workspace({ lockedProjectId }: { lockedProjectId?: string }) {
  const [bin, setBin] = useState<string>(lockedProjectId ?? "all");
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(lockedProjectId ?? "");
  const [refs, setRefs] = useState<RefItem[]>([]);
  const promptEl = useRef<HTMLTextAreaElement>(null);

  const [params, setParams] = useState<Params>({
    modelId: DEFAULT_MODEL_ID, ratio: "16:9", resolution: "720p", duration: 5,
    watermark: false, generateAudio: false, seed: "",
  });
  const patch = (p: Partial<Params>) => setParams((s) => ({ ...s, ...p }));

  const { data: me } = useApi<{ id: string; name: string }>("/api/me");
  const { data: pj, refresh: refreshProjects } = useApi<{ projects: Project[] }>("/api/projects");
  const query =
    bin === "mine" ? "&mine=1"
    : bin === "all" || bin === "unfiled" ? ""
    : `&projectId=${encodeURIComponent(bin)}`;
  const { data, refresh } = useApi<{ generations: Gen[] }>(`/api/jobs?limit=300${query}`, 5000);

  const projects = pj?.projects ?? [];
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
  // plus its prompt panel (so Copy/Use don't dismiss what they act on) and
  // the filmstrip (so choosing another clip, or dragging the strip's
  // scrollbar, never blanks the view).
  const viewerRef = useRef<HTMLElement>(null);
  const stripRef = useRef<HTMLElement>(null);
  useEffect(() => {
    function onDown(e: PointerEvent) {
      const t = e.target as Node;
      if (viewerRef.current?.contains(t) || stripRef.current?.contains(t)) return;
      setSelected(null);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);
  const modelDef = getModel(params.modelId);
  const refProblem = referenceProblem(refs, modelDef, prompt);
  const hasVideoInput = refs.some((r) => r.kind === "video");
  const inputSeconds = refs
    .filter((r) => r.kind === "video")
    .reduce((a, r) => a + (r.durationS ?? 0), 0);
  const pending = gens.filter((g) => g.status === "queued" || g.status === "running").length;

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
          seed: params.seed || null, projectId: projectId || null,
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

  return (
    <div className="bench">
      {/* ── MEDIA POOL ──────────────────────────────────────────── */}
      <Panel
        title="Media pool" className="bench-pool border-0" bodyClass="overflow-y-auto"
        right={
          <>
            {me && <span className="font-mono text-[9px] tracking-wider text-mute">{me.name.split(" ")[0].toUpperCase()}</span>}
            <Link href="/projects" className="font-mono text-[9px] tracking-wider text-mute hover:text-lift">EDIT</Link>
          </>
        }
      >
        <ul className="py-1">
          <PoolRow label="All clips" icon={<IconLibrary className="!h-3.5 !w-3.5" />}
            active={bin === "all"} onClick={() => !lockedProjectId && setBin("all")}
            disabled={Boolean(lockedProjectId)}
            count={bin === "all" ? gens.length : undefined} />
          <PoolRow label="My clips" icon={<IconTeam className="!h-3.5 !w-3.5" />}
            active={bin === "mine"} onClick={() => !lockedProjectId && setBin("mine")}
            disabled={Boolean(lockedProjectId)}
            count={bin === "mine" ? gens.length : undefined} />
          <PoolRow label="Unfiled" icon={<IconFilm className="!h-3.5 !w-3.5" />}
            active={bin === "unfiled"} onClick={() => !lockedProjectId && setBin("unfiled")}
            disabled={Boolean(lockedProjectId)} />
          <li className="lbl px-2.5 pb-1 pt-3">Bins</li>
          {projects.map((p) => (
            <PoolRow
              key={p.id} label={p.name} icon={<IconBins className="!h-3.5 !w-3.5" />}
              active={bin === p.id} onClick={() => !lockedProjectId && setBin(p.id)}
              disabled={Boolean(lockedProjectId) && lockedProjectId !== p.id}
              count={p.genCount} spend={p.spend}
            />
          ))}
          {projects.length === 0 && (
            <li className="px-2.5 py-2 text-[11px] leading-relaxed text-mute">
              No bins yet. <Link href="/projects" className="text-lift hover:underline">Create one →</Link>
            </li>
          )}
        </ul>
      </Panel>

      {/* ── CENTRE: viewer over prompt ───────────────────────────── */}
      <div className="bench-centre flex flex-col gap-px bg-line">
        <div ref={viewerRef as React.Ref<HTMLDivElement>} className="flex min-h-0 flex-1 flex-col gap-px bg-line">
          <Panel
            title="Viewer" className="min-h-0 flex-1 border-0" bodyClass="flex flex-col"
            right={clip && (
              <span className="font-mono text-[9.5px] tracking-wider text-dim">{clipId(clip.id)}</span>
            )}
          >
            <ViewerBody clip={clip} onChanged={afterChange} />
          </Panel>

          {clip && (
            <ClipPrompt
              clip={clip}
              onUse={() => {
                if (prompt.trim() && !confirm("Replace what's in the composer with this clip's prompt?")) return;
                setPrompt(clip.prompt);
                promptEl.current?.focus();
              }}
            />
          )}
        </div>

        <Panel
          title="Prompt" className="shrink-0 border-0"
          right={<span className="font-mono text-[9.5px] tabular-nums text-mute">{prompt.trim().length}/10000</span>}
        >
          <References refs={refs} setRefs={setRefs} onCite={cite} model={modelDef} />
          <div className="flex items-stretch gap-px bg-line">
            <textarea
              ref={promptEl}
              value={prompt} onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); render(); }
              }}
              placeholder="Subject, action, camera move, lens, lighting, mood…"
              spellCheck={false}
              className="h-[76px] min-w-0 flex-1 resize-none bg-panel px-3 py-2.5 text-[13.5px] leading-relaxed text-bone placeholder:text-mute/60 focus:outline-none"
            />
            <button
              onClick={render} disabled={busy || !prompt.trim() || Boolean(refProblem)}
              className="ptitle w-[104px] shrink-0 bg-red text-[11px] tracking-[.1em] text-white transition-colors hover:bg-lift disabled:cursor-not-allowed disabled:bg-panel2 disabled:text-mute"
            >
              {busy ? "…" : "Render"}
            </button>
          </div>
          {err && (
            <p className="border-t border-line bg-lift/8 px-3 py-1.5 font-mono text-[10.5px] leading-relaxed text-lift">
              {err}
            </p>
          )}
        </Panel>
      </div>

      {/* ── INSPECTOR ───────────────────────────────────────────── */}
      <div className="bench-inspector">
        <Inspector
          params={params} patch={patch} projects={projects}
          projectId={projectId} setProjectId={setProjectId}
          lockedProjectId={lockedProjectId}
          onRender={render} busy={busy} canRender={Boolean(prompt.trim()) && !refProblem}
          inputSeconds={inputSeconds} hasVideoInput={hasVideoInput}
        />
      </div>

      {/* ── FILMSTRIP ───────────────────────────────────────────── */}
      <Panel
        rootRef={stripRef}
        title="Clips" className="bench-strip border-0" bodyClass="overflow-x-auto overflow-y-hidden"
        right={
          <>
            {pending > 0 && (
              <span className="flex items-center gap-1.5 font-mono text-[9.5px] tracking-wider text-run">
                <span className="lamp lamp-live" />{pending} IN QUEUE
              </span>
            )}
            <span className="font-mono text-[9.5px] tracking-wider text-mute">
              {String(gens.length).padStart(3, "0")}
            </span>
            <Link href="/all" className="font-mono text-[9.5px] tracking-wider text-mute hover:text-lift">
              LIBRARY →
            </Link>
          </>
        }
      >
        {gens.length === 0 ? (
          <div className="desk-grid grid h-full place-items-center">
            <p className="font-mono text-[10.5px] tracking-[.14em] text-mute">
              NO CLIPS — WRITE A PROMPT AND HIT RENDER
            </p>
          </div>
        ) : (
          <div className="flex h-full gap-px bg-line">
            {gens.map((g) => (
              <StripItem key={g.id} gen={g} active={g.id === activeId} onSelect={() => setSelected(g.id)} />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────── */

function PoolRow({ label, icon, active, onClick, disabled, count, spend }: {
  label: string; icon: React.ReactNode; active: boolean; onClick: () => void;
  disabled?: boolean; count?: number; spend?: number;
}) {
  return (
    <li>
      <button
        onClick={onClick} disabled={disabled}
        className={`flex w-full items-center gap-2 px-2.5 py-[6px] text-left transition-colors ${
          active ? "bg-panel3 text-bone" : "text-dim hover:bg-panel2"
        } ${disabled && !active ? "opacity-35" : ""}`}
      >
        <span className={active ? "text-lift" : "text-mute"}>{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[12px]">{label}</span>
        {count != null && (
          <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-mute">
            {String(count).padStart(2, "0")}
          </span>
        )}
        {spend != null && spend > 0 && (
          <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-lift">{usd(spend, 2)}</span>
        )}
      </button>
    </li>
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
    <Panel
      title="Clip prompt"
      className="shrink-0 border-0"
      right={
        <>
          <button onClick={copy}
            className="rounded-[2px] border border-line px-2 py-0.5 font-mono text-[9px] tracking-wider text-dim hover:border-lift hover:text-lift">
            {copied ? "COPIED ✓" : "COPY"}
          </button>
          <button onClick={onUse} title="Load into the composer"
            className="rounded-[2px] border border-line px-2 py-0.5 font-mono text-[9px] tracking-wider text-dim hover:border-lift hover:text-lift">
            USE
          </button>
        </>
      }
    >
      <p className="max-h-[110px] select-text overflow-y-auto whitespace-pre-wrap px-3 py-2 text-[12.5px] leading-relaxed text-bone/90">
        {clip.prompt}
      </p>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-hair px-3 py-1.5 font-mono text-[9.5px] text-mute">
        <span className="text-dim">{clip.model.includes("2-5") ? "SD 2.5" : "SD 2.0"}</span>
        {p.resolution && <span>{String(p.resolution).toUpperCase()}</span>}
        {p.ratio && <span>{p.ratio}</span>}
        {p.duration != null && <span>{p.duration}s</span>}
        {p.seed != null && p.seed !== "" && <span>seed {p.seed}</span>}
        {clip.totalTokens != null && <span>{compactTokens(clip.totalTokens)}t</span>}
        {clip.costUsd != null && <span className="text-lift">{usd(clip.costUsd)}</span>}
        {clip.authorName && <span className="ml-auto text-dim">{clip.authorName}</span>}
      </div>
    </Panel>
  );
}

function ViewerBody({ clip, onChanged }: { clip: Gen | null; onChanged: () => void }) {
  if (!clip) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-desk p-2" style={{ containerType: "size" }}>
        <div
          className="desk-grid relative grid place-items-center overflow-hidden border border-hair bg-black"
          style={{ aspectRatio: "16 / 9", width: "min(100cqw - 16px, (100cqh - 16px) * 16 / 9)" }}
        >
          <p className="font-mono text-[10.5px] tracking-[.14em] text-mute">CLICK A CLIP BELOW TO LOAD IT</p>
        </div>
      </div>
    );
  }

  const s = STATUS[clip.status] ?? STATUS.queued;
  const url = clip.storedUrl ?? clip.sourceUrl;
  const p = clip.params as { resolution?: string; ratio?: string; duration?: number };
  const done = clip.status === "succeeded" && url;

  async function remove() {
    if (!confirm(`Delete clip ${clipId(clip!.id)}?`)) return;
    await fetch(`/api/jobs/${clip!.id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <>
      <div
        className="grid min-h-0 flex-1 place-items-center bg-desk p-2"
        style={{ containerType: "size" }}
      >
        {/* Fixed 16:9 slate; non-16:9 clips letterbox inside it like any NLE viewer. */}
        <div
          className="relative overflow-hidden border border-hair bg-black"
          style={{ aspectRatio: "16 / 9", width: "min(100cqw - 16px, (100cqh - 16px) * 16 / 9)" }}
        >
          {done ? (
            <video key={clip.id} src={url!} controls loop preload="metadata"
              className="absolute inset-0 h-full w-full object-contain" />
          ) : (
            <div className="desk-grid absolute inset-0 grid place-items-center px-6">
              {clip.error ? (
                <p className="max-w-[520px] text-center font-mono text-[11px] leading-relaxed text-lift/85">
                  {clip.error}
                </p>
              ) : (
                <span className={`font-mono text-[11px] tracking-[.24em] ${s.cls}`}>{s.label}…</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-panel2 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[9.5px] text-mute">
          <span className={s.cls}>{s.label}</span>
          {p.resolution && <span className="text-dim">{p.resolution.toUpperCase()}</span>}
          {p.ratio && <span>{p.ratio}</span>}
          {p.duration != null && <span>{p.duration}s</span>}
          {clip.totalTokens != null && <span>{compactTokens(clip.totalTokens)}t</span>}
          {clip.costUsd != null && <span className="text-lift">{usd(clip.costUsd)}</span>}
          <span>{timeAgo(clip.createdAt)}</span>
          {clip.authorName && <span className="text-dim">{clip.authorName}</span>}
          {clip.projectName && <span className="border border-hair px-1.5 py-px text-dim">{clip.projectName}</span>}

          <span className="ml-auto flex items-center gap-1">
            {url && (
              <a href={url} download={`${clipId(clip.id)}.mp4`} title="Download"
                className="grid h-[22px] w-[22px] place-items-center rounded-[2px] border border-line text-dim hover:border-lift hover:text-lift">
                <IconDown />
              </a>
            )}
            <button onClick={remove} title="Delete"
              className="grid h-[22px] w-[22px] place-items-center rounded-[2px] border border-line text-dim hover:border-lift hover:text-lift">
              <IconTrash />
            </button>
          </span>
        </div>
      </div>
    </>
  );
}

function StripItem({ gen, active, onSelect }: { gen: Gen; active: boolean; onSelect: () => void }) {
  const s = STATUS[gen.status] ?? STATUS.queued;
  const url = gen.storedUrl ?? gen.sourceUrl;
  const done = gen.status === "succeeded" && url;

  return (
    <button
      onClick={onSelect}
      className={`group relative flex h-full w-[214px] shrink-0 flex-col bg-panel text-left transition-colors ${
        active ? "ring-1 ring-inset ring-lift" : "hover:bg-panel2"
      }`}
    >
      <span className="flex h-[19px] shrink-0 items-center gap-1.5 border-b border-hair px-1.5">
        <span className="font-mono text-[9px] tracking-wider text-dim">{clipId(gen.id)}</span>
        <span className={`ml-auto flex items-center gap-1 font-mono text-[8.5px] tracking-wider ${s.cls}`}>
          <span className={`lamp ${s.live ? "lamp-live" : ""}`} style={{ width: 5, height: 5 }} />
          {s.label}
        </span>
      </span>

      <span className="relative block min-h-0 flex-1 bg-desk">
        {done ? (
          <video src={posterSrc(url!)} muted preload="metadata" className="h-full w-full object-cover" />
        ) : (
          <span className={`desk-grid grid h-full place-items-center font-mono text-[9px] tracking-[.16em] ${s.cls}`}>
            {s.label}
          </span>
        )}
      </span>

      <span className="block shrink-0 px-1.5 py-1">
        <span className="line-clamp-2 text-[10.5px] leading-snug text-bone/80">{gen.prompt}</span>
        <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[8.5px] text-mute">
          {(gen.params as { resolution?: string }).resolution?.toUpperCase()}
          {gen.costUsd != null && <span className="text-lift">{usd(gen.costUsd)}</span>}
        </span>
      </span>
    </button>
  );
}
