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
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { CATEGORIES, specToPhrase, specCount, type ShotSpec } from "@/lib/studio";
import { Waiting } from "@/components/ParticlMark";
import { useDraft, peekDraft } from "@/lib/useDraft";
import { usePageTitle } from "@/lib/usePageTitle";
import type { Gen } from "@/components/GenCard";
import type { Shot } from "@/lib/shots";

type ShotRow = Shot & { takes: number };
/* Helpers for the rows whose category carries none. */
const HELP: Record<string, string> = {
  mood: "The feeling the frame should carry — one word the engine can act on.",
  pace: "Real time, slow motion, a ramp, a timelapse. The clock the shot runs on.",
  sound: "What the engine renders for sound when Audio is on. Tracks replace or layer it, per take.",
};

export default function ShotBuilderPage() {
  return <Suspense fallback={<Waiting label="Opening the shot builder" />}><ShotBuilder /></Suspense>;
}

function ShotBuilder() {
  usePageTitle("Shot builder");
  const router = useRouter();
  const search = useSearchParams();
  const { signedIn, workspace } = useSession();
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

  // The production's saved setup opens the builder already set — unless
  // there is unfinished work here, which wins over the saved starting point.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`aw_setup_${bin}`);
      if (raw && !peekDraft<ShotSpec>(workspace?.id, `studio-spec:${bin}`)) {
        const saved = JSON.parse(raw) as ShotSpec;
        Promise.resolve().then(() => setSpec(saved));
      }
    } catch { /* private mode */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bin, workspace?.id]);

  /* Which renders used each move or technique — the bank's usage line. */
  const used = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of recent?.generations ?? []) {
      const sp = (g.params as { shotSpec?: ShotSpec }).shotSpec;
      for (const k of [sp?.move, sp?.technique]) if (k) map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  }, [recent]);

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
  function saveSetup() {
    try {
      window.localStorage.setItem(`aw_setup_${bin}`, JSON.stringify(spec));
      window.localStorage.setItem("aw_last_spec", JSON.stringify(spec));
      setSaved(true); setTimeout(() => setSaved(false), 1800);
    } catch { /* private mode */ }
  }

  const bank = (["move", "technique"] as const).flatMap((key) => {
    const cat = CATEGORIES.find((c) => c.key === key)!;
    return cat.options.map((o) => ({ key, value: o.value, label: o.label, title: o.module || o.phrase, n: used.get(o.value) ?? 0 }));
  });
  const setupName = scoped ? current?.name ?? "this production" : "workspace";

  return (
    <>
      <nav className="subnav !px-6" aria-label="Studio">
        <Link href="/studio" className="subnav-item">Cast &amp; identities</Link>
        <span className="subnav-item is-on" aria-current="page">Camera &amp; shot builder</span>
        <span className="subnav-note">
          {shot
            ? <>Building for <span className="text-ink">{shot.code} · {shot.title || "Untitled shot"}</span> · from the shot list</>
            : scoped ? <>Building <span className="text-ink">{current?.name ?? "this production"}</span>&rsquo;s setup — carried into every shot</>
              : "Building a setup for the whole workspace — pick a production to file it against a shot"}
        </span>
      </nav>

      <div className="st is-builder" style={{ "--st-rail": "400px" } as React.CSSProperties}>
        <section className="st-main !gap-[30px]">
          <div className="st-sec">
            <div className="st-sec-head">
              <span className="st-h">The camera</span>
              <span className="st-sub">The bank — every move, written so the engine can&rsquo;t mistake it. Where a render used one, it shows.</span>
            </div>
            <div className="bank">
              {bank.map((m) => (
                <button key={`${m.key}-${m.value}`} type="button" onClick={() => toggle(m.key, m.value)} title={m.title}
                  className={`bank-tile ${spec[m.key] === m.value ? "is-on" : ""}`}>
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
              <span className="st-h">The shot</span>
              <span className="st-sub">One pick per row. The prompt assembles itself as you go.</span>
            </div>
            <div className="sr-list">
              {CATEGORIES.map((c) => (
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
          <div className="ws-rail-head">
            <span className="ws-bar-h">The prompt</span>
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
              title={signedIn ? undefined : "Sign in to render"}>
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
