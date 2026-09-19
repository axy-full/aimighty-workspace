"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { studioRequest, StudioRequestError } from "./GenerationDialog";
import { validAudioQuote, type NodeAudioSetup, type NodeAudioTask } from "@/lib/workbench/generation-audio";
import {
  pendingGenerationKey,
  readPendingGeneration,
  claimPendingGeneration,
  clearPendingGeneration,
  type PendingGeneration,
} from "@/lib/workbench/pending-generation";
import {
  SOUND_TASKS,
  SOUND_SECONDS,
  SOUND_CLIP_LIMIT,
  clampSeconds,
  createSoundNode,
  expectedSeconds,
  findSoundNode,
  parseSoundPlacements,
  placeGeneratedClip,
  readSoundPlacements,
  soundGenerationBody,
  soundPlacementsKey,
  soundTask,
  timecodeOf,
  writeSoundPlacements,
  type SoundLane,
  type SoundPlacement,
} from "@/lib/workbench/sound-generate";
import { audioClips } from "@/lib/workbench/audio";
import type { Project } from "@/lib/workbench/studio";
import type { MediaJob } from "@/lib/workbench/job-recovery";
import styles from "./SoundGenerate.module.css";

type Voice = { id: string; name: string; category?: string };

/* Local storage as an external store: the pending claim and the queued
   placements are read through it, so a reload or a second tab sees the same
   request and never spends twice. */
const listeners = new Set<() => void>();
const notifyStorage = () => listeners.forEach((listener) => listener());
function subscribeStorage(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
function readRaw(key: string | null): string {
  if (!key) return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
const noStore = () => "";

/** The file's own length, read from its header; null when it cannot be read in time. */
function probeSeconds(url: string, timeoutMs = 8000): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(null);
    const el = document.createElement("audio");
    let done = false;
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeAttribute("src");
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    el.preload = "metadata";
    el.onloadedmetadata = () =>
      finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => finish(null);
    el.src = url;
  });
}

function validMapping(value: unknown): value is { shotId: string; productionProjectId: string } {
  if (!value || typeof value !== "object") return false;
  const mapping = value as Record<string, unknown>;
  return [mapping.shotId, mapping.productionProjectId].every(
    (item) => typeof item === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(item),
  );
}

/**
 * Generate sound straight onto the timeline: a voice-over, a sound effect or
 * a piece of music, quoted first, submitted through the same audio admission
 * as every other track, filed as a take of the lane's Rig node, and placed on
 * its lane at the playhead the moment its bytes exist.
 */
export function SoundGenerate({
  scope,
  project,
  frame,
  jobs,
  enabled,
  onChange,
  onPause,
  onSave,
  onQueued,
}: {
  scope: string;
  project: Project;
  frame: number;
  jobs: MediaJob[];
  enabled: boolean;
  onChange: (fn: (p: Project) => Project) => void;
  onPause: () => void;
  onSave: (refresh?: boolean) => Promise<boolean>;
  onQueued: () => void;
}) {
  const [task, setTask] = useState<NodeAudioTask>("speech");
  const def = soundTask(task);
  const [text, setText] = useState("");
  const [lane, setLane] = useState<SoundLane>(def.lane);
  const [voiceId, setVoiceId] = useState("");
  const [modelId, setModelId] = useState("");
  const [seconds, setSeconds] = useState<Record<NodeAudioTask, number>>({
    speech: 0,
    sound: SOUND_SECONDS.sound.initial,
    music: SOUND_SECONDS.music.initial,
  });
  const [promptInfluence, setPromptInfluence] = useState(0.3);
  const [instrumental, setInstrumental] = useState(false);
  const [setup, setSetup] = useState<NodeAudioSetup | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesError, setVoicesError] = useState("");
  const [voicesBusy, setVoicesBusy] = useState(false);
  const [quote, setQuote] = useState<{ key: string; credits: number } | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const placementsKey = soundPlacementsKey(scope, project.id);
  const frameRef = useRef(frame);
  const projectRef = useRef(project);
  const placing = useRef(new Set<string>());
  useLayoutEffect(() => {
    frameRef.current = frame;
    projectRef.current = project;
  }, [frame, project]);

  const node = findSoundNode(project, task);
  const pendingKey = node ? pendingGenerationKey(scope, project.id, node.id) : null;
  const placementsRaw = useSyncExternalStore(subscribeStorage, () => readRaw(placementsKey), noStore);
  const placements = useMemo(() => parseSoundPlacements(placementsRaw), [placementsRaw]);
  const pendingRaw = useSyncExternalStore(subscribeStorage, () => readRaw(pendingKey), noStore);
  const { pending, pendingProblem } = useMemo(() => {
    if (!pendingKey || !pendingRaw) return { pending: null as PendingGeneration | null, pendingProblem: "" };
    try {
      return {
        pending: readPendingGeneration({ getItem: () => pendingRaw, setItem() {}, removeItem() {} }, pendingKey),
        pendingProblem: "",
      };
    } catch (e) {
      return { pending: null, pendingProblem: e instanceof Error ? e.message : "The saved request cannot be read." };
    }
  }, [pendingKey, pendingRaw]);

  /* What the account offers: models from the audio setup, voices from their own route. */
  const fetchVoices = useCallback(
    (refresh: boolean, signal?: AbortSignal) =>
      studioRequest<{ voices: Voice[]; configured: boolean; error?: string }>(
        "/api/audio/voices" + (refresh ? "?refresh=1" : ""),
        { signal, headers: { "X-Workbench-Scope": scope } },
      ),
    [scope],
  );
  const applyVoices = useCallback((data: { voices?: Voice[]; error?: string }) => {
    setVoices(data.voices ?? []);
    setVoicesError(data.error ?? "");
    setVoiceId((v) => v || data.voices?.[0]?.id || "");
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    studioRequest<NodeAudioSetup>("/api/audio", { signal: abort.signal, headers: { "X-Workbench-Scope": scope } })
      .then((data) => {
        if (abort.signal.aborted) return;
        setSetup(data);
        setModelId((m) => m || data.defaultSpeechModel || data.speechModels?.[0]?.id || "");
        if (!data.configured) setError("Sound generation is not connected for this workspace.");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Sound setup could not be loaded.");
      });
    fetchVoices(false, abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) applyVoices(data);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setVoicesError(e instanceof Error ? e.message : "Voices could not be loaded.");
      });
    return () => abort.abort();
  }, [enabled, scope, fetchVoices, applyVoices]);
  function refreshVoices() {
    setVoicesBusy(true);
    fetchVoices(true)
      .then(applyVoices)
      .catch((e) => setVoicesError(e instanceof Error ? e.message : "Voices could not be loaded."))
      .finally(() => setVoicesBusy(false));
  }

  const body = useMemo(
    () =>
      soundGenerationBody({
        task,
        text: text.trim(),
        seconds: seconds[task],
        instrumental,
        promptInfluence,
        voiceId,
        modelId,
      }),
    [task, text, seconds, instrumental, promptInfluence, voiceId, modelId],
  );
  const bodyKey = JSON.stringify(body);
  const ready = Boolean(setup?.configured && text.trim() && (task !== "speech" || voiceId));
  const cost = pending?.credits ?? (quote?.key === bodyKey ? quote.credits : null);

  /* Quote first: the button carries the price before anything is spent. */
  useEffect(() => {
    if (!enabled || pending || !ready) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      studioRequest<{ estimatedCredits: number }>("/api/audio", {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
        body: JSON.stringify({ ...body, quoteOnly: true }),
      })
        .then((data) => {
          if (!validAudioQuote(data)) throw new Error("Audio pricing returned an invalid estimate.");
          if (!abort.signal.aborted) {
            setError("");
            setQuote({ key: bodyKey, credits: data.estimatedCredits });
          }
        })
        .catch((e) => {
          if (!abort.signal.aborted) {
            setQuote(null);
            setError(e instanceof Error ? e.message : "The quote could not be read.");
          }
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [enabled, pending, ready, body, bodyKey, scope]);

  const remember = useCallback(
    (next: SoundPlacement[]) => {
      writeSoundPlacements(window.localStorage, placementsKey, next);
      notifyStorage();
    },
    [placementsKey],
  );

  /* When a queued generation's asset arrives, it becomes a clip at the remembered playhead. */
  useEffect(() => {
    if (!placements.length) return;
    for (const placement of placements) {
      if (placing.current.has(placement.jobId)) continue;
      const asset = project.assets.find((a) => a.generationId === placement.jobId);
      if (asset) {
        placing.current.add(placement.jobId);
        void probeSeconds(asset.url).then((measured) => {
          try {
            onPause();
            onChange((p) => placeGeneratedClip(p, placement, asset, measured ?? placement.seconds));
            setStatus(
              `${placement.label} placed on the ${placement.lane === "sfx" ? "SFX" : placement.lane} lane at ${timecodeOf(placement.startFrame, projectRef.current.fps)}.`,
            );
          } catch (e) {
            setError(e instanceof Error ? e.message : "The clip could not be placed.");
          }
          remember(readSoundPlacements(window.localStorage, placementsKey).filter((p) => p.jobId !== placement.jobId));
          placing.current.delete(placement.jobId);
        });
        continue;
      }
      const job = jobs.find((j) => j.id === placement.jobId);
      if (job && (job.status === "failed" || job.status === "cancelled")) {
        setError(job.error || `${placement.label} did not finish. Nothing was placed.`);
        remember(placements.filter((p) => p.jobId !== placement.jobId));
      }
    }
  }, [placements, project.assets, jobs, onChange, onPause, remember, placementsKey]);

  async function submit() {
    if (busy || !enabled || (!pending && cost == null)) return;
    setBusy(true);
    setError("");
    setStatus("");
    let attempt: PendingGeneration | null = null;
    let key = pendingKey;
    const startFrame = frameRef.current;
    const label = def.label;
    const asked = expectedSeconds(task, text, seconds[task]);
    try {
      attempt = key ? readPendingGeneration(window.localStorage, key) : null;
      if (!attempt) {
        if (audioClips(projectRef.current).length >= SOUND_CLIP_LIMIT)
          throw new Error(`An edit supports up to ${SOUND_CLIP_LIMIT} audio clips. Remove one before generating more.`);
        let target = findSoundNode(projectRef.current, task);
        if (!target) {
          const created = createSoundNode(projectRef.current, task);
          onChange((p) => ({ ...p, nodes: [...p.nodes, created] }));
          target = created;
        }
        if (!(await onSave())) throw new Error("Save your latest work before generating.");
        const mapping = await studioRequest("/api/workbench/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
          body: JSON.stringify({ action: "map-shot", projectId: project.id, nodeId: target.id }),
        });
        if (!validMapping(mapping)) throw new Error("The project mapping could not be verified. Nothing was submitted.");
        key = pendingGenerationKey(scope, project.id, target.id);
        attempt = claimPendingGeneration(window.localStorage, key, {
          key: crypto.randomUUID(),
          body: JSON.stringify({
            ...body,
            projectId: mapping.productionProjectId,
            shotId: mapping.shotId,
            maxCredits: cost!,
            title: `${label} · ${text.trim().slice(0, 60)}`,
          }),
          credits: cost!,
          endpoint: "/api/audio",
        });
        notifyStorage();
      }
      const queued = (id: string) => {
        clearPendingGeneration(window.localStorage, key!, attempt!.key);
        remember([
          ...readSoundPlacements(window.localStorage, placementsKey),
          { jobId: id, task, lane, startFrame, seconds: asked, label },
        ]);
        setStatus(`${label} submitted. It lands on the ${lane === "sfx" ? "SFX" : lane} lane at ${timecodeOf(startFrame, projectRef.current.fps)} when it is ready.`);
        setQuote(null);
        void onSave(true).then((saved) => {
          if (saved) onQueued();
        });
      };
      const result = await studioRequest<{ id: string }>("/api/audio", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.key, "X-Workbench-Scope": scope },
        body: attempt.body,
      });
      if (!result.id) throw new Error("The server has not confirmed a job yet. Retry to recover this same request.");
      queued(result.id);
    } catch (e) {
      if (attempt && key && e instanceof StudioRequestError) {
        if (typeof e.data.id === "string") {
          clearPendingGeneration(window.localStorage, key, attempt.key);
          remember([
            ...readSoundPlacements(window.localStorage, placementsKey),
            { jobId: e.data.id, task, lane, startFrame, seconds: asked, label },
          ]);
          setBusy(false);
          void onSave(true).then((saved) => {
            if (saved) onQueued();
          });
          return;
        }
        // Only a durable, completed refusal permits a fresh request and another quote.
        if (e.resolved && e.status >= 400 && e.status < 500) {
          clearPendingGeneration(window.localStorage, key, attempt.key);
          notifyStorage();
        }
      }
      setError(e instanceof Error ? e.message : "The generation could not be submitted.");
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || !enabled || !!pending;
  const bounds = SOUND_SECONDS[task];
  const laneName = (value: SoundLane) => (value === "sfx" ? "SFX" : value === "dialogue" ? "Dialogue" : "Music");
  return (
    <section className={styles.panel} aria-label="Generate sound">
      <header>
        <div>
          <span className="eyebrow">GENERATE</span>
          <h3>Voice-over, sound effects & music</h3>
        </div>
        <span className={styles.playhead}>
          Playhead {timecodeOf(frame, project.fps)} · frame {frame}
        </span>
      </header>
      <div className={styles.tasks} role="group" aria-label="Sound type">
        {SOUND_TASKS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={task === t.id}
            disabled={busy}
            onClick={() => {
              setTask(t.id);
              setLane(t.lane);
              setQuote(null);
              setError("");
              setStatus("");
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <label className={styles.text}>
        {def.field}
        <textarea
          aria-label={def.field}
          value={text}
          maxLength={5000}
          rows={3}
          disabled={disabled}
          placeholder={
            task === "speech"
              ? "The line to read. Direct v3 with tags: [whispers], [sighs]."
              : task === "sound"
                ? "Rain on a tin roof, distant thunder, no music."
                : "Slow piano, warm room tone, builds at the end."
          }
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className={styles.fields}>
        {task === "speech" && (
          <>
            <label>
              Voice
              <span className={styles.voiceRow}>
                <select aria-label="Voice" value={voiceId} disabled={disabled || voicesBusy} onChange={(e) => setVoiceId(e.target.value)}>
                  {!voices.length && <option value="">{voicesBusy ? "Loading voices…" : "No voices available"}</option>}
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn" disabled={disabled || voicesBusy} onClick={refreshVoices} aria-label="Refresh voices">
                  Refresh
                </button>
              </span>
            </label>
            <label>
              Model
              <select aria-label="Speech model" value={modelId} disabled={disabled} onChange={(e) => setModelId(e.target.value)}>
                {!setup?.speechModels?.length && <option value="">Loading…</option>}
                {setup?.speechModels?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {task !== "speech" && (
          <label>
            Length · seconds
            <input
              type="number"
              aria-label="Length in seconds"
              min={bounds.min}
              max={bounds.max}
              step={bounds.step}
              value={seconds[task]}
              disabled={disabled}
              onChange={(e) => setSeconds((s) => ({ ...s, [task]: clampSeconds(task, e.target.valueAsNumber) }))}
            />
          </label>
        )}
        {task === "sound" && (
          <label>
            Prompt influence · {promptInfluence.toFixed(2)}
            <input
              type="range"
              aria-label="Prompt influence"
              min={0}
              max={1}
              step={0.05}
              value={promptInfluence}
              disabled={disabled}
              onChange={(e) => setPromptInfluence(Number(e.target.value))}
            />
          </label>
        )}
        {task === "music" && (
          <label className={styles.check}>
            <input type="checkbox" checked={instrumental} disabled={disabled} onChange={(e) => setInstrumental(e.target.checked)} />
            Instrumental
          </label>
        )}
        <label>
          Lane
          <select aria-label="Sound lane" value={lane} disabled={disabled} onChange={(e) => setLane(e.target.value as SoundLane)}>
            <option value="dialogue">Dialogue</option>
            <option value="sfx">SFX</option>
            <option value="music">Music</option>
          </select>
        </label>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className="btn primary"
          data-sound-generate
          disabled={busy || !enabled || (!pending && (cost == null || !ready))}
          onClick={() => void submit()}
        >
          {busy
            ? "Submitting…"
            : pending
              ? `Recover submitted ${def.label.toLowerCase()} · ${pending.credits} cr`
              : cost != null && ready
                ? `Generate ${def.label.toLowerCase()} · ${cost} cr`
                : `Generate ${def.label.toLowerCase()}`}
        </button>
        <span className={styles.hint}>
          Lands on the {laneName(lane)} lane at {timecodeOf(frame, project.fps)}.
          {task === "speech" ? " Per character." : task === "sound" ? " One price per effect, up to 30 s." : " Per minute, 10 s to 5 min."}
        </span>
      </div>
      {voicesError && task === "speech" && (
        <p className={styles.note}>Voices: {voicesError}</p>
      )}
      {placements.length > 0 && (
        <ul className={styles.queue} aria-label="Sound in progress">
          {placements.map((p) => {
            const job = jobs.find((j) => j.id === p.jobId);
            return (
              <li key={p.jobId}>
                <strong>{p.label}</strong> · {laneName(p.lane)} lane at {timecodeOf(p.startFrame, project.fps)} ·{" "}
                {job?.status === "held" ? "held for credits" : job?.status ?? "queued"}
              </li>
            );
          })}
        </ul>
      )}
      {status && <p role="status">{status}</p>}
      {(error || pendingProblem) && (
        <p role="alert" className={styles.error}>
          {error || pendingProblem}
        </p>
      )}
    </section>
  );
}
