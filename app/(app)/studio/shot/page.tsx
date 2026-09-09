"use client";

/**
 * Studio · Camera & shot builder — from the pipeline handoff.
 *
 * Two ways into the same twelve choices. THE CAMERA is the bank: every move
 * and technique as a tile, with how many takes have used it, because the
 * ones that get used are the ones that work. THE SHOT is the twelve rows —
 * size, angle, move, lens, light, hour, look, technique, mood, motion,
 * sound, titles — one pick each; re-clicking clears (Titles can't be
 * cleared: subtitles are the one thing the engine reliably takes a NO for).
 *
 * The rail is the prompt, assembling itself on every pick, with the twelve
 * rows summarised under it. Nothing is rendered here: Take it to Video
 * hands the subject line, the setup and the shot to the composer, which
 * keeps the model, the duration and the references.
 */
import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { appAlert } from "@/components/dialog";
import { liftLocalSetup } from "@/lib/setupLocal";
import PaneDivider from "@/components/PaneDivider";
import { PANES, usePaneWidth } from "@/lib/panes";
import { useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { matchesStudio, orderByUse, CATEGORIES, specToPhrase, specCount, type ShotSpec } from "@/lib/studio";
import { Waiting } from "@/components/ParticlMark";
import { useDraft, peekDraft } from "@/lib/useDraft";
import { usePageTitle } from "@/lib/usePageTitle";
import type { Gen } from "@/components/GenCard";
import type { Shot } from "@/lib/shots";
import LazyMedia from "@/components/LazyMedia";

type ShotRow = Shot & { takes: number };
/* Helpers for the rows whose category carries none. */
const HELP: Record<string, string> = {
  mood: "The feeling the frame should carry — one word the engine can act on.",
  pace: "Real time, slow motion, a ramp, a timelapse. The clock the shot runs on.",
  sound: "What the engine generates for sound when Audio is on. Tracks replace or layer it, per take.",
};

export default function ShotBuilderPage() {
  return <Suspense fallback={<Waiting label="Opening the shot builder" />}><ShotBuilder /></Suspense>;
}

function ShotBuilder() {
  usePageTitle("Studio · Setup");
  const router = useRouter();
  const search = useSearchParams();
  const { signedIn, workspace, setup: platformSetup } = useSession();
  const { selection: bin, current } = useProject();
  const scoped = bin !== "all" && bin !== "unfiled";
  const { data: shotData } = useApi<{ shots: ShotRow[] }>(signedIn && scoped ? `/api/shots?projectId=${encodeURIComponent(bin)}` : null, 30_000);
  const { data: recent } = useApi<{ generations: Gen[] }>(signedIn ? `/api/jobs?limit=200&sync=0${scoped ? `&projectId=${encodeURIComponent(bin)}` : ""}` : null, 0);

  /* Both halves of the builder are drafts: the picks and the subject line
     come back after a detour to the wall, and go when they are taken to Video. */
  const specDraft = useDraft<ShotSpec>(`studio-spec:${bin}`, {});
  const proseDraft = useDraft(`studio-prose:${bin}`, "");
  const spec = specDraft.value, setSpec = specDraft.set;
  const prose = proseDraft.value, setProse = proseDraft.set;
  const [saved, setSaved] = useState(false);
  const shotId = search.get("shot");
  const shot = shotData?.shots.find((s) => s.id === shotId) ?? null;

  /* The saved Setup for this scope, from the server. It used to be read out
     of this browser, which is why a production's Setup was only ever known to
     whoever last saved it. */
  const { data: setupData, refresh: refreshSetup } =
    useApi<{ workspace: ShotSpec; production: ShotSpec }>(
      signedIn ? `/api/setup?projectId=${encodeURIComponent(bin)}` : null, 0);
  const savedSpec = useMemo(
    () => (scoped ? setupData?.production : setupData?.workspace) ?? null,
    [setupData, scoped],
  );

  /* Whatever this browser still holds is lifted up once, into a scope the
     server has nothing for — so nobody loses the Setup they already had.
     Guarded by a ref rather than by the outcome: `setupData` is a new object
     on every fetch and this effect can ask for another one, which without the
     guard is a fetch loop. */
  const [railW] = usePaneWidth(PANES.builder);
  const lifted = useRef<string | null>(null);
  useEffect(() => {
    if (!setupData || lifted.current === bin) return;
    lifted.current = bin;
    void liftLocalSetup(bin, setupData).then((moved) => { if (moved) refreshSetup(); });
  }, [bin, setupData, refreshSetup]);

  // The saved setup opens the builder already set — unless there is
  // unfinished work here, which wins over the saved starting point.
  useEffect(() => {
    if (!savedSpec || !Object.keys(savedSpec).length) return;
    if (peekDraft<ShotSpec>(workspace?.id, `studio-spec:${bin}`)) return;
    Promise.resolve().then(() => setSpec(savedSpec));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bin, workspace?.id, savedSpec]);

  /* Which renders used each move or technique — the bank's usage line. */
  /* What this production has used, what the workspace has used, and the
     last take that used each pick — for the order of the bank and the rows,
     and for a used move's tile (brief 1.4). */
  const { data: recentWs } = useApi<{ generations: Gen[] }>(signedIn && scoped ? "/api/jobs?limit=200&sync=0" : null, 0);
  const { usedProd, usedWs, lastTake } = useMemo(() => {
    const count = (gens: Gen[] | undefined) => {
      const map = new Map<string, number>();
      for (const g of gens ?? []) {
        const sp = (g.params as { shotSpec?: ShotSpec }).shotSpec ?? {};
        for (const [k, v] of Object.entries(sp)) if (v) map.set(`${k}:${v}`, (map.get(`${k}:${v}`) ?? 0) + 1);
      }
      return map;
    };
    const last = new Map<string, Gen>();
    for (const g of [...(recent?.generations ?? []), ...(recentWs?.generations ?? [])]) {
      if (!g.storedUrl || g.kind !== "video") continue;
      const sp = (g.params as { shotSpec?: ShotSpec }).shotSpec ?? {};
      for (const [k, v] of Object.entries(sp)) if (v && !last.has(`${k}:${v}`)) last.set(`${k}:${v}`, g);
    }
    return { usedProd: scoped ? count(recent?.generations) : new Map<string, number>(), usedWs: count(scoped ? recentWs?.generations : recent?.generations), lastTake: last };
  }, [recent, recentWs, scoped]);
  const [query, setQuery] = useState("");
  const { data: previewData } = useApi<{ previews: Record<string, string> }>(signedIn ? "/api/platform/previews" : null, 0);
  /* A production with no setup saved yet starts from the platform's defaults, not from nothing. */
  useEffect(() => {
    if (!signedIn || !platformSetup || specCount(spec) > 0) return;
    // Wait for the answer before falling back: `undefined` is "still asking",
    // and treating it as "nothing saved" would stamp the platform's defaults
    // over a Setup that was about to arrive.
    if (!setupData) return;
    if (!savedSpec || !Object.keys(savedSpec).length) setSpec({ ...platformSetup });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bin, platformSetup, signedIn, setupData, savedSpec]);

  const toggle = (cat: string, value: string) =>
    setSpec((s) => ({ ...s, [cat]: s[cat] === value && cat !== "titles" ? "" : value }));
  const n = specCount(spec);
  const phrase = specToPhrase(spec);
  const labelOf = (key: string) => {
    const cat = CATEGORIES.find((c) => c.key === key);
    return cat?.options.find((o) => o.value === spec[key])?.label ?? null;
  };

  function takeToVideo() {
    try {
      if (prose.trim()) window.localStorage.setItem("aw_compose_seed", prose.trim());
      window.localStorage.setItem("aw_compose_spec", JSON.stringify(spec));
      if (shot) window.localStorage.setItem("aw_compose_shot", shot.id);
      else window.localStorage.removeItem("aw_compose_shot");
    } catch { /* private mode — the composer just opens empty */ }
    proseDraft.clear(); specDraft.clear();
    router.push("/");
  }
  /* Saving a Setup is now something the whole team gets, not something this
     browser remembers. `aw_last_spec` stays local on purpose — that one is
     the composer's own "what I used last", a personal convenience, not a
     shared decision. */
  async function saveSetup() {
    try { window.localStorage.setItem("aw_last_spec", JSON.stringify(spec)); } catch { /* private mode */ }
    try {
      const res = await fetch("/api/setup", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: scoped ? bin : "workspace", spec }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}.`);
      refreshSetup();
      setSaved(true); setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      await appAlert("Not saved", (e as Error).message);
    }
  }

  const bankAll = (["move", "technique"] as const).flatMap((key) => {
    const cat = CATEGORIES.find((c) => c.key === key)!;
    return cat.options.map((o) => ({
      key, value: o.value, label: o.label, title: o.module || o.phrase, option: o,
      n: (scoped ? usedProd : usedWs).get(`${key}:${o.value}`) ?? 0, last: lastTake.get(`${key}:${o.value}`) ?? null,
    }));
  });
  const bank = orderByUse(bankAll.filter((m) => matchesStudio(m.option, query)), (m) => `${m.key}:${m.value}`, usedProd, usedWs);
  const rows = CATEGORIES.map((c) => ({
    ...c, options: orderByUse(c.options.filter((o) => matchesStudio(o, query)), (o) => `${c.key}:${o.value}`, usedProd, usedWs),
  })).filter((c) => !query || c.options.length);
  const setupName = scoped ? current?.name ?? "this production" : "workspace";

  return (
    <>
      <nav className="subnav !px-6" aria-label="Studio">
        <Link href="/studio" className="subnav-item">Cast</Link>
        <span className="subnav-item is-on" aria-current="page">Setup</span>
        <span className="subnav-note">
          {shot
            ? <>Building for <span className="text-ink">{shot.code} · {shot.title || "Untitled shot"}</span> · from the shot list</>
            : scoped ? <>Building <span className="text-ink">{current?.name ?? "this production"}</span>&rsquo;s setup — carried into every shot</>
              : "Building a setup for the whole workspace — pick a production to file it against a shot"}
        </span>
      </nav>

      <div className="st is-builder" style={{ "--st-rail": `${railW}px` } as React.CSSProperties}>
        <section className="st-main !gap-[30px]">
          <div className="st-sec">
            <div className="st-sec-head">
              <span className="st-h">Camera</span>
              <span className="st-sub">The bank — every move, written so the engine can&rsquo;t mistake it. Where a take used one, it shows.</span>
              <input className="ctl bank-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Search — dolly, handheld, dusk…" aria-label="Search the bank and the rows" />
            </div>
            <div className="bank">
              {bank.map((m) => (
                <button key={`${m.key}-${m.value}`} type="button" onClick={() => toggle(m.key, m.value)} title={m.title}
                  className={`bank-tile ${spec[m.key] === m.value ? "is-on" : ""} ${m.last ? "has-take" : previewData?.previews[`${m.key}:${m.value}`] ? "has-preview" : ""}`}>
                  {(m.last?.storedUrl ?? previewData?.previews[`${m.key}:${m.value}`]) && (
                    <span className="bank-thumb" aria-hidden="true">
                      <LazyMedia url={m.last?.storedUrl ?? previewData!.previews[`${m.key}:${m.value}`]} kind="video" hoverPlay className="h-full w-full object-cover" />
                    </span>
                  )}
                  <span className="flex items-baseline justify-between gap-1.5">
                    <span className="bank-name">{m.label}</span>
                    <span className="bank-kind">{m.key === "technique" ? "TECHNIQUE" : "MOVE"}</span>
                  </span>
                  <span className={`bank-n ${m.n ? "" : "is-none"}`}>{m.n ? `${m.n} TAKE${m.n === 1 ? "" : "S"}` : "NO TAKE YET"}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="st-sec">
            <div className="st-sec-head">
              <span className="st-h">Setup</span>
              <span className="st-sub">One pick per row. The prompt assembles itself as you go.</span>
            </div>
            <div className="sr-list">
              {rows.map((c) => (
                <div key={c.key} className="sr">
                  <div className="flex flex-col gap-[5px]">
                    <span className="sr-label">{c.label}</span>
                    <span className="sr-help">{c.hint || HELP[c.key] || ""}</span>
                  </div>
                  <div className="sr-chips">
                    {c.options.map((o) => (
                      <button key={o.value} type="button" onClick={() => toggle(c.key, o.value)} title={o.phrase}
                        aria-pressed={spec[c.key] === o.value}
                        className={`sr-chip ${spec[c.key] === o.value ? "is-on" : ""}`}>{o.label}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <aside className="ws-rail">
          <PaneDivider spec={PANES.builder} label="Builder rail" />
          <div className="ws-rail-head">
            <span className="ws-bar-h">Prompt</span>
            <span className="mono-s">{n} OF {CATEGORIES.length} ROWS SET</span>
          </div>
          <div className="ws-rail-body !gap-4">
            <div className="st-prompt">
              <textarea value={prose} onChange={(e) => setProse(e.target.value)} rows={3} aria-label="Subject line"
                placeholder="What happens in the shot? Subject and action — @Cass steps in out of the rain and pulls the tarp off @The Mule." />
              <p className={`st-prompt-line ${phrase ? "" : "is-empty"}`}>{phrase ? `${phrase}.` : "Pick a row and the line writes itself."}</p>
            </div>
            <div className="flex flex-col">
              {CATEGORIES.map((c) => {
                const v = labelOf(c.key);
                return (
                  <div key={c.key} className="st-kv">
                    <span>{c.label}</span>
                    <span className={v ? "" : "is-unset"}>{v ?? "—"}</span>
                  </div>
                );
              })}
            </div>
            <p className="rail-help">
              Niche techniques carry their own explanation — an unusual term only lands as [term + what actually happens]. Subtitles and audio are the only things the engine reliably takes a NO for; everything else is described positively.
            </p>
          </div>
          <div className="ws-rail-foot">
            {/* On a phone the rows scroll away from the prompt; the bar keeps the line and the count in view. */}
            <span className="st-foot-line">{n} OF {CATEGORIES.length} ROWS SET{phrase ? ` · ${phrase}` : ""}</span>
            <button type="button" className="btn-primary !h-[46px] !px-4 !text-[14px]" onClick={takeToVideo} disabled={!signedIn || (!prose.trim() && n === 0)}
              title={signedIn ? undefined : "Sign in to generate"}>
              <span>Take it to Video</span>
              <span className="btn-primary-cost">{shot ? `${shot.code} · V${(shot.takes ?? 0) + 1}` : "UNFILED"}</span>
            </button>
            <button type="button" className="btn-secondary !h-[38px] justify-center" onClick={saveSetup} disabled={n === 0}>
              {saved ? "Saved" : `Save as ${setupName} setup`}
            </button>
            <span className="mono-s text-center" style={{ letterSpacing: 0 }}>nothing is rendered here — the composer keeps the model, duration and references</span>
          </div>
        </aside>
      </div>
    </>
  );
}
