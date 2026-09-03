"use client";

/**
 * Audio — a voice, a sound, or a piece of music, made the way a shot is.
 *
 * Three doors into ElevenLabs. Every result is a render: it lands on the
 * wall and the ledger like a clip, with what it cost in credits and money.
 */
import { useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { useOnChange } from "@/lib/changes";
import { usePageTitle } from "@/lib/usePageTitle";
import { usd, timeAgo, downloadHref } from "@/lib/format";
import { shortLabel } from "@/lib/models";
import { appConfirm } from "@/components/dialog";
import { IconDown, IconTrash, IconSparkle, IconAudio, IconSearch } from "@/components/Icons";
import ParticlLockup, { Empty, ParticlSpinner, Waiting } from "@/components/ParticlMark";
import CreditStrip from "@/components/CreditStrip";
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

type Task = "speech" | "sound" | "music";
const TASKS: { id: Task; label: string; blurb: string }[] = [
  { id: "speech", label: "Voice", blurb: "A line, read by a voice." },
  { id: "sound", label: "Sound", blurb: "An effect from a description." },
  { id: "music", label: "Music", blurb: "A track from a brief." },
];

const clipId = (id: string) => id.split("_").pop()!.slice(-6).toUpperCase();
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export default function AudioPage() {
  usePageTitle("Audio");
  const { selection: bin, current } = useProject();
  const scoped = bin !== "all" && bin !== "unfiled";
  const { data: setup } = useApi<Setup>("/api/audio", 0);
  const q = `/api/jobs?kind=audio&limit=60${scoped ? `&projectId=${encodeURIComponent(bin)}` : ""}`;
  const { data: jobs, refresh } = useApi<{ generations: Gen[] }>(q, 5000);
  useOnChange(refresh);
  const gens = useMemo(() => jobs?.generations ?? [], [jobs]);

  const [task, setTask] = useState<Task>("speech");
  const [text, setText] = useState("");
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
  const [playing, setPlaying] = useState<string | null>(null);
  const preview = useRef<HTMLAudioElement | null>(null);

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

  function playPreview(v: Voice) {
    if (!v.previewUrl) return;
    if (playing === v.id) { preview.current?.pause(); setPlaying(null); return; }
    preview.current?.pause();
    const a = new Audio(v.previewUrl);
    preview.current = a;
    a.onended = () => setPlaying(null);
    a.play().catch(() => setPlaying(null));
    setPlaying(v.id);
  }

  async function make() {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = {
        task, text, projectId: scoped ? bin : null,
        title: task === "speech" ? `${voice?.name ?? "Voice"} · ${text.trim().slice(0, 40)}` : text.trim().slice(0, 60),
      };
      if (task === "speech") Object.assign(body, { voiceId, voiceName: voice?.name, modelId, stability, similarity, speed });
      if (task === "sound") Object.assign(body, { durationSeconds: duration ? Number(duration) : null });
      if (task === "music") Object.assign(body, { lengthMs: lengthS * 1000, instrumental });
      const res = await fetch("/api/audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't start");
      setText("");
      setTimeout(refresh, 500);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function remove(g: Gen) {
    if (!(await appConfirm(`Delete ${g.title || clipId(g.id)}?`, "Its cost stays on the ledger.", { confirmLabel: "Delete", danger: true }))) return;
    await fetch(`/api/jobs/${g.id}`, { method: "DELETE" });
    refresh();
  }

  if (!setup) return <Waiting label="Opening the audio desk" />;

  const acct = setup.account;
  const left = acct ? Math.max(0, acct.limit - acct.used) : null;

  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[1120px] pb-10">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-6">
          <h1><ParticlLockup /></h1>
          <span className="text-[15px] text-dim">audio · {scoped ? current?.name ?? "this project" : "the whole workspace"}</span>
          <span className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            <CreditStrip vendor="elevenlabs" />
            {acct && (
              <span className="text-[12.5px] text-mute" title={`ElevenLabs ${acct.tier} plan · resets ${acct.resetAt ? timeAgo(acct.resetAt) : "monthly"}`}>
                plan says <span className="font-medium text-dim">{left!.toLocaleString()}</span> of {acct.limit.toLocaleString()} · {acct.tier}
              </span>
            )}
          </span>
        </div>

        {!setup.configured && (
          <div className="card mt-6 px-5 py-5">
            <p className="text-[15px] font-medium">ElevenLabs isn&rsquo;t connected yet</p>
            <p className="mt-1.5 max-w-[64ch] text-[14px] text-dim">
              Voices, sound effects and music run on the ElevenLabs account named <span className="font-medium text-ink">particl studio</span>.
              An admin adds its API key as <code className="font-mono text-[12.5px]">{setup.envKey}</code> in Vercel › Settings › Environment Variables (production) and redeploys; this screen wakes up on its own. The key never leaves the server.
            </p>
          </div>
        )}
        {setup.configured && setup.accountError && (
          <p className="mt-4 rounded-[10px] bg-lift/8 px-3 py-2 text-[13.5px] text-lift">{setup.accountError}</p>
        )}

        {/* ── The desk ── */}
        <section className={`card mt-6 px-5 py-5 ${setup.configured ? "" : "pointer-events-none opacity-60"}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            {TASKS.map((t) => (
              <button key={t.id} type="button" onClick={() => setTask(t.id)} title={t.blurb}
                className={`chip ${task === t.id ? "bg-blue text-white" : ""}`}>{t.label}</button>
            ))}
            <span className="ml-2 text-[13px] text-mute">{TASKS.find((t) => t.id === task)!.blurb}</span>
          </div>

          <textarea
            value={text} onChange={(e) => setText(e.target.value)} rows={task === "speech" ? 4 : 2}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); make(); } }}
            placeholder={task === "speech"
              ? "The line, as it should be read. With Eleven v3, direct it inline: [whispers] we shouldn't be here. [laughs]"
              : task === "sound"
                ? "e.g. heavy wooden door creaks open slowly, stone hallway, distant echo"
                : "e.g. slow cinematic strings building to a brass swell, 90 bpm, hopeful, no vocals"}
            className="mt-4 w-full resize-none rounded-[12px] bg-chip px-3.5 py-3 text-[15px] text-bone placeholder:text-mute focus:bg-panel focus:outline-none"
          />

          {task === "speech" && (
            <div className="mt-4 grid gap-5 md:grid-cols-[1fr_260px]">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-dim">Voice</span>
                  {voice && <span className="text-[13px] text-mute">{voice.name}{voice.labels.accent ? ` · ${voice.labels.accent}` : ""}{voice.labels.gender ? ` · ${voice.labels.gender}` : ""}</span>}
                  <span className="relative ml-auto">
                    <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 !h-3.5 !w-3.5 -translate-y-1/2 text-mute" />
                    <input value={voiceQuery} onChange={(e) => setVoiceQuery(e.target.value)} placeholder="Find a voice"
                      className="ctl !h-[32px] w-[190px] !pl-8 !text-[13px]" />
                  </span>
                </div>
                {setup.voicesError && <p className="mt-2 text-[13px] text-lift">{setup.voicesError}</p>}
                <div className="mt-2 grid max-h-[260px] gap-1.5 overflow-y-auto pr-1 [grid-template-columns:repeat(auto-fill,minmax(170px,1fr))]">
                  {shownVoices.map((v) => (
                    <button key={v.id} type="button" onClick={() => setVoiceId(v.id)}
                      className={`flex items-center gap-2 rounded-[10px] px-2.5 py-2 text-left ${voiceId === v.id ? "bg-blue text-white" : "bg-panel2 hover:bg-chip"}`}>
                      <span role="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); playPreview(v); }} title="Hear it"
                        className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${voiceId === v.id ? "bg-white/20" : "bg-chip"} ${!v.previewUrl ? "opacity-40" : ""}`}>
                        {playing === v.id ? <span className="h-2.5 w-2.5 rounded-[2px] bg-current" /> : <span className="ml-0.5 border-y-[5px] border-l-[8px] border-y-transparent border-l-current" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13.5px] font-medium">{v.name}</span>
                        <span className={`block truncate text-[11.5px] ${voiceId === v.id ? "text-white/75" : "text-mute"}`}>
                          {[v.labels.gender, v.labels.accent, v.labels.age, v.labels.use_case ?? v.labels.description].filter(Boolean).join(" · ") || v.category}
                        </span>
                      </span>
                    </button>
                  ))}
                  {shownVoices.length === 0 && <span className="col-span-full text-[13px] text-mute">{voices.length ? "No voice by that name." : "No voices came back from the account."}</span>}
                </div>
              </div>
              <div className="flex flex-col gap-3">
                <label className="block">
                  <span className="mb-1.5 block text-[13px] font-medium text-dim">Model</span>
                  <select className="ctl" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                    {setup.speechModels.map((m) => <option key={m.id} value={m.id}>{m.label}{m.alpha ? " (alpha)" : ""} · {m.creditsPerChar} cr/char</option>)}
                  </select>
                  {model && <span className="mt-1 block text-[12px] leading-snug text-mute">{model.note}</span>}
                </label>
                <Slider label="Stability" value={stability} onChange={setStability} hint={stability < 0.35 ? "expressive, varies take to take" : stability > 0.7 ? "steady, flatter" : "balanced"} />
                <Slider label="Similarity" value={similarity} onChange={setSimilarity} hint={similarity > 0.85 ? "closest to the source, may carry its artefacts" : "natural"} />
                <Slider label="Speed" value={speed} onChange={setSpeed} min={0.7} max={1.2} step={0.05} hint={speed === 1 ? "as recorded" : `${speed.toFixed(2)}×`} />
              </div>
            </div>
          )}

          {task === "sound" && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-dim">Length</span>
              {(["", "1", "2", "5", "10", "20"] as const).map((d) => (
                <button key={d} type="button" onClick={() => setDuration(d)} className={`chip !py-1 !text-[12.5px] ${duration === d ? "bg-blue text-white" : ""}`}>
                  {d === "" ? "Let it decide" : `${d}s`}
                </button>
              ))}
              <span className="text-[12.5px] text-mute">Up to 30s; the price is the same whatever the length.</span>
            </div>
          )}

          {task === "music" && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-dim">Length</span>
              {[15, 30, 60, 120, 180].map((s) => (
                <button key={s} type="button" onClick={() => setLengthS(s)} className={`chip !py-1 !text-[12.5px] ${lengthS === s ? "bg-blue text-white" : ""}`}>{mmss(s)}</button>
              ))}
              <button type="button" onClick={() => setInstrumental((v) => !v)} className={`chip !py-1 !text-[12.5px] ${instrumental ? "bg-blue text-white" : ""}`}>Instrumental</button>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={make} disabled={!text.trim() || busy || !setup.configured || (task === "speech" && !voiceId)}
              className="btn-render h-[38px] px-5 text-[14.5px] disabled:opacity-40">
              <IconSparkle className="!h-4 !w-4" /> {busy ? "Sending…" : task === "speech" ? "Read it" : task === "sound" ? "Make the sound" : "Compose"}
            </button>
            <span className="text-[13px] text-mute">
              {text.trim() ? <>About <span className="font-medium text-dim">{estCredits.toLocaleString()} credits</span> · {estUsd < 0.005 ? "under a cent" : usd(estUsd)}{task === "speech" ? ` · ${text.length} characters` : ""}</> : "The cost sits here before you press it."}
            </span>
            {err && <span className="text-[13px] text-lift">{err}</span>}
          </div>
        </section>

        {/* ── What's been made ── */}
        <section className="mt-8">
          <div className="flex items-baseline gap-2.5">
            <p className="grouplabel !pb-0">Made here</p>
            <span className="text-[13px] text-mute">{gens.length ? `${gens.length} · ${usd(gens.reduce((a, g) => a + (g.costUsd ?? 0), 0))}` : ""}</span>
          </div>
          {gens.length === 0 ? (
            <div className="card mt-3"><Empty title="Nothing recorded yet" line="A voice line, a sound or a track lands here the moment it's made, and on the Library with everything else." /></div>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {gens.map((g) => <AudioRow key={g.id} gen={g} onDelete={() => remove(g)} />)}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Slider({ label, value, onChange, hint, min = 0, max = 1, step = 0.05 }: {
  label: string; value: number; onChange: (v: number) => void; hint?: string; min?: number; max?: number; step?: number;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-[13px]">
        <span className="font-medium text-dim">{label}</span>
        <span className="text-[12px] text-mute">{hint}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full accent-[var(--color-blue)]" />
    </label>
  );
}

/** One audio render: a player, what it is, what it cost. */
export function AudioRow({ gen, onDelete }: { gen: Gen; onDelete?: () => void }) {
  const url = gen.storedUrl ?? gen.sourceUrl;
  const done = gen.status === "succeeded" && Boolean(url);
  const live = gen.status === "queued" || gen.status === "running";
  const p = gen.params as { task?: string; voiceName?: string; credits?: number; durationSeconds?: number | null; lengthMs?: number };
  return (
    <div data-gen-id={gen.id} data-gen-prompt={gen.prompt} data-gen-label={gen.title || clipId(gen.id)} data-gen-title={gen.title ?? ""}
      className="card flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-chip text-dim"><IconAudio className="!h-4 !w-4" /></span>
      <span className="min-w-0 flex-1 basis-[240px]">
        <span className="block truncate text-[14px] font-medium">{gen.title || (p.voiceName ? `${p.voiceName} · ` : "") + gen.prompt.slice(0, 80)}</span>
        <span className="block truncate text-[12.5px] text-mute" title={gen.prompt}>
          {shortLabel(gen.model)}{p.voiceName ? ` · ${p.voiceName}` : ""}{p.durationSeconds ? ` · ${p.durationSeconds}s` : p.lengthMs ? ` · ${mmss(p.lengthMs / 1000)}` : ""}
          {gen.authorName ? ` · ${gen.authorName}` : ""} · {timeAgo(gen.createdAt)}
          {gen.status === "failed" && gen.error ? <span className="text-lift"> · {gen.error.slice(0, 120)}</span> : ""}
        </span>
      </span>
      {done ? (
        <audio controls preload="none" src={url!} className="h-9 w-[260px] max-w-full" onClick={(e) => e.stopPropagation()} />
      ) : live ? (
        <span className="flex items-center gap-2 text-[13px] text-dim"><ParticlSpinner size={16} className="text-dim" /> {gen.status === "queued" ? "Queued" : "Making it"}…</span>
      ) : (
        <span className="text-[13px] text-lift">{gen.status === "cancelled" ? "Cancelled" : "Failed"}</span>
      )}
      <span className="flex items-center gap-1 tabular-nums text-[13px]">
        {gen.costUsd != null && <span className="font-medium" title={p.credits ? `${p.credits.toLocaleString()} credits` : ""}>{gen.costUsd < 0.005 && gen.costUsd > 0 ? "<1¢" : usd(gen.costUsd)}</span>}
        {url && (
          <a href={downloadHref(url)} download title="Download" className="grid h-8 w-8 place-items-center rounded-full text-dim hover:bg-chip"><IconDown /></a>
        )}
        {onDelete && (
          <button type="button" onClick={onDelete} title="Delete" className="grid h-8 w-8 place-items-center rounded-full text-dim hover:bg-chip hover:text-lift"><IconTrash /></button>
        )}
      </span>
    </div>
  );
}
