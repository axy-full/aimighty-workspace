"use client";

/**
 * The wall, grouped by shot — from the pipeline handoff.
 *
 * A render is a TAKE of a shot, and the wall reads that way: one group per
 * shot, its takes as cards, and a state on every card — draft, picked,
 * approved, or rendering. The old wall was a masonry of everything ever
 * made; this one is the production's shot list with the work hung under
 * each line of it. Unfiled renders (no shot) keep a group of their own at
 * the end, because an experiment should not need paperwork to exist.
 *
 * Stills use the same skeleton with a different question on the filter:
 * not what state a take is in but what ROLE a still plays — a first frame
 * pinned to its shot, a cast still standing for a face or a place, or
 * loose. The role is a badge on the well and a row of small actions under
 * the card, so a still can be promoted without opening it.
 *
 * The filter is client-side and instant: it hides takes and drops the
 * groups that empty out, and the counts on the segments are live.
 */
import { useEffect, useMemo, useState } from "react";
import { startGenDrag } from "@/lib/dnd";
import Link from "next/link";
import type { Gen } from "./GenCard";
import LazyMedia from "./LazyMedia";
import { Empty, ParticlSpinner } from "./ParticlMark";
import { appPrompt } from "./dialog";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { shortLabel } from "@/lib/models";
import { downloadHref } from "@/lib/format";
import { useMoney } from "@/lib/price";

/** Kept for the callers that still speak it; the wall itself shows one kind. */
export type FeedFilter = "all" | "video" | "image" | "audio";
export type TakeState = "all" | "draft" | "picked" | "approved";
export type StillRole = "first" | "cast" | "loose";

export const clipId = (id: string) => id.split("_").pop()!.slice(-6).toUpperCase();
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** The tile's shape is the render's shape — a 9:16 stays a portrait. */
export function aspectOf(g: Gen): string {
  const r = String((g.params as { ratio?: string }).ratio ?? "");
  const m = r.match(/^(\d+):(\d+)$/);
  return m ? `${m[1]} / ${m[2]}` : "16 / 9";
}

type Shot = { id: string; code: string; scene: string; title: string; description?: string; takes: number; spend: number };

export function stateOf(g: Gen): "rendering" | "held" | "approved" | "picked" | "draft" | "failed" {
  if (g.status === "queued" || g.status === "running") return "rendering";
  if (g.status === "held") return "held";
  if (g.status === "failed" || g.status === "cancelled") return "failed";
  if (g.reviewState === "approved") return "approved";
  if (g.reviewState === "picked") return "picked";
  return "draft";
}

/** A still's role on the production, as the composer's USE AS row set it. */
export function roleOf(g: Gen): StillRole {
  const r = (g.params as { useAs?: string }).useAs;
  return r === "first" || r === "cast" ? r : "loose";
}

export default function Feed({
  gens, visible, activeId, onOpen, scopeName, projectId, kind, className = "", problem, onChanged,
}: {
  /** Everything in scope — what the counts describe. */
  gens: Gen[];
  /** What the wall shows: the same list through the owner's kind filter,
   *  decided there so the theatre walks exactly these. */
  visible: Gen[];
  activeId: string | null;
  onOpen: (id: string) => void;
  scopeName: string;
  projectId: string;
  kind: "video" | "image";
  /** Set when the library could not be read, so an empty wall isn't mistaken for a new one. */
  problem?: string | null;
  className?: string;
  /** A card changed something on the server (a still's role). */
  onChanged?: () => void;
  /* The kind filter survives in the signature for the Library; the wall
     ignores it, because a wall is one kind by construction. */
  filter?: FeedFilter; setFilter?: (f: FeedFilter) => void; aside?: React.ReactNode;
}) {
  const { signedIn } = useSession();
  const money = useMoney();
  const stills = kind === "image";
  const [take, setTake] = useState<TakeState>("all");
  const [role, setRole] = useState<"all" | StillRole>("all");
  const [q, setQ] = useState("");

  const scoped = projectId !== "all" && projectId !== "unfiled";
  const { data: shotData } = useApi<{ shots: Shot[] }>(
    scoped ? `/api/shots?projectId=${encodeURIComponent(projectId)}` : null, 30_000);
  const shots = useMemo(() => shotData?.shots ?? [], [shotData]);

  // One clock for every card in flight.
  const anyLive = gens.some((g) => g.status === "queued" || g.status === "running");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyLive]);

  const counts = useMemo(() => {
    const c = { all: visible.length, draft: 0, picked: 0, approved: 0, first: 0, cast: 0, loose: 0 };
    for (const g of visible) {
      const s = stateOf(g);
      if (s === "approved") c.approved++;
      else if (s === "picked") c.picked++;
      else if (s === "draft" || s === "rendering" || s === "held") c.draft++;
      c[roleOf(g)]++;
    }
    return c;
  }, [visible]);

  /* Group by shot, in shot order; unfiled last. A search narrows by prompt,
     title, shot code or an @name. */
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const keep = (g: Gen) => {
      if (stills) {
        if (role !== "all" && roleOf(g) !== role) return false;
      } else if (take !== "all") {
        const s = stateOf(g);
        if (take === "draft" ? !(s === "draft" || s === "rendering" || s === "held") : s !== take) return false;
      }
      if (!needle) return true;
      return [g.prompt, g.title ?? "", g.shotCode ?? ""].join(" ").toLowerCase().includes(needle);
    };
    const byShot = new Map<string, Gen[]>();
    const loose: Gen[] = [];
    for (const g of visible) {
      if (!keep(g)) continue;
      const key = g.shotCode ?? "";
      if (!key) { loose.push(g); continue; }
      (byShot.get(key) ?? byShot.set(key, []).get(key)!).push(g);
    }
    const spendOf = (list: Gen[]) => money.sum(list);
    const order = new Map(shots.map((s, i) => [s.code, i]));
    const out = [...byShot.entries()]
      .sort((a, b) => (order.get(a[0]) ?? 1e9) - (order.get(b[0]) ?? 1e9) || a[0].localeCompare(b[0]))
      .map(([code, list]) => {
        const shot = shots.find((s) => s.code === code);
        const takes = list.slice().sort((a, b) => (a.version ?? 0) - (b.version ?? 0));
        return {
          key: code, code, title: shot?.title || shot?.description?.slice(0, 80) || "", shotId: shot?.id ?? null, takes,
          meta: `${list.length} ${stills ? "still" : "take"}${list.length === 1 ? "" : "s"} · ${spendOf(list)}`,
        };
      });
    if (loose.length) {
      out.push({
        key: "__unfiled", code: "UNFILED", title: "Not filed against a shot", shotId: null,
        takes: loose, meta: `${loose.length} render${loose.length === 1 ? "" : "s"} · ${spendOf(loose)}`,
      });
    }
    return out;
  }, [money, visible, shots, take, role, q, stills]);

  const noun = stills ? "STILLS" : "TAKES";
  const shotCount = scoped ? shots.length : new Set(visible.map((g) => g.shotCode).filter(Boolean)).size;
  const filterWord = stills ? (role === "all" ? "" : role === "first" ? "first frames" : role === "cast" ? "cast stills" : "loose") : take;

  return (
    <section className={`ws-main ${className}`}>
      <div className="ws-bar">
        <div className="ws-bar-title">
          <span className="ws-bar-h">Takes</span>
          <span className="mono-s">{visible.length} {noun} · {shotCount} SHOTS</span>
          {stills ? (
            <Link href="/studio" className="hdr-mono-link ml-1.5">CAST →</Link>
          ) : (
            <>
              {scoped && <Link href={`/projects/${encodeURIComponent(projectId)}/canvas`} className="hdr-mono-link ml-1.5">CANVAS →</Link>}
              <Link href="/all" className="hdr-mono-link">ALL TAKES →</Link>
            </>
          )}
        </div>
        <div className="seg ml-2" role="tablist">
          {stills ? (
            ([["all", "All"], ["first", "First frames"], ["cast", "Cast stills"], ["loose", "Loose"]] as const).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={role === k} onClick={() => setRole(k)}
                className={`seg-opt ${role === k ? "is-on" : ""}`}>
                {label}<span className="seg-n">{counts[k]}</span>
              </button>
            ))
          ) : (
            ([["all", "All"], ["draft", "Draft"], ["picked", "Picked"], ["approved", "Approved"]] as const).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={take === k} onClick={() => setTake(k)}
                className={`seg-opt ${take === k ? "is-on" : ""}`}>
                {label}<span className="seg-n">{counts[k]}</span>
              </button>
            ))
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="chip-dd is-muted" title="Grouped by the shot they file against">Group by shot <span className="hdr-caret">▼</span></span>
          <label className="search w-[200px]">
            <span className="search-glyph" aria-hidden>⌕</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search takes, @cast…" />
          </label>
        </div>
      </div>

      <div className="ws-scroll">
        {gens.length === 0 && problem ? (
          <Empty title="The takes didn't load"
            line={`${problem} Anything rendering carries on; this wall fills in as soon as the connection does.`} />
        ) : gens.length === 0 ? (
          <Empty
            title={signedIn ? (stills ? "Your first still goes here" : "Your first shot goes here") : "The takes are private"}
            line={signedIn
              ? "Describe it in the composer. The cost sits on the button before you press it, and every take lands under its shot as it finishes."
              : "This is where the studio's takes sit, under the shots they belong to. The composer is the real one — sign in and the cost appears on the button before you press it."}
          />
        ) : groups.length === 0 ? (
          <Empty compact title={q ? `Nothing matching “${q}”` : `Nothing ${filterWord} yet`} />
        ) : groups.map((g) => (
          <div key={g.key} className="flex flex-col gap-2.5">
            <div className="grp-head">
              <span className="grp-id">{g.code}</span>
              {g.title && <span className="grp-title">{g.title}</span>}
              <span className="grp-meta">{g.meta}</span>
              <span className="grp-rule" />
              {g.shotId && scoped && (
                <Link href={`/projects/${encodeURIComponent(projectId)}/canvas?shot=${encodeURIComponent(g.shotId)}`}
                  className="hdr-mono-link">OPEN SHOT →</Link>
              )}
            </div>
            <div className={`grp-grid ${stills ? "is-stills" : ""}`}>
              {g.takes.map((t) => (
                <Take key={t.id} gen={t} code={g.code} active={t.id === activeId} now={now}
                  onOpen={() => onOpen(t.id)} onChanged={onChanged} />
              ))}
            </div>
          </div>
        ))}
        <span className="sr-only">{scopeName}</span>
      </div>
    </section>
  );
}

/**
 * One take. Its state is a dot and a word; its cost rides the right edge.
 * A still carries its role as a badge and a row of three small actions —
 * First frame, To cast, download — under the body. `badge` (the Library)
 * names the production in the top-left corner.
 */
export function Take({ gen, code, active, now, onOpen, onChanged, badge }: {
  gen: Gen; code: string; active: boolean; now: number; onOpen: () => void;
  onChanged?: () => void; badge?: string;
}) {
  const money = useMoney();
  const url = gen.storedUrl ?? gen.sourceUrl;
  const done = gen.status === "succeeded" && Boolean(url);
  const s = stateOf(gen);
  const still = gen.kind === "image";
  const audio = gen.kind === "audio";
  const p = gen.params as { duration?: number; resolution?: string; castName?: string };
  const elapsed = Math.max(0, Math.floor((now - gen.createdAt) / 1000));
  const v = still ? `S${gen.version ?? 1}` : gen.kind === "audio" ? "A" : `v${gen.version ?? 1}`;
  const dur = still ? String(p.resolution ?? "").toUpperCase() : p.duration != null ? mmss(p.duration) : "";
  const word = s === "rendering" ? (gen.status === "queued" ? "Queued" : "Rendering")
    : s === "failed" ? (gen.status === "cancelled" ? "Cancelled" : "Failed")
      : s[0].toUpperCase() + s.slice(1);
  const by = gen.authorName ?? (gen as Gen & { createdByName?: string }).createdByName;
  const role = still ? roleOf(gen) : null;

  async function setRole(useAs: StillRole, castName?: string | null) {
    await fetch(`/api/jobs/${gen.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useAs, castName: castName ?? null }),
    });
    onChanged?.();
  }
  async function toCast() {
    if (role === "cast") { await setRole("loose"); return; }
    const name = await appPrompt("Who or what does this still stand for?", p.castName ?? "", "Cass");
    if (name === null) return;
    await setRole("cast", name.replace(/^@/, "").trim() || null);
  }

  return (
    <div
      data-gen-id={gen.id} data-gen-prompt={gen.prompt} data-gen-label={gen.title || clipId(gen.id)}
      data-gen-title={gen.title ?? ""}
      draggable={done} onDragStart={(e) => startGenDrag(e, gen)}
      className={`take ${s === "approved" ? "is-approved" : ""} ${active ? "is-selected" : ""}`}>
      <button type="button" onClick={onOpen} className="take-hit"
        title={gen.title ? `${gen.title} — ${gen.prompt}` : gen.prompt}>
        <span className="well take-well" style={{ aspectRatio: still ? aspectOf(gen) : "16 / 9" }}>
          {done && !audio ? (
            <LazyMedia url={url!} kind={still ? "image" : "video"} hoverPlay alt={gen.prompt.slice(0, 120)} className="!absolute inset-0" />
          ) : s === "rendering" ? (
            <span className="flex flex-col items-center gap-2">
              <ParticlSpinner size={22} className="text-dim" />
            </span>
          ) : s === "held" ? (
            <span className="well-cap is-held">held · top up to release</span>
          ) : (
            <span className="well-cap">{s === "failed" ? word.toLowerCase() : `render · ${code} · ${v}`}</span>
          )}
          <span className="well-badge tl">{badge ? badge.toUpperCase() : v}</span>
          {badge && <span className="well-badge tl" style={{ left: "auto", right: 8 }}>{code} {v}</span>}
          {role === "first" && !badge && <span className="well-badge tr is-ink">FIRST FRAME</span>}
          {role === "cast" && !badge && <span className="well-badge tr is-line">@{(p.castName || "CAST").toUpperCase()}</span>}
          {dur && !(badge && role) && <span className="well-badge br">{dur}</span>}
          {s === "rendering" && (
            <>
              <span className="take-rendering">{word.toUpperCase()} · {mmss(elapsed)}</span>
              <span className="take-bar"><span style={{ width: gen.status === "queued" ? "8%" : "62%" }} /></span>
            </>
          )}
        </span>
        <span className="take-body">
          <span className="take-state">
            <span className="take-word">
              {s === "approved" && <span className="dot dot-approved" />}
              {s === "picked" && <span className="dot dot-picked" />}
              {(s === "draft" || s === "rendering") && <span className="dot dot-draft" />}
              {s === "held" && <span className="dot dot-held" />}
              {s === "failed" && <span className="dot dot-none" />}
              {badge ? `${code} ${v} · ${word.toLowerCase()}` : word}
            </span>
            <span className="mono-v">{gen.costUsd != null ? money.take(gen) : "—"}</span>
          </span>
          <span className="take-meta">
            <span>{shortLabel(gen.model)}{p.resolution ? ` · ${String(p.resolution).toUpperCase()}` : ""}{!still && dur ? ` · ${dur}` : ""}</span>
            <span>{by ? `by ${by}` : gen.title ? gen.title : ""}</span>
          </span>
        </span>
      </button>
      {s === "held" && <HeldActions gen={gen} onChanged={onChanged} />}
      {still && done && (
        <div className="take-acts">
          <button type="button" className={`trk-btn ${role === "first" ? "is-on" : ""}`} onClick={() => setRole(role === "first" ? "loose" : "first")}
            title={role === "first" ? "Pinned to its shot as the first frame — click to unpin" : "Pin to its shot as the first frame"}>First frame</button>
          <button type="button" className={`trk-btn ${role === "cast" ? "is-on" : ""}`} onClick={toCast}
            title={role === "cast" ? "A cast still — click to make it loose" : "Make this a cast still"}>To cast</button>
          <a href={downloadHref(url!)} download className="trk-btn is-icon" title="Download" aria-label="Download" onClick={(e) => e.stopPropagation()}>↓</a>
        </div>
      )}
    </div>
  );
}

/** A held take: what it needs, and the way out — release when the balance covers it, top up when it doesn't. */
export function HeldActions({ gen, onChanged }: { gen: Gen; onChanged?: () => void }) {
  const { credits } = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needs = Number((gen.params as { held?: { needs?: number } }).held?.needs ?? 0);
  const balance = credits?.balance ?? null;
  // The server decides who may release; here only whether the balance covers it.
  const covered = balance == null || balance >= needs;
  async function release() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/jobs/${gen.id}/release`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not release it");
      onChanged?.();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div className="take-acts take-held">
      <span className="text-[12.5px] text-mute">Needs {needs} cr{balance != null ? ` · ${Math.max(0, Math.floor(balance))} left` : ""}</span>
      {covered
        ? <button type="button" className="btn-secondary !py-1 !text-[12.5px]" disabled={busy} onClick={release}>{busy ? "Releasing…" : "Release"}</button>
        : <Link href="/settings" className="btn-secondary !py-1 !text-[12.5px]">Top up</Link>}
      {err && <span className="text-[12px] text-lift">{err}</span>}
    </div>
  );
}
