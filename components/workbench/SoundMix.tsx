"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  audioClips,
  audioFingerprint,
  encodeWav,
  type AudioClip,
} from "@/lib/workbench/audio";
import { safeName, uid, type Project } from "@/lib/workbench/studio";
import { downloadFile } from "@/lib/workbench/studio-export";
import styles from "./SoundMix.module.css";

export function SoundMix({
  project,
  frame,
  playing,
  onChange,
  onPause,
  onUpload,
}: {
  project: Project;
  frame: number;
  playing: boolean;
  onChange: (fn: (p: Project) => Project) => void;
  onPause: () => void;
  onUpload: () => void;
}) {
  const [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [result, setResult] = useState<{
    key: string;
    buffer: AudioBuffer;
    gain: number;
  } | null>(null);
  const audioContext = useRef<AudioContext | null>(null),
    source = useRef<AudioBufferSourceNode | null>(null),
    controller = useRef<AbortController | null>(null);
  const playback = useRef({ at: 0, offset: 0 }),
    latestFrame = useRef(frame);
  const fingerprint = useMemo(() => audioFingerprint(project), [project]),
    latestKey = useRef(fingerprint);
  useLayoutEffect(() => {
    latestFrame.current = frame;
    latestKey.current = fingerprint;
  }, [frame, fingerprint]);
  const clips = useMemo(() => audioClips(project), [project]),
    total = project.shots.reduce((n, s) => n + s.duration, 0);
  const ready = result?.key === fingerprint ? result : null;
  const stop = useCallback(() => {
    source.current?.stop();
    source.current?.disconnect();
    source.current = null;
  }, []);
  const start = useCallback(
    (buffer: AudioBuffer, offset: number) => {
      const context = audioContext.current;
      if (!context || context.state !== "running" || offset >= buffer.duration)
        return;
      stop();
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      playback.current = { at: context.currentTime, offset };
      node.start(0, Math.max(0, offset));
      source.current = node;
    },
    [stop],
  );
  useEffect(
    () => () => {
      controller.current?.abort();
      stop();
      void audioContext.current?.close();
    },
    [stop],
  );
  useEffect(() => {
    if (playing && ready)
      start(ready.buffer, latestFrame.current / project.fps);
    else stop();
    return stop;
  }, [playing, ready, project.fps, start, stop]);
  useEffect(() => {
    const context = audioContext.current;
    if (playing && ready && context && source.current) {
      const actual =
        playback.current.offset + context.currentTime - playback.current.at;
      if (Math.abs(actual - frame / project.fps) > 0.1)
        start(ready.buffer, frame / project.fps);
    }
  }, [frame, playing, ready, project.fps, start]);
  function update(id: string, patch: Partial<AudioClip>) {
    setError("");
    onPause();
    onChange((p) => ({
      ...p,
      audioAssetId: undefined,
      audioClips: audioClips(p).map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    }));
  }
  async function prepare() {
    if (controller.current) return;
    onPause();
    setError("");
    setBusy(true);
    setResult(null);
    const request = new AbortController();
    controller.current = request;
    const key = fingerprint;
    try {
      audioContext.current ??= new AudioContext({ sampleRate: 48000 });
      await audioContext.current.resume();
      const { prepareAudioMix } = await import("@/lib/workbench/mix-audio");
      const mix = await prepareAudioMix(project, request.signal);
      request.signal.throwIfAborted();
      if (latestKey.current !== key)
        throw new Error("The edit changed. Prepare its updated mix.");
      if (!mix.buffer)
        throw new Error(
          "No audible source was found. Add audio or enable original clip audio.",
        );
      setResult({ key, buffer: mix.buffer, gain: mix.gain });
    } catch (cause) {
      if (!request.signal.aborted) setError((cause as Error).message);
    } finally {
      if (controller.current === request) {
        controller.current = null;
        setBusy(false);
      }
    }
  }
  function wav(format: "pcm24" | "float32") {
    if (!ready) return;
    try {
      const data = encodeWav(
        [ready.buffer.getChannelData(0), ready.buffer.getChannelData(1)],
        48000,
        format,
      );
      downloadFile(
        new Blob([data], { type: "audio/wav" }),
        safeName(project.name) + `_mix_48k_${format}.wav`,
      );
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  return (
    <section className={styles.panel} aria-label="Sound mix">
      <header>
        <div>
          <span className="eyebrow">SOUND MIX</span>
          <h3>Dialogue, music & effects</h3>
        </div>
        <button className="btn" onClick={onUpload}>
          Upload audio
        </button>
      </header>
      <div className={styles.add}>
        <select
          aria-label="Audio source"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Choose a production asset</option>
          {project.assets
            .filter((a) => a.kind === "audio" || a.kind === "video")
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
        <button
          className="btn"
          disabled={!selected || !total || clips.length >= 64 || busy}
          onClick={() => {
            onPause();
            onChange((p) => ({
              ...p,
              audioAssetId: undefined,
              audioClips: [
                ...audioClips(p),
                {
                  id: uid("audio"),
                  assetId: selected,
                  lane: "music",
                  startFrame: 0,
                  sourceIn: 0,
                  duration: Math.min(total, p.fps),
                  gainDb: 0,
                  pan: 0,
                  fadeIn: 0,
                  fadeOut: 0,
                  muted: false,
                  solo: false,
                },
              ],
            }));
          }}
        >
          Add sound clip
        </button>
      </div>
      <label className={styles.inline}>
        <input
          type="checkbox"
          checked={project.clipAudio !== false}
          onChange={(e) => {
            onPause();
            onChange((p) => ({ ...p, clipAudio: e.target.checked }));
          }}
        />
        Original clip audio
      </label>
      {!clips.length && (
        <p>
          Add uploaded or generated sound. Each clip has independent timing and
          mix controls.
        </p>
      )}
      <div className={styles.clips}>
        {clips.map((clip, index) => (
          <fieldset
            key={clip.id}
            className={styles.clip}
            disabled={busy}
            aria-label={`Sound clip ${index + 1}`}
          >
            <legend>
              {project.assets.find((a) => a.id === clip.assetId)?.name ||
                "Missing source"}
            </legend>
            <div className={styles.track}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <select
                aria-label="Sound lane"
                value={clip.lane}
                onChange={(e) =>
                  update(clip.id, { lane: e.target.value as AudioClip["lane"] })
                }
              >
                <option value="dialogue">Dialogue</option>
                <option value="music">Music</option>
                <option value="sfx">SFX</option>
              </select>
              <label>
                <input
                  type="checkbox"
                  checked={clip.muted}
                  onChange={(e) => update(clip.id, { muted: e.target.checked })}
                />
                Mute
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={clip.solo}
                  onChange={(e) => update(clip.id, { solo: e.target.checked })}
                />
                Solo
              </label>
              <button
                className="btn"
                onClick={() => {
                  onPause();
                  onChange((p) => ({
                    ...p,
                    audioAssetId: undefined,
                    audioClips: audioClips(p).filter((c) => c.id !== clip.id),
                  }));
                }}
              >
                Remove clip
              </button>
            </div>
            <div className={styles.controls}>
              {(
                [
                  ["startFrame", "Timeline start", 0, 21600000],
                  ["sourceIn", "Source in", 0, 21600000],
                  ["duration", "Duration", 1, 216000],
                  ["fadeIn", "Fade in", 0, clip.duration - clip.fadeOut],
                  ["fadeOut", "Fade out", 0, clip.duration - clip.fadeIn],
                  ["gainDb", "Gain (dB)", -60, 12],
                  ["pan", "Pan", -1, 1],
                ] as const
              ).map(([key, label, min, max]) => (
                <label key={key}>
                  {label}
                  {[
                    "startFrame",
                    "sourceIn",
                    "duration",
                    "fadeIn",
                    "fadeOut",
                  ].includes(key)
                    ? " (frames)"
                    : ""}
                  <input
                    type="number"
                    aria-label={label}
                    value={clip[key]}
                    min={min}
                    max={max}
                    step={key === "pan" ? 0.1 : 1}
                    onChange={(e) => {
                      const n = e.target.valueAsNumber;
                      if (!Number.isFinite(n) || n < min || n > max) return;
                      const value = key === "pan" ? n : Math.round(n);
                      update(
                        clip.id,
                        key === "duration"
                          ? {
                              duration: value,
                              fadeIn: Math.min(clip.fadeIn, value),
                              fadeOut: Math.min(
                                clip.fadeOut,
                                Math.max(0, value - clip.fadeIn),
                              ),
                            }
                          : { [key]: value },
                      );
                    }}
                  />
                </label>
              ))}
            </div>
            <div className={styles.placement} aria-label="Sound clip placement">
              <span
                style={{
                  left: `${Math.min(100, (clip.startFrame / Math.max(1, total)) * 100)}%`,
                  width: `${Math.max(0, Math.min(100, (clip.duration / Math.max(1, total)) * 100, 100 - (clip.startFrame / Math.max(1, total)) * 100))}%`,
                }}
              />
              {clip.startFrame + clip.duration > total && (
                <small>Clip exceeds the edit</small>
              )}
            </div>
          </fieldset>
        ))}
      </div>
      <div className={styles.actions}>
        <button
          className="btn primary"
          onClick={() => void prepare()}
          disabled={busy || !total}
        >
          {busy ? "Preparing mix…" : ready ? "Rebuild mix" : "Prepare mix"}
        </button>
        {busy && (
          <button className="btn" onClick={() => controller.current?.abort()}>
            Cancel
          </button>
        )}
        <button className="btn" disabled={!ready} onClick={() => wav("pcm24")}>
          WAV · 24-bit PCM
        </button>
        <button
          className="btn"
          disabled={!ready}
          onClick={() => wav("float32")}
        >
          WAV · 32-bit float
        </button>
      </div>
      {ready ? (
        <p role="status">
          Mix ready · {ready.buffer.duration.toFixed(2)}s · use timeline Play
          and scrub.
          {ready.gain < 1
            ? ` Peak protection reduced the entire mix by ${(-20 * Math.log10(ready.gain)).toFixed(1)} dB.`
            : ""}
        </p>
      ) : (
        <p>
          Prepare after editing to hear sound with the timeline. 48 kHz stereo ·
          up to 3 minutes / 200 MB. Movie export uses these saved controls.
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </section>
  );
}
