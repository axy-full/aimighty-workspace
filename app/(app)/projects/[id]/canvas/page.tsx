"use client";

/**
 * Canvas — the sequence on a wall, in order, next to the references it came
 * from. From the pipeline handoff.
 *
 * Three rows, one column per shot: REFS (the stills pinned to the shot),
 * WALL (the shot's best take — approved, else picked, else the latest — as
 * a tile with its state), TIME (a bar whose segments are the shots' planned
 * seconds, coloured by state). Only approved takes play in the sequence; a
 * picked take holds its slot and shows as a still; an open shot shows as a
 * gap the length of its planned duration.
 *
 * Planned seconds are the take's duration where there is one, and the
 * composer's default where there is not yet — the shot list gives every
 * shot a length before anything is rendered, so a gap is never zero wide.
 *
 * The rail is the selected shot: its preview, its facts, who is in it, and
 * what has happened to it, with the one action that moves it forward.
 */
import Link from "next/link";
import { isAssetDrag, readDraggedAsset } from "@/lib/dnd";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useOnChange } from "@/lib/changes";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { usePageTitle } from "@/lib/usePageTitle";
import { timeAgo, downloadHref } from "@/lib/format";
import LazyMedia from "@/components/LazyMedia";
import ProductionNav from "@/components/ProductionNav";
import { Empty, Waiting } from "@/components/ParticlMark";
import { stateOf, roleOf } from "@/components/Feed";
import type { Gen } from "@/components/GenCard";
import type { Shot } from "@/lib/shots";
import { useMoney } from "@/lib/price";

type ShotRow = Shot & { takes: number; ok: number; failed: number; spend: number };
type ShotState = "approved" | "picked" | "draft" | "empty";
type Col = {
  shot: ShotRow; takes: Gen[]; hero: Gen | null; state: ShotState; secs: number;
  refs: Gen[]; cast: string[]; spend: number; mine: Gen[];
};

const DEFAULT_SECS = 5;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "production";
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

export default function CanvasPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const search = useSearchParams();
  const { signedIn } = useSession();
  const { projects, selection, setSelection } = useProject();
  const money = useMoney();
  const project = projects.find((p) => p.id === id) ?? null;
  usePageTitle(project ? `${project.name} · Canvas` : "Canvas");

  // The header's switcher follows the production the page is about.
  useEffect(() => {
    if (selection !== id) Promise.resolve().then(() => setSelection(id));
  }, [id, selection, setSelection]);

  const { data: shotData, refresh: refreshShots } = useApi<{ shots: ShotRow[] }>(signedIn ? `/api/shots?projectId=${encodeURIComponent(id)}` : null, 30_000);
  const { data: jobs, refresh } = useApi<{ generations: Gen[] }>(signedIn ? `/api/jobs?projectId=${encodeURIComponent(id)}&limit=500&sync=0` : null, 8_000);
  useOnChange(() => { refresh(); refreshShots(); });

  const cols = useMemo<Col[]>(() => {
    const shots = shotData?.shots ?? [];
    const gens = jobs?.generations ?? [];
    return shots.map((shot) => {
      const mine = gens.filter((g) => g.shotCode === shot.code);
      const takes = mine.filter((g) => g.kind !== "image" && g.kind !== "audio").sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
      const byState = (s: ReturnType<typeof stateOf>) => takes.find((g) => stateOf(g) === s) ?? null;
      const hero = byState("approved") ?? byState("picked") ?? takes.find((g) => g.status === "succeeded" && (g.storedUrl || g.sourceUrl)) ?? null;
      const state: ShotState = byState("approved") ? "approved" : byState("picked") ? "picked" : takes.length ? "draft" : "empty";
      const secs = Number((hero?.params as { duration?: number } | undefined)?.duration
        ?? (takes[0]?.params as { duration?: number } | undefined)?.duration ?? DEFAULT_SECS) || DEFAULT_SECS;
      const refs = mine.filter((g) => g.kind === "image" && g.status === "succeeded" && roleOf(g) !== "loose");
      const cast = [...new Set([...(shot.cast ?? []), ...mine.flatMap((g) => ((g.params as { cast?: string[] }).cast ?? []))])];
      return { shot, takes, hero, state, secs, refs, cast, spend: mine.reduce((a, g) => a + (g.costUsd ?? 0) + (g.refineCostUsd ?? 0), 0), mine };
    });
  }, [shotData, jobs]);

  const [sel, setSel] = useState<string | null>(null);
  const wanted = search.get("shot");
  const cur = cols.find((c) => c.shot.id === (sel ?? wanted)) ?? cols[0] ?? null;

  const total = cols.reduce((a, c) => a + c.secs, 0);
  const done = cols.filter((c) => c.state === "approved").reduce((a, c) => a + c.secs, 0);
  const n = (s: ShotState) => cols.filter((c) => c.state === s).length;
  /* An approved take with no file is not something you can play. `hero` is
     chosen by state and only its last fallback requires a url, so without
     this filter ▶ Play approved sets seq to a take with nothing to show,
     the `ended` event that advances the sequence never fires, and the run
     can neither continue nor be understood as stopped. Same root as the
     download link's crash: approved is a judgement, not a promise of bytes. */
  const approvedHeroes = cols
    .filter((c) => c.state === "approved" && c.hero && (c.hero.storedUrl ?? c.hero.sourceUrl))
    .map((c) => c.hero!);

  /* ▶ Play approved: the approved takes, in order, in the rail's preview. */
  const [seq, setSeq] = useState<number | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const playing = seq != null ? approvedHeroes[seq] ?? null : null;
  useEffect(() => {
    if (!playing || !video.current) return;
    video.current.load();
    video.current.play().catch(() => setSeq(null));
  }, [playing]);

  function downloadAll() {
    approvedHeroes.forEach((g, i) => {
      const url = g.storedUrl ?? g.sourceUrl;
      if (!url) return;
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = downloadHref(url); a.download = ""; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
      }, i * 400);
    });
  }

  async function approve(g: Gen) {
    await fetch(`/api/jobs/${g.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewState: "approved" }) });
    refresh(); refreshShots();
  }

  const slugName = slug(project?.code || project?.name || "production");
  const preview = playing ?? cur?.hero ?? null;
  const previewUrl = preview ? (preview.storedUrl ?? preview.sourceUrl) : null;
  /* The hero's own file, which may not exist. `hero` is picked by STATE —
     approved, then picked — and only the last fallback requires a url, so an
     approved take whose master is gone yields a hero with nothing to play or
     download. The download link asserted that away with a `!` and took the
     whole screen down with "Cannot read properties of null". */
  const heroUrl = cur?.hero ? (cur.hero.storedUrl ?? cur.hero.sourceUrl) : null;

  return (
    <>
      <ProductionNav id={id} on="canvas" />

      <div className="cv">
        <section className="cv-main">
          <div className="cv-head">
            <span className="cv-h">{project?.name ?? "Canvas"}</span>
            <span className="mono-s">
              {cols.length} SHOTS · {mmss(done)} OF {mmss(total)} · {n("approved")} APPROVED · {n("picked")} PICKED · {n("draft") + n("empty")} OPEN
            </span>
            <div className="ml-auto flex gap-2">
              <button type="button" className="btn-secondary" disabled={!approvedHeroes.length}
                onClick={() => setSeq(seq == null ? 0 : null)}>
                {seq == null ? "▶ Play approved" : "■ Stop"}
              </button>
              <button type="button" className="btn-secondary" disabled={!approvedHeroes.length} onClick={downloadAll}>
                Download {approvedHeroes.length} master{approvedHeroes.length === 1 ? "" : "s"} ↓
              </button>
            </div>
          </div>

          <div className="cv-body">
            {!signedIn ? (
              <Empty title="The canvas is for the team" line="Sign in to see this production's shots in order, with the references they came from." />
            ) : !shotData || !jobs ? (
              <Waiting label="Laying out the canvas" />
            ) : cols.length === 0 ? (
              <Empty title="No shots yet" line="Add shots on the Shots tab, or bring a shot list across from Atomik. Every take then hangs under its shot here, in order." />
            ) : (
              <>
                <div className="cv-row">
                  <span className="cv-lbl">REFS</span>
                  <div className="cv-grid" style={{ "--n": cols.length } as React.CSSProperties}>
                    {cols.map((c) => (
                      <div key={c.shot.id} className="cv-refs">
                        {c.refs.slice(0, 2).map((r) => (
                          <div key={r.id} className="cv-ref" title={r.prompt}>
                            <LazyMedia url={(r.storedUrl ?? r.sourceUrl) ?? ""} kind="image" alt="" />
                          </div>
                        ))}
                        {c.refs.length === 0 && <div className="cv-ref">{c.shot.scene ? c.shot.scene : "no refs"}</div>}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="cv-row">
                  <span className="cv-lbl">TAKES</span>
                  <div className="cv-grid" style={{ "--n": cols.length } as React.CSSProperties}>
                    {cols.map((c) => {
                      const on = cur?.shot.id === c.shot.id;
                      const url = c.hero ? (c.hero.storedUrl ?? c.hero.sourceUrl) : null;
                      return (
                        <button key={c.shot.id} type="button" onClick={() => setSel(c.shot.id)}
                          className={`cv-tile ${c.state === "empty" ? "is-empty" : ""} ${c.state === "approved" ? "is-approved" : ""} ${on ? "is-on" : ""}`}
                          title={c.shot.title || c.shot.description || c.shot.code}
                          onDragOver={(e) => { if (isAssetDrag(e)) { e.preventDefault(); e.currentTarget.classList.add("is-drop"); } }}
                          onDragLeave={(e) => e.currentTarget.classList.remove("is-drop")}
                          onDrop={async (e) => {
                            /* A render dropped on a shot is filed as its next take. */
                            e.currentTarget.classList.remove("is-drop");
                            const a = readDraggedAsset(e);
                            if (!a || a.gen.kind === "audio") return;
                            e.preventDefault();
                            await fetch(`/api/jobs/${encodeURIComponent(a.gen.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shotId: c.shot.id }) });
                            refresh(); refreshShots();
                          }}>
                          <span className="cv-tile-well">
                            {url && c.hero ? <LazyMedia url={url} kind="video" alt="" className="media" /> : null}
                            {!url && (c.state === "empty" ? "no take" : c.hero ? `v${c.hero.version ?? 1}` : "rendering")}
                          </span>
                          <span className="cv-tile-foot">
                            <span className="cv-tile-id">
                              {c.shot.code}
                              <span className={`dot dot-sm ${c.state === "approved" ? "dot-approved" : c.state === "picked" ? "dot-picked" : c.state === "draft" ? "dot-draft" : "dot-none"}`} />
                            </span>
                            <span className="cv-tile-dur">{mmss(c.secs)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="cv-row">
                  <span className="cv-lbl">TIME</span>
                  <div className="cv-time">
                    <div className="cv-bar">
                      {cols.map((c) => <span key={c.shot.id} className={`is-${c.state}`} style={{ flex: c.secs }} />)}
                    </div>
                    <div className="cv-ticks">
                      {[0, 1, 2, 3].map((i) => <span key={i}>{mmss(Math.round((total * i) / 3))}</span>)}
                    </div>
                  </div>
                </div>
                <p className="cv-note">
                  Only approved takes play in the canvas. A picked take holds its slot and shows as a still; an open shot shows as a gap the length of its planned duration. References come from the Atomik breakdown and stay pinned to their shot.
                </p>
              </>
            )}
          </div>
        </section>

        <aside className="cv-rail">
          <div className="cv-rail-head">
            <span className="mono-v text-dim">{cur?.shot.code ?? "—"}</span>
            <span className="cv-rail-title">{cur ? (cur.shot.title || cur.shot.description || "Untitled shot") : "No shot selected"}</span>
          </div>
          <div className="ws-rail-body">
            <div className="cv-preview">
              {previewUrl && preview ? (
                preview.kind === "image"
                  ? <LazyMedia url={previewUrl} kind="image" alt="" className="media" />
                  : <video ref={video} src={previewUrl} controls playsInline preload="metadata"
                      onEnded={() => setSeq((i) => (i != null && i + 1 < approvedHeroes.length ? i + 1 : null))} />
              ) : cur ? `no render yet · ${cur.shot.code}` : "—"}
            </div>
            {playing && cur && (
              <span className="mono-s text-center">PLAYING APPROVED · {seq! + 1} OF {approvedHeroes.length} · {playing.shotCode}</span>
            )}
            <div className="kv">
              <div className="kv-row"><span>State</span><span>{cur ? (cur.state === "empty" ? "No take yet" : `${cur.state[0].toUpperCase()}${cur.state.slice(1)}${cur.hero ? ` · v${cur.hero.version ?? 1}` : ""}`) : "—"}</span></div>
              <div className="kv-row"><span>Planned</span><span>{cur ? mmss(cur.secs) : "—"}</span></div>
              <div className="kv-row"><span>Takes</span><span>{cur?.takes.length || "—"}</span></div>
              <div className="kv-row"><span>Cost so far</span><span className="mono-v">{cur?.takes.length ? money.sum(cur.mine) : "—"}</span></div>
            </div>
            {cur && cur.refs.length > 0 && (
              <div className="rail-sec cv-refs-mobile">
                <span className="mono">Refs</span>
                <div className="flex gap-2">
                  {cur.refs.slice(0, 4).map((r) => (
                    <span key={r.id} className="cv-ref !w-16 !flex-none"><LazyMedia url={(r.storedUrl ?? r.sourceUrl) ?? ""} kind="image" alt="" /></span>
                  ))}
                </div>
              </div>
            )}
            <div className="rail-sec">
              <span className="mono">Cast in this shot</span>
              <div className="flex flex-wrap gap-[5px]">
                {cur?.cast.map((c) => <span key={c} className="cv-chip">@{c}</span>)}
                {(!cur || cur.cast.length === 0) && <span className="rail-help">No one cited yet — write @name in a prompt.</span>}
              </div>
            </div>
            <div className="rail-sec">
              <span className="mono">History</span>
              <div>
                {cur && cur.takes.length > 0 ? cur.takes.map((g) => {
                  const s = stateOf(g);
                  const who = g.authorName ? initials(g.authorName) : "—";
                  const rv = (g as Gen & { reviewedAt?: number }).reviewedAt ?? g.createdAt;
                  return (
                    <div key={g.id}>
                      {(s === "approved" || s === "picked") && (
                        <div className="cv-hist"><span>{timeAgo(rv)}</span><span>{g.reviewBy ? initials(g.reviewBy) : who} {s} v{g.version ?? 1}</span></div>
                      )}
                      <div className="cv-hist">
                        <span>{s === "rendering" ? "now" : timeAgo(g.createdAt)}</span>
                        <span>{who} {s === "rendering" ? `rendering v${g.version ?? 1}` : s === "failed" ? `failed on v${g.version ?? 1}` : `rendered v${g.version ?? 1}`}</span>
                      </div>
                    </div>
                  );
                }) : <div className="cv-hist"><span>—</span><span>No take yet</span></div>}
              </div>
            </div>
          </div>
          <div className="ws-rail-foot">
            <div className="cv-foot-acts">
              <Link href="/" className="btn-secondary justify-center" onClick={() => setSelection(id)}>Open takes</Link>
              {cur?.state === "approved" && heroUrl ? (
                <a href={downloadHref(heroUrl)} download className="btn-primary justify-center">Download master ↓</a>
              ) : cur?.state === "picked" && cur.hero ? (
                <button type="button" className="btn-primary justify-center" onClick={() => approve(cur.hero!)}>Approve take</button>
              ) : cur?.state === "draft" ? (
                <Link href="/" className="btn-primary justify-center" onClick={() => setSelection(id)}>Pick a take</Link>
              ) : (
                <Link href="/" className="btn-primary justify-center" onClick={() => setSelection(id)}>Compose in Video</Link>
              )}
            </div>
            <span className="mono-s text-center">
              {cur?.hero
                ? `${slugName}_${cur.shot.code.toLowerCase()}_v${cur.hero.version ?? 1}_${String((cur.hero.params as { resolution?: string }).resolution ?? "").toLowerCase() || "master"}.mp4`
                : cur ? `${slugName}_${cur.shot.code.toLowerCase()} · nothing filed yet` : ""}
            </span>
          </div>
        </aside>
      </div>
    </>
  );
}
