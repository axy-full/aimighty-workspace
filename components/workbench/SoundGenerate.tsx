"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { notifySoundStorage as notifyStorage, readSoundStorage as readRaw, subscribeSoundStorage as subscribeStorage, useSoundLanding, useSoundPlacementList } from "./use-sound-placements";
import { NumberDraftInput } from "./NumberDraftInput";
import { PromptAttach, keptNote, resolveAttached } from "@/components/PromptAttach";
import { studioRequest, StudioRequestError } from "./GenerationDialog";
import { GROK_TTS_MODEL } from "@/lib/grokVoiceModel";
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
  SOUND_TOOLS,
  SOUND_SECONDS,
  SOUND_CLIP_LIMIT,
  createSoundNode,
  dubBody,
  expectedSeconds,
  findSoundNode,
  isSoundTool,
  readSoundPlacements,
  replaceableClips,
  soundGenerationBody,
  soundJobLabel,
  soundSources,
  soundTask,
  soundTool,
  timecodeOf,
  voiceChangeBody,
  type SoundJobTask,
  type SoundLane,
} from "@/lib/workbench/sound-generate";
import { DEFAULT_DUBBING_MODE, DUBBING_LANGUAGES, DUBBING_MODE_OPTIONS, DUBBING_SOURCE_AUTO, dubbingLanguageLabel } from "@/lib/workbench/dubbing-options";
import { audioClips } from "@/lib/workbench/audio";
import type { Asset, Project } from "@/lib/workbench/studio";
import type { MediaJob } from "@/lib/workbench/job-recovery";
import styles from "./SoundGenerate.module.css";

type Voice = { id: string; name: string; category?: string };

const noStore = () => "";

/** The account's voices, with a refresh — shared by Voice-over and Change voice. */
function VoicePicker({ voices, voiceId, disabled, busy, onChange, onRefresh }: { voices: Voice[]; voiceId: string; disabled: boolean; busy: boolean; onChange: (id: string) => void; onRefresh: () => void }) {
  return (
    <label>
      Voice
      <span className={styles.voiceRow}>
        <select aria-label="Voice" value={voiceId} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {!voices.length && <option value="">{busy ? "Loading voices…" : "No voices available"}</option>}
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn" disabled={disabled} onClick={onRefresh} aria-label="Refresh voices">
          Refresh
        </button>
      </span>
    </label>
  );
}

function validMapping(value: unknown): value is { shotId: string; productionProjectId: string } {
  if (!value || typeof value !== "object") return false;
  const mapping = value as Record<string, unknown>;
  return [mapping.shotId, mapping.productionProjectId].every(
    (item) => typeof item === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(item),
  );
}

/** What a dub is doing, in the panel's words, from the job feed's dubbingStatus. */
function dubbingWord(status: string | undefined): string | null {
  switch (status) {
    case "queued": return "waiting to submit";
    case "submitted": return "submitted, waiting for the vendor";
    case "dubbing": return "dubbing…";
    case "uncertain": return "outcome unconfirmed — under review";
    default: return null;
  }
}

/**
 * Generate sound straight onto the timeline: a voice-over, a sound effect or
 * a piece of music, quoted first, submitted through the same audio admission
 * as every other track, filed as a take of the lane's Rig node, and placed on
 * its lane at the playhead the moment its bytes exist (the page's
 * useSoundPlacements does the landing, open composer or not). Two tools sit beside
 * them — Change voice (a stored track re-voiced, replacing or joining a
 * dialogue clip) and Dub (an asynchronous project that lands on the dialogue
 * lane when the vendor is done) — quoted per minute of the chosen original.
 */
export function SoundGenerate({
  scope,
  project,
  frame,
  jobs,
  enabled,
  onChange,
  onSave,
  onQueued,
  initialTask = "speech",
  onRequest,
}: {
  /** The door to open on first render (Edit & Sound's stem rows open their own). */
  initialTask?: SoundJobTask;
  /** The form's current request — the exact body a submit would quote — or null while it is incomplete. */
  onRequest?: (request: { task: SoundJobTask; body: Record<string, unknown>; text: string } | null) => void;
  scope: string;
  project: Project;
  frame: number;
  jobs: MediaJob[];
  enabled: boolean;
  onChange: (fn: (p: Project) => Project) => void;
  onSave: (refresh?: boolean) => Promise<boolean>;
  onQueued: () => void;
}) {
  const [task, setTask] = useState<SoundJobTask>(initialTask);
  const tool = isSoundTool(task) ? soundTool(task) : null;
  /** The generator the fields describe; a tool borrows the voice-over's shape. */
  const genTask: NodeAudioTask = isSoundTool(task) ? "speech" : task;
  const def = soundTask(genTask);
  const [text, setText] = useState("");
  const [lane, setLane] = useState<SoundLane>(def.lane);
  const [sourceIds, setSourceIds] = useState<Record<string, string>>({});
  const [replaceClipId, setReplaceClipId] = useState("");
  const [removeNoise, setRemoveNoise] = useState(false);
  const [sourceLang, setSourceLang] = useState(DUBBING_SOURCE_AUTO);
  const [targetLang, setTargetLang] = useState("en");
  const [mode, setMode] = useState<string>(DEFAULT_DUBBING_MODE);
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
  /* Grok Voice (xAI) has its own voices; ElevenLabs' stay for everything else, Change voice included. */
  const [grokVoices, setGrokVoices] = useState<Voice[]>([]);
  const [grokVoiceId, setGrokVoiceId] = useState("");
  const [quote, setQuote] = useState<{ key: string; credits: number; minutes?: number; seconds?: number } | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const { key: placementsKey, placements, remember } = useSoundPlacementList(scope, project.id);
  /* A track that lands while this composer is open reports here, as it always did. */
  const landing = useSoundLanding(placementsKey);
  const [shownLanding, setShownLanding] = useState(landing);
  if (landing !== shownLanding) {
    setShownLanding(landing);
    if (landing?.error) setError(landing.text);
    else if (landing) setStatus(landing.text);
  }
  const frameRef = useRef(frame);
  const projectRef = useRef(project);
  useLayoutEffect(() => {
    frameRef.current = frame;
    projectRef.current = project;
  }, [frame, project]);

  const node = findSoundNode(project, task);
  const pendingKey = node ? pendingGenerationKey(scope, project.id, node.id) : null;
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
  const grokSpeech = modelId === GROK_TTS_MODEL;
  const loadGrokVoices = useCallback((refresh: boolean, signal?: AbortSignal) =>
    studioRequest<{ voices: Voice[]; error?: string }>(`/api/audio/voices?model=${GROK_TTS_MODEL}${refresh ? "&refresh=1" : ""}`, { signal, headers: { "X-Workbench-Scope": scope } })
      .then((data) => { if (signal?.aborted) return; setGrokVoices(data.voices ?? []); setVoicesError(data.error ?? ""); setGrokVoiceId((v) => v || data.voices?.[0]?.id || ""); })
      .catch((e) => { if (!signal?.aborted) setVoicesError(e instanceof Error ? e.message : "Grok voices could not be loaded."); }), [scope]);
  useEffect(() => {
    if (!enabled || !grokSpeech || grokVoices.length) return;
    const abort = new AbortController();
    void loadGrokVoices(false, abort.signal);
    return () => abort.abort();
  }, [enabled, grokSpeech, grokVoices.length, loadGrokVoices]);
  const speechVoices = grokSpeech ? grokVoices : voices;
  const speechVoiceId = grokSpeech ? grokVoiceId : voiceId;
  function refreshVoices() {
    setVoicesBusy(true);
    fetchVoices(true)
      .then(applyVoices)
      .catch((e) => setVoicesError(e instanceof Error ? e.message : "Voices could not be loaded."))
      .finally(() => setVoicesBusy(false));
  }

  /* The tools take a stored original: the project's own or shared audio (and, for a dub, video) assets. */
  const sources = useMemo(() => (tool ? soundSources(project, tool.sources) : []), [project, tool]);
  const source: Asset | null = tool ? (sources.find((a) => a.id === sourceIds[tool.id]) ?? sources[0] ?? null) : null;
  const replaceable = useMemo(() => (tool?.id === "voiceChange" && source ? replaceableClips(project, source) : []), [project, tool, source]);
  const voiceName = voices.find((v) => v.id === voiceId)?.name;
  const endpoint = tool ? tool.endpoint : "/api/audio";
  const body = useMemo(
    () =>
      tool?.id === "voiceChange"
        ? source ? voiceChangeBody({ source, voiceId, voiceName, removeBackgroundNoise: removeNoise }) : null
        : tool?.id === "dub"
          ? source ? dubBody({ source, sourceLang, targetLang, mode }) : null
          : soundGenerationBody({
              task: genTask,
              text: text.trim(),
              seconds: seconds[genTask],
              instrumental,
              promptInfluence,
              voiceId: speechVoiceId,
              modelId,
            }),
    [tool, source, voiceId, voiceName, removeNoise, sourceLang, targetLang, mode, genTask, text, seconds, instrumental, promptInfluence, modelId, speechVoiceId],
  );
  const bodyKey = JSON.stringify(body);
  const ready = Boolean(
    setup?.configured && body &&
      (tool?.id === "voiceChange"
        ? source && voiceId
        : tool?.id === "dub"
          ? source && targetLang && sourceLang !== targetLang
          : text.trim() && (task !== "speech" || speechVoiceId)),
  );
  const cost = pending?.credits ?? (quote?.key === bodyKey ? quote.credits : null);
  const requestRef = useRef(onRequest);
  useLayoutEffect(() => {
    requestRef.current = onRequest;
  }, [onRequest]);
  useEffect(() => {
    requestRef.current?.(ready && body ? { task, body, text: tool ? source?.name ?? "" : text.trim() } : null);
  }, [ready, bodyKey, task]); // eslint-disable-line react-hooks/exhaustive-deps -- bodyKey stands for body

  /* Quote first: the button carries the price before anything is spent. */
  useEffect(() => {
    if (!enabled || pending || !ready) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      studioRequest<{ estimatedCredits: number; minutes?: number; sourceSeconds?: number }>(endpoint, {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
        body: JSON.stringify({ ...body, quoteOnly: true }),
      })
        .then((data) => {
          if (!validAudioQuote(data)) throw new Error("Audio pricing returned an invalid estimate.");
          if (!abort.signal.aborted) {
            setError("");
            setQuote({
              key: bodyKey,
              credits: data.estimatedCredits,
              ...(typeof data.minutes === "number" ? { minutes: data.minutes } : {}),
              ...(typeof data.sourceSeconds === "number" ? { seconds: data.sourceSeconds } : {}),
            });
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
  }, [enabled, pending, ready, body, bodyKey, scope, endpoint]);

  async function submit() {
    if (busy || !enabled || (!pending && cost == null)) return;
    setBusy(true);
    setError("");
    setStatus("");
    let attempt: PendingGeneration | null = null;
    let key = pendingKey;
    const startFrame = frameRef.current;
    const label = soundJobLabel(task);
    const asked = tool ? Math.max(1, Math.ceil(quote?.seconds ?? source?.seconds ?? 5)) : expectedSeconds(genTask, text, seconds[genTask]);
    const replaceId = tool?.id === "voiceChange" && replaceClipId && replaceable.some((c) => c.id === replaceClipId) ? replaceClipId : undefined;
    const placementLane: SoundLane = tool ? "dialogue" : lane;
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
        /* The mapping is made after the save, so the draft does not hold it yet. Without it the
           job feed (use-production-jobs) and asset recovery never see this lane's takes. */
        const nodeId = target.id;
        onChange((p) =>
          p.shotMappings?.[nodeId] === mapping.shotId && p.productionProjectId === mapping.productionProjectId
            ? p
            : { ...p, productionProjectId: mapping.productionProjectId, shotMappings: { ...p.shotMappings, [nodeId]: mapping.shotId } },
        );
        key = pendingGenerationKey(scope, project.id, target.id);
        attempt = claimPendingGeneration(window.localStorage, key, {
          key: crypto.randomUUID(),
          body: JSON.stringify({
            ...body,
            projectId: mapping.productionProjectId,
            shotId: mapping.shotId,
            maxCredits: cost!,
            title: tool?.id === "voiceChange"
              ? `${source!.name.replace(/\.[A-Za-z0-9]{1,8}$/, "").slice(0, 50)} · voice changed${voiceName ? ` (${voiceName.slice(0, 20)})` : ""}`
              : `${label} · ${(tool ? source!.name : text.trim()).slice(0, 60)}`,
          }),
          credits: cost!,
          endpoint: endpoint as "/api/audio" | "/api/audio/dub",
        });
        notifyStorage();
      }
      const queued = (id: string) => {
        clearPendingGeneration(window.localStorage, key!, attempt!.key);
        remember([
          ...readSoundPlacements(window.localStorage, placementsKey),
          { jobId: id, task, lane: placementLane, startFrame, seconds: asked, label, ...(replaceId ? { replaceClipId: replaceId } : {}) },
        ]);
        setStatus(
          tool?.id === "dub"
            ? `Dub submitted. The dubbed track lands on the dialogue lane at ${timecodeOf(startFrame, projectRef.current.fps)} when the vendor has finished; this takes a few minutes.`
            : replaceId
              ? `${label} submitted. It replaces its dialogue clip when it is ready.`
              : `${label} submitted. It lands on the ${placementLane === "sfx" ? "SFX" : placementLane} lane at ${timecodeOf(startFrame, projectRef.current.fps)} when it is ready.`,
        );
        setQuote(null);
        void onSave(true).then((saved) => {
          if (saved) onQueued();
        });
      };
      const result = await studioRequest<{ id: string }>(attempt.endpoint ?? "/api/audio", {
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
            { jobId: e.data.id, task, lane: placementLane, startFrame, seconds: asked, label, ...(replaceId ? { replaceClipId: replaceId } : {}) },
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
  const bounds = SOUND_SECONDS[genTask];
  const laneName = (value: SoundLane) => (value === "sfx" ? "SFX" : value === "dialogue" ? "Dialogue" : "Music");
  const pick = (id: SoundJobTask) => {
    setTask(id);
    setLane(isSoundTool(id) ? "dialogue" : soundTask(id).lane);
    setQuote(null);
    setError("");
    setStatus("");
  };
  const sourceLabel = (a: Asset) => `${a.name}${a.kind === "video" ? " · video" : ""}${a.seconds ? ` · ${Math.round(a.seconds)} s` : ""}`;
  return (
    <section className={styles.panel} aria-label="Generate sound">
      <header>
        <div>
          <span className="eyebrow">GENERATE</span>
          <h3>Voice-over, sound effects, music, voice change & dubbing</h3>
        </div>
        <span className={styles.playhead}>
          Playhead {timecodeOf(frame, project.fps)} · frame {frame}
        </span>
      </header>
      <div className={styles.tasks} role="group" aria-label="Sound type">
        {SOUND_TASKS.map((t) => (
          <button key={t.id} type="button" aria-pressed={task === t.id} disabled={busy} onClick={() => pick(t.id)}>
            {t.label}
          </button>
        ))}
        {SOUND_TOOLS.map((t) => (
          <button key={t.id} type="button" aria-pressed={task === t.id} disabled={busy} onClick={() => pick(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {!tool && (
        <label className={styles.text}>
          {def.field}
          <PromptAttach scope={scope} projectId={project.id} testId="sound-attach" onAttach={async (attached) => {
            const { media, unreadable } = await resolveAttached(scope, attached);
            return keptNote([...unreadable, ...media.map((m) => m.name)], `${task === "speech" ? "speech is read from the line" : task === "sound" ? "sound effects are made from the words" : "music is made from the words"}; put the files on the lanes, or use Change voice for a recording.`);
          }}><textarea
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
          /></PromptAttach>
        </label>
      )}
      <div className={styles.fields}>
        {tool && (
          <label>
            Source
            <select
              aria-label={tool.id === "dub" ? "Dub source" : "Voice change source"}
              value={source?.id ?? ""}
              disabled={disabled}
              onChange={(e) => {
                setSourceIds((s) => ({ ...s, [tool.id]: e.target.value }));
                setReplaceClipId("");
              }}
            >
              {!sources.length && <option value="">{tool.id === "dub" ? "No audio or video originals in this project" : "No audio originals in this project"}</option>}
              {sources.map((a) => (
                <option key={a.id} value={a.id}>
                  {sourceLabel(a)}
                </option>
              ))}
            </select>
          </label>
        )}
        {tool?.id === "voiceChange" && (
          <>
            <VoicePicker voices={voices} voiceId={voiceId} disabled={disabled || voicesBusy} busy={voicesBusy} onChange={(id) => setVoiceId(id)} onRefresh={refreshVoices} />
            <label>
              Result
              <select aria-label="Voice change result" value={replaceClipId} disabled={disabled} onChange={(e) => setReplaceClipId(e.target.value)}>
                <option value="">Add a dialogue clip at the playhead</option>
                {replaceable.map((c) => {
                  const index = audioClips(project).findIndex((clip) => clip.id === c.id) + 1;
                  return (
                    <option key={c.id} value={c.id}>
                      Replace sound clip {index} at {timecodeOf(c.startFrame, project.fps)}
                    </option>
                  );
                })}
              </select>
            </label>
            <label className={styles.check}>
              <input type="checkbox" checked={removeNoise} disabled={disabled} onChange={(e) => setRemoveNoise(e.target.checked)} />
              Remove background noise
            </label>
          </>
        )}
        {tool?.id === "dub" && (
          <>
            <label>
              From
              <select aria-label="Source language" value={sourceLang} disabled={disabled} onChange={(e) => setSourceLang(e.target.value)}>
                <option value={DUBBING_SOURCE_AUTO}>Detect the language</option>
                {DUBBING_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Into
              <select aria-label="Target language" value={targetLang} disabled={disabled} onChange={(e) => setTargetLang(e.target.value)}>
                {DUBBING_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mode
              <select aria-label="Dub mode" value={mode} disabled={disabled} onChange={(e) => setMode(e.target.value)}>
                {DUBBING_MODE_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.note}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {task === "speech" && (
          <>
            <VoicePicker voices={speechVoices} voiceId={speechVoiceId} disabled={disabled || voicesBusy} busy={voicesBusy} onChange={(id) => (grokSpeech ? setGrokVoiceId(id) : setVoiceId(id))} onRefresh={() => (grokSpeech ? void loadGrokVoices(true) : refreshVoices())} />
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
        {!tool && task !== "speech" && (
          <label>
            Length · seconds
            <NumberDraftInput
              aria-label="Length in seconds"
              min={bounds.min}
              max={bounds.max}
              step={bounds.step}
              value={seconds[genTask]}
              disabled={disabled}
              onCommit={(value) => setSeconds((s) => ({ ...s, [genTask]: value }))}
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
        {!tool && (
          <label>
            Lane
            <select aria-label="Sound lane" value={lane} disabled={disabled} onChange={(e) => setLane(e.target.value as SoundLane)}>
              <option value="dialogue">Dialogue</option>
              <option value="sfx">SFX</option>
              <option value="music">Music</option>
            </select>
          </label>
        )}
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
              ? `Recover submitted ${(tool ? tool.label : def.label).toLowerCase()} · ${pending.credits} cr`
              : cost != null && ready
                ? `${tool ? tool.label : `Generate ${def.label.toLowerCase()}`} · ${cost} cr`
                : tool ? tool.label : `Generate ${def.label.toLowerCase()}`}
        </button>
        <span className={styles.hint}>
          {tool?.id === "voiceChange"
            ? `${replaceClipId ? "Replaces the chosen dialogue clip in place." : `Lands on the Dialogue lane at ${timecodeOf(frame, project.fps)}.`} Per started minute of the source${quote?.key === bodyKey && quote.minutes ? ` · ${quote.minutes} min` : ""}.`
            : tool?.id === "dub"
              ? `Lands on the Dialogue lane at ${timecodeOf(frame, project.fps)} when the vendor is done. ${DUBBING_MODE_OPTIONS.find((m) => m.id === mode)?.label ?? "Standard"} mode, one language (${dubbingLanguageLabel(targetLang)}), per started minute of the source${quote?.key === bodyKey && quote.minutes ? ` · ${quote.minutes} min` : ""}.`
              : `Lands on the ${laneName(lane)} lane at ${timecodeOf(frame, project.fps)}.${task === "speech" ? " Per character." : task === "sound" ? " One price per effect, up to 30 s." : " Per minute, 10 s to 5 min."}`}
        </span>
      </div>
      {voicesError && (task === "speech" || tool?.id === "voiceChange") && (
        <p className={styles.note}>Voices: {voicesError}</p>
      )}
      {placements.length > 0 && (
        <ul className={styles.queue} aria-label="Sound in progress">
          {placements.map((p) => {
            const job = jobs.find((j) => j.id === p.jobId);
            const word = job?.status === "held" ? "held for credits" : (job?.params?.task === "dub" && dubbingWord(job.params.dubbingStatus)) || job?.status || "queued";
            return (
              <li key={p.jobId} data-sound-progress={p.task}>
                <strong>{p.label}</strong> · {p.replaceClipId ? "replaces its dialogue clip" : `${laneName(p.lane)} lane at ${timecodeOf(p.startFrame, project.fps)}`} · {word}
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
