"use client";

/**
 * Audio — tracks against shots, from the pipeline handoff.
 *
 * Three kinds of track, one desk: ambient (a sound from a description),
 * music (a track from a brief) and dialogue (a line, read by a voice). Every
 * one is a render: it is filed against a shot the way a take is, it lands
 * on the ledger with what it cost, and it lists here as a ROW rather than a
 * card — the thing to compare between tracks is what they belong to and
 * what they cost, not a picture.
 *
 * Seedance renders its own sound when Audio is on; tracks here replace or
 * layer it, per take. That line sits on the toolbar so nobody makes an
 * ambient bed for a shot that already has one.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/useApi";
import { loadDraft, saveDraft, clearDraft } from "@/lib/draft";
import { useSession } from "@/lib/session";
import { useProject } from "@/lib/projectContext";
import { useOnChange } from "@/lib/changes";
import { usePageTitle } from "@/lib/usePageTitle";
import { usd, timeAgo, downloadHref } from "@/lib/format";
import { shortLabel } from "@/lib/models";
import type { ShotSpec } from "@/lib/studio";
import type { Shot } from "@/lib/shots";
import { Empty, ParticlSpinner, Waiting, Trouble } from "@/components/ParticlMark";
import ShotRow from "@/components/ShotRow";
import { SetupBlock, AUDIO_ROWS } from "@/components/SetupPanel";
import type { Gen } from "@/components/GenCard";

type Voice = { id: string; name: string; category: string; labels: Record<string, string>; previewUrl: string | null; description: string };
type SpeechModel = { id: string; label: string; creditsPerChar: number; note: string; alpha?: boolean };
type Account = { tier: string; status: string; used: number; limit: number; resetAt: number | null; usdPerCredit: number };
type Setup = {
  configured: boolean; envKey: string;
  speechModels: SpeechModel[]; defaultSpeechModel: string;
  voices: Voice[]; voicesError: string | null;
  account: Account | null; accountError: string | null;
  terms: { sfxCredits: number; musicCreditsPerMinute: number };
};

/* The desk's three words for a track, and the API's task behind each. */
type Task = "sound" | "music" | "speech";
const KINDS: { id: Task; label: string; placeholder: string }[] = [
  { id: "sound", label: "Ambient", placeholder: "Rain on a corrugated roof, steady, close. A single fluorescent tube humming. Far off, a road. No music." },
  { id: "music", label: "Music", placeholder: "Slow cinematic strings building to a brass swell, 90 bpm, hopeful, no vocals." },
  { id: "speech", label: "Dialogue", placeholder: "The line, as it should be read. With Eleven v3, direct it inline: [whispers] we shouldn't be here." },
];
type Filter = "all" | Task;

const kindOf = (g: Gen): Task => {
  const t = (g.params as { task?: string }).task;
  return t === "music" ? "music" : t === "speech" ? "speech" : "sound";
};
const labelOf = (t: Task) => KINDS.find((k) => k.id === t)!.label;
const clipId = (id: string) => id.split("_").pop()!.slice(-6).toUpperCase();
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
/** A track's length, when the request fixed one. */
function lengthOf(g: Gen): number | null {
  const p = g.params as { durationSeconds?: number | null; lengthMs?: number };
  if (p.durationSeconds) return p.durationSeconds;
  if (p.lengthMs) return p.lengthMs / 1000;
  return null;
}

type Group = { key: string; code: string; title: string; meta: string; tracks: Gen[] };

export default function AudioPage() {
  usePageTitle("Audio");
  const { signedIn } = useSession();
  const { selection: bin } = useProject();
  const scoped = bin !== "all" && bin !== "unfiled";
  const { data: setup, error: setupError, refresh: refreshSetup } = useApi<Setup>("/api/audio", 0);
  const q = `/api/jobs?kind=audio&limit=120${scoped ? `&projectId=${encodeURIComponent(bin)}` : ""}`;
  const { data: jobs, refresh } = useApi<{ generations: Gen[] }>(q, 5000);
  useOnChange(refresh);
  const gens = useMemo(() => jobs?.generations ?? [], [jobs]);
  const { data: shotData } = useApi<{ shots: Shot[] }>(
    scoped ? `/api/shots?projectId=${encodeURIComponent(bin)}` : null, 30_000);
  const shots = useMemo(() => shotData?.shots ?? [], [shotData]);

  const [filter, setFilter] = useState<Filter>("all");
  const [task, setTask] = useState<Task>("sound");
  const [text, setText] = useState("");
  const [shotId, setShotId] = useState("");
  // Picked up on mount, never in the initializer: the server has no
  // localStorage and seeding at first render would hydrate wrong.
  useEffect(() => {
    const draft = loadDraft("audio", signedIn);
    // Every setState here sits behind an await, so nothing is set
    // synchronously during the effect.
    if (draft) Promise.resolve().then(() => setText(draft));
  }, [signedIn]);
  /* The setup the video composer last showed — Sound, Mood, Time of day,
     Titles are its sound half. Read back, never owned here. */
  const [spec, setSpec] = useState<ShotSpec>({});
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("aw_last_spec");
      if (raw) Promise.resolve().then(() => setSpec(JSON.parse(raw) as ShotSpec));
    } catch { /* a spec we can't read is one we don't show */ }
  }, []);

  const [voiceChoice, setVoiceId] = useState("");
  const [voiceQuery, setVoiceQuery] = useState("");
  const [modelChoice, setModelId] = useState("");
  const [stability, setStability] = useState(0.5);
  const [similarity, setSimilarity] = useState(0.75);
  const [speed, setSpeed] = useState(1);
  const [duration, setDuration] = useState<string>("");   // "" = let it decide
  const [lengthS, setLengthS] = useState(30);
  const [instrumental, setInstrumental] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Until someone chooses, the account's default model and first voice.
  const modelId = modelChoice || setup?.defaultSpeechModel || "";
  const voices = useMemo(() => setup?.voices ?? [], [setup]);
  const voiceId = voiceChoice || voices[0]?.id || "";
  const shownVoices = useMemo(() => {
    const needle = voiceQuery.trim().toLowerCase();
    return needle ? voices.filter((v) => `${v.name} ${Object.values(v.labels).join(" ")} ${v.description}`.toLowerCase().includes(needle)) : voices;
  }, [voices, voiceQuery]);
  const voice = voices.find((v) => v.id === voiceId) ?? null;
  const model = setup?.speechModels.find((m) => m.id === modelId) ?? setup?.speechModels[0] ?? null;
  const rate = setup?.account?.usdPerCredit ?? 22 / 121_000;

  const estCredits = task === "speech"
    ? Math.ceil(text.length * (model?.creditsPerChar ?? 1))
    : task === "sound"
      ? (setup?.terms.sfxCredits ?? 200)
      : Math.ceil((lengthS / 60) * (setup?.terms.musicCreditsPerMinute ?? 900));
  const estUsd = estCredits * rate;
  const lenLabel = task === "sound" ? (duration ? `${duration}s` : "auto") : task === "music" ? mmss(lengthS) : `${text.length} ch`;

  /* One player for the whole wall; a row shows the playhead while it is the
     one playing. */
  const player = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [pos, setPos] = useState(0);
  function stop() { player.current?.pause(); player.current = null; setPlaying(null); setPos(0); }
  function play(g: Gen) {
    if (playing === g.id) { stop(); return; }
    const url = g.storedUrl ?? g.sourceUrl;
    if (!url) return;
    stop();
    const a = new Audio(url);
    player.current = a;
    a.ontimeupdate = () => { if (a.duration) setPos(a.currentTime / a.duration); };
    a.onended = () => { setPlaying(null); setPos(0); };
    a.play().catch(() => setPlaying(null));
    setPlaying(g.id);
  }
  // A voice preview is a different sound, on the same player.
  const [previewing, setPreviewing] = useState<string | null>(null);
  function preview(v: Voice) {
    if (!v.previewUrl) return;
    if (previewing === v.id) { stop(); setPreviewing(null); return; }
    stop();
    const a = new Audio(v.previewUrl);
    player.current = a;
    a.onended = () => setPreviewing(null);
    a.play().catch(() => setPreviewing(null));
    setPreviewing(v.id);
  }
  useEffect(() => () => { player.current?.pause(); }, []);

  const counts = useMemo(() => {
    const c = { all: gens.length, sound: 0, music: 0, speech: 0 };
    for (const g of gens) c[kindOf(g)]++;
    return c;
  }, [gens]);

  /* Group by shot in shot order, loose tracks last. Tracks are numbered in
     the order they were made, before any filter, so A2 stays A2 when the
     filter hides A1. */
  const { groups, numbered } = useMemo(() => {
    const numbered = new Map<string, number>();
    const perShot = new Map<string, number>();
    for (const g of gens.slice().sort((a, b) => a.createdAt - b.createdAt)) {
      const key = g.shotCode ?? "";
      const n = (perShot.get(key) ?? 0) + 1;
      perShot.set(key, n); numbered.set(g.id, n);
    }
    const byShot = new Map<string, Gen[]>();
    const loose: Gen[] = [];
    for (const g of gens) {
      if (filter !== "all" && kindOf(g) !== filter) continue;
      const key = g.shotCode ?? "";
      if (!key) { loose.push(g); continue; }
      (byShot.get(key) ?? byShot.set(key, []).get(key)!).push(g);
    }
    const meta = (l: Gen[]) => `${l.length} track${l.length === 1 ? "" : "s"} · ${usd(l.reduce((a, g) => a + (g.costUsd ?? 0), 0), 2)}`;
    const order = new Map(shots.map((s, i) => [s.code, i]));
    const groups: Group[] = [...byShot.entries()]
      .sort((a, b) => (order.get(a[0]) ?? 1e9) - (order.get(b[0]) ?? 1e9) || a[0].localeCompare(b[0]))
      .map(([code, list]) => ({
        key: code, code, title: shots.find((s) => s.code === code)?.title ?? "",
        tracks: list.slice().sort((a, b) => a.createdAt - b.createdAt), meta: meta(list),
      }));
    if (loose.length) {
      groups.push({ key: "", code: "", title: "Loose tracks", tracks: loose.slice().sort((a, b) => b.createdAt - a.createdAt), meta: meta(loose) });
    }
    return { groups, numbered };
  }, [gens, filter, shots]);

  const shotCode = shots.find((s) => s.id === shotId)?.code ?? null;
  const nextN = gens.filter((g) => (g.shotCode ?? "") === (shotCode ?? "")).length + 1;
  const filesAs = `${shotCode ? `${shotCode} · A${nextN}` : "loose"} · ${labelOf(task).toLowerCase()} · ${lenLabel}`;

  async function make() {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = {
        task, text, projectId: scoped ? bin : null, shotId: shotId || null,
        title: task === "speech" ? `${voice?.name ?? "Voice"} · ${text.trim().slice(0, 40)}` : text.trim().slice(0, 60),
      };
      if (task === "speech") Object.assign(body, { voiceId, voiceName: voice?.name, modelId, stability, similarity, speed });
      if (task === "sound") Object.assign(body, { durationSeconds: duration ? Number(duration) : null });
      if (task === "music") Object.assign(body, { lengthMs: lengthS * 1000, instrumental });
      const res = await fetch("/api/audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't start");
      clearDraft("audio");
      setText("");
      setTimeout(refresh, 500);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function refile(g: Gen, to: string | null) {
    const res = await fetch(`/api/jobs/${g.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shotId: to }) });
    if (!res.ok) { setErr("The track wasn't refiled."); return; }
    refresh();
  }

  if (!setup) return setupError ? <Trouble label="The audio desk didn't open" detail={setupError} onRetry={refreshSetup} /> : <Waiting label="Opening the audio desk" />;

  const canRender = signedIn && setup.configured && Boolean(text.trim()) && !busy && (task !== "speech" || Boolean(voiceId));
  const seg: { id: Filter; label: string; n: number }[] = [
    { id: "all", label: "All", n: counts.all }, { id: "sound", label: "Ambient", n: counts.sound },
    { id: "music", label: "Music", n: counts.music }, { id: "speech", label: "Dialogue", n: counts.speech },
  ];

  return (
    <div className="ws">
      <section className="ws-main">
        <div className="ws-bar">
          <div className="ws-bar-title">
            <span className="ws-bar-h">Tracks</span>
            <span className="mono-s">{gens.length} TRACKS · {shots.length} SHOTS</span>
          </div>
          <div className="seg ml-2" role="tablist" aria-label="Kind">
            {seg.map((s) => (
              <button key={s.id} type="button" role="tab" aria-selected={filter === s.id}
                className={`seg-opt ${filter === s.id ? "is-on" : ""}`} onClick={() => setFilter(s.id)}>
                {s.label}<span className="seg-n">{s.n}</span>
              </button>
            ))}
          </div>
          <span className="ws-bar-note">Seedance renders its own sound when Audio is on. Tracks here replace or layer it, per take.</span>
        </div>

        <div className="ws-scroll">
          {groups.length === 0 && (
            <Empty title={signedIn ? "Nothing recorded yet" : "The tracks are for the team"}
              line={signedIn
                ? "A voice line, a sound or a track lands here the moment it's made, filed against its shot."
                : "Sign in to see what has been made here. Everything else on this screen is yours to look at."} />
          )}
          {groups.map((g) => (
            <div key={g.key || "loose"} className="grp">
              <div className="grp-head">
                {g.code && <span className="grp-id">{g.code}</span>}
                <span className="grp-title">{g.title || (g.code ? "Untitled shot" : "Loose tracks")}</span>
                <span className="grp-meta">{g.meta}</span>
                <span className="grp-rule" />
                {g.code
                  ? <Link href="/" className="hdr-mono-link">OPEN SHOT →</Link>
                  : <span className="mono-s">NOT FILED AGAINST A SHOT</span>}
              </div>
              <div className="trk-list">
                {g.tracks.map((t) => (
                  <TrackRow key={t.id} gen={t} n={numbered.get(t.id) ?? 0} shots={shots}
                    playing={playing === t.id} pos={playing === t.id ? pos : 0}
                    onPlay={() => play(t)} onRefile={(to) => refile(t, to)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <aside className="ws-rail">
        <div className="ws-rail-head">
          <span className="ws-bar-h">Composer</span>
          <ShotRow chip projectId={bin} shotId={shotId} setShotId={setShotId} />
        </div>

        <div className="ws-rail-body">
          {!setup.configured && (
            <p className="rail-help">
              ElevenLabs isn&rsquo;t connected yet. An admin adds its API key as <code className="font-mono text-[11px]">{setup.envKey}</code> in
              Vercel › Settings › Environment Variables and redeploys; this desk wakes up on its own.
            </p>
          )}
          {setup.configured && setup.accountError && <p className="rail-help text-lift">{setup.accountError}</p>}

          <div className="seg is-fill" role="tablist" aria-label="Track kind">
            {KINDS.map((k) => (
              <button key={k.id} type="button" role="tab" aria-selected={task === k.id}
                className={`seg-opt ${task === k.id ? "is-on" : ""}`} onClick={() => setTask(k.id)}>{k.label}</button>
            ))}
          </div>

          <textarea
            value={text} onChange={(e) => { setText(e.target.value); saveDraft("audio", e.target.value); }}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); make(); } }}
            placeholder={KINDS.find((k) => k.id === task)!.placeholder}
            className="rail-prompt" rows={task === "speech" ? 5 : 4} aria-label="Prompt"
          />

          <div className="rail-chips">
            {task === "sound" && (
              <>
                <span className="chip-dd is-muted">Sound effects</span>
                <label className="chip-dd">
                  Length
                  <select value={duration} onChange={(e) => setDuration(e.target.value)} aria-label="Length">
                    <option value="">let it decide</option>
                    {["1", "2", "5", "10", "20"].map((d) => <option key={d} value={d}>{d}s</option>)}
                  </select>
                  <span className="hdr-caret" aria-hidden="true">▼</span>
                </label>
                <span className="chip-dd is-muted"><span className="chip-dd-sub">UP TO 30S · ONE PRICE</span></span>
              </>
            )}
            {task === "music" && (
              <>
                <span className="chip-dd is-muted">Eleven Music</span>
                <label className="chip-dd">
                  Length
                  <select value={lengthS} onChange={(e) => setLengthS(Number(e.target.value))} aria-label="Length">
                    {[15, 30, 60, 120, 180].map((s) => <option key={s} value={s}>{mmss(s)}</option>)}
                  </select>
                  <span className="hdr-caret" aria-hidden="true">▼</span>
                </label>
                <button type="button" className={`chip-dd ${instrumental ? "" : "is-muted"}`} onClick={() => setInstrumental((v) => !v)} aria-pressed={instrumental}>
                  Instrumental <span className={`tgl ${instrumental ? "is-on" : ""}`} aria-hidden="true" />
                </button>
              </>
            )}
            {task === "speech" && (
              <label className="chip-dd">
                <select value={modelId} onChange={(e) => setModelId(e.target.value)} aria-label="Model">
                  {setup.speechModels.map((m) => <option key={m.id} value={m.id}>{m.label}{m.alpha ? " (alpha)" : ""}</option>)}
                </select>
                <span className="hdr-caret" aria-hidden="true">▼</span>
                {model && <span className="chip-dd-sub">{model.creditsPerChar} CR/CH</span>}
              </label>
            )}
          </div>

          {task === "speech" && (
            <div className="rail-sec">
              <span className="mono">Voice · dialogue only</span>
              <label className="search">
                <span className="search-glyph" aria-hidden="true">⌕</span>
                <input value={voiceQuery} onChange={(e) => setVoiceQuery(e.target.value)} placeholder="Find a voice" />
              </label>
              {setup.voicesError && <p className="rail-help text-lift">{setup.voicesError}</p>}
              <div className="voice-list">
                {shownVoices.map((v) => (
                  <button key={v.id} type="button" onClick={() => setVoiceId(v.id)} aria-pressed={voiceId === v.id}
                    className={`voice-chip ${voiceId === v.id ? "is-on" : ""}`} title={v.description}>
                    <span role="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); preview(v); }} title={v.previewUrl ? "Hear it" : "No preview"}
                      className={`voice-chip-play ${v.previewUrl ? "" : "is-off"}`}>{previewing === v.id ? "■" : "▶"}</span>
                    {v.name}
                    <span className="voice-chip-sub">{[v.labels.accent, v.labels.gender].filter(Boolean).join(" · ").toUpperCase() || v.category.toUpperCase()}</span>
                  </button>
                ))}
                {shownVoices.length === 0 && <span className="rail-help">{voices.length ? "No voice by that name." : "No voices came back from the account."}</span>}
              </div>
              <span className="rail-help">A voice is learned in Studio the way a face is, and cited the same way.</span>
              <Slider label="Stability" value={stability} onChange={setStability} hint={stability < 0.35 ? "expressive" : stability > 0.7 ? "steady" : "balanced"} />
              <Slider label="Similarity" value={similarity} onChange={setSimilarity} hint={similarity > 0.85 ? "closest to source" : "natural"} />
              <Slider label="Speed" value={speed} onChange={setSpeed} min={0.7} max={1.2} step={0.05} hint={speed === 1 ? "as recorded" : `${speed.toFixed(2)}×`} />
            </div>
          )}

          <SetupBlock spec={spec} rows={AUDIO_ROWS} eyebrow="Sound row" />
        </div>

        <div className="ws-rail-foot">
          {err && <p className="rail-help text-lift">{err}</p>}
          <button type="button" className="btn-primary !h-[46px] w-full !px-4 !text-[14px]" onClick={make} disabled={!canRender}
            title={!signedIn ? "Sign in to render" : undefined}>
            <span>{busy ? "Sending…" : "Render"}</span>
            <span className="btn-primary-cost">{text.trim() ? `${estUsd < 0.005 ? "<1¢" : usd(estUsd)} · ${lenLabel}` : `${estCredits.toLocaleString()} CR`}</span>
          </button>
          <span className="mono-s text-center">files as {filesAs}</span>
        </div>
      </aside>
    </div>
  );
}

function Slider({ label, value, onChange, hint, min = 0, max = 1, step = 0.05 }: {
  label: string; value: number; onChange: (v: number) => void; hint?: string; min?: number; max?: number; step?: number;
}) {
  return (
    <label className="rail-slider">
      <span className="rail-slider-h"><span>{label}</span><span>{hint}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

/**
 * One track: play, what it is, the waveform, what it belongs to, the money,
 * two small actions. Right-click carries rename and delete, as everywhere.
 */
function TrackRow({ gen, n, shots, playing, pos, onPlay, onRefile }: {
  gen: Gen; n: number; shots: Shot[]; playing: boolean; pos: number;
  onPlay: () => void; onRefile: (to: string | null) => void;
}) {
  const url = gen.storedUrl ?? gen.sourceUrl;
  const done = gen.status === "succeeded" && Boolean(url);
  const live = gen.status === "queued" || gen.status === "running";
  const p = gen.params as { voiceName?: string; credits?: number };
  const len = lengthOf(gen);
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [menu]);

  const first = live ? (gen.status === "queued" ? "Queued" : "Making it…")
    : gen.status === "failed" ? `Failed${gen.error ? ` · ${gen.error.slice(0, 80)}` : ""}`
    : gen.status === "cancelled" ? "Cancelled"
    : gen.title || gen.prompt.slice(0, 90);
  const second = [shortLabel(gen.model), p.voiceName, gen.authorName ? `by ${gen.authorName}` : null, timeAgo(gen.createdAt)].filter(Boolean).join(" · ");

  return (
    <div data-gen-id={gen.id} data-gen-prompt={gen.prompt} data-gen-label={gen.title || clipId(gen.id)} data-gen-title={gen.title ?? ""}
      className="trk">
      <button type="button" className="trk-play" onClick={onPlay} disabled={!done} title={done ? (playing ? "Stop" : "Play") : undefined} aria-label={playing ? "Stop" : "Play"}>
        {live ? <ParticlSpinner size={14} className="text-dim" /> : playing ? "■" : "▶"}
      </button>
      <div className="trk-type">
        <span>{labelOf(kindOf(gen))}</span>
        <span className="mono-s">A{n}{len ? ` · ${mmss(len)}` : ""}</span>
      </div>
      <div className={`trk-wave ${playing ? "is-playing" : ""} ${done ? "" : "is-empty"}`} aria-hidden="true">
        {playing && <span className="trk-wave-pos" style={{ left: `${(pos * 100).toFixed(2)}%` }} />}
      </div>
      <div className="trk-att">
        <span className={gen.status === "failed" ? "is-bad" : ""} title={gen.prompt}>{first}</span>
        <span>{second}</span>
      </div>
      <span className="mono-v trk-cost" title={p.credits ? `${p.credits.toLocaleString()} credits` : undefined}>
        {gen.costUsd == null ? "—" : gen.costUsd < 0.005 && gen.costUsd > 0 ? "<1¢" : usd(gen.costUsd)}
      </span>
      <div className="trk-acts" ref={wrap}>
        <span className="relative">
          <button type="button" className="trk-btn" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu}>
            {gen.shotCode ? "Move" : "Attach"}
          </button>
          {menu && (
            <div role="menu" className="menu-pop absolute right-0 top-full z-30 mt-1 min-w-[200px]">
              {shots.filter((s) => s.code !== gen.shotCode).map((s) => (
                <button key={s.id} type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(false); onRefile(s.id); }}>
                  <span className="mono-s mr-2">{s.code}</span><span className="min-w-0 flex-1 truncate">{s.title || "Untitled shot"}</span>
                </button>
              ))}
              {shots.length === 0 && <span className="menu-item text-mute">No shots in this production yet.</span>}
              {gen.shotCode && (
                <button type="button" role="menuitem" className="menu-item text-mute" onClick={() => { setMenu(false); onRefile(null); }}>Unfile</button>
              )}
            </div>
          )}
        </span>
        {url && <a href={downloadHref(url)} download className="trk-btn is-icon" title="Download" aria-label="Download">↓</a>}
      </div>
    </div>
  );
}
