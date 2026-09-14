"use client";
import { GitBranch, Loader2 } from "lucide-react";
import {
  promptKey,
  publicationKey,
  type PipelineCatalog,
  type PipelineDraft,
  type PublicationChoice,
} from "@/lib/pipeline/editor";
import styles from "./pipeline.module.css";
export default function PipelineBuilder({
  catalog,
  publication,
  values,
  set,
  busy,
  voices,
  availableRatios,
  onCreate,
}: {
  catalog: PipelineCatalog;
  publication: PublicationChoice;
  values: PipelineDraft;
  set: (
    key: keyof PipelineDraft,
    value: PipelineDraft[keyof PipelineDraft],
  ) => void;
  busy: boolean;
  voices: { id: string; name: string }[];
  availableRatios: string[];
  onCreate: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onCreate();
      }}
    >
      <div className={styles.formGrid}>
        <label>
          Pipeline name
          <input
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={`${publication.name} pipeline`}
            maxLength={120}
          />
        </label>
        <label>
          Published context
          <select
            value={publicationKey(publication)}
            onChange={(e) => {
              set("publication", e.target.value);
              set("prompt", "");
              set("reference", "");
            }}
          >
            {catalog.publications.map((p) => (
              <option key={publicationKey(p)} value={publicationKey(p)}>
                {p.name} · published v{p.version}
              </option>
            ))}
          </select>
        </label>
        <label>
          Final output
          <select
            value={values.output}
            onChange={(e) => set("output", e.target.value)}
          >
            <option value="video">Keyframes → selected take → video</option>
            <option value="image">Image options → selected take</option>
            <option value="audio">Audio</option>
          </select>
        </label>
        <label>
          Published prompt
          <select
            value={
              values.prompt ||
              promptKey(
                publication.prompts[0] ?? {
                  source: "brief",
                  label: "",
                  preview: "",
                },
              )
            }
            onChange={(e) => set("prompt", e.target.value)}
          >
            {publication.prompts.map((p) => (
              <option key={promptKey(p)} value={promptKey(p)}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={styles.contextPreview}>
        {
          (
            publication.prompts.find((p) => promptKey(p) === values.prompt) ??
            publication.prompts[0]
          )?.preview
        }
      </p>
      {values.output !== "audio" && (
        <fieldset>
          <legend>Images and motion</legend>
          <div className={styles.formGrid}>
            {(
              ["image", ...(values.output === "video" ? ["video"] : [])] as (
                "image" | "video"
              )[]
            ).map((kind) => {
              const model =
                catalog.models.find(
                  (m) => m.id === values[`${kind}Model`] && m.kind === kind,
                ) ??
                catalog.models.find((m) => m.kind === kind && m.configured);
              return (
                <div key={kind}>
                  <label>
                    {kind === "image" ? "Image engine" : "Video engine"}
                    <select
                      aria-label={
                        kind === "image" ? "Image engine" : "Video engine"
                      }
                      value={model?.id ?? ""}
                      onChange={(e) => {
                        set(`${kind}Model`, e.target.value);
                        set(`${kind}Resolution`, "");
                        const next = catalog.models.find(
                          (m) => m.id === e.target.value,
                        );
                        if (kind === "video" && next?.durations.length)
                          set(
                            "duration",
                            next.durations.includes(5) ? 5 : next.durations[0],
                          );
                      }}
                    >
                      <option value="" disabled>
                        Choose an engine
                      </option>
                      {catalog.models
                        .filter((m) => m.kind === kind)
                        .map((m) => (
                          <option
                            key={m.id}
                            value={m.id}
                            disabled={!m.configured}
                          >
                            {m.label}
                            {m.configured ? "" : " · not connected"}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Resolution
                    <select
                      value={
                        values[`${kind}Resolution`] ||
                        model?.resolutions[0] ||
                        ""
                      }
                      onChange={(e) => set(`${kind}Resolution`, e.target.value)}
                    >
                      {model?.resolutions.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </label>
                </div>
              );
            })}
            <label>
              Aspect
              <select
                value={values.ratio}
                onChange={(e) => set("ratio", e.target.value)}
              >
                {availableRatios.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <label>
              Image options
              <select
                value={values.variants}
                onChange={(e) => set("variants", Number(e.target.value))}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n} {n === 1 ? "take" : "takes"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Clip duration (seconds)
              {values.output === "video" ? (
                <select
                  value={values.duration}
                  onChange={(e) => set("duration", Number(e.target.value))}
                >
                  {catalog.models
                    .find((m) => m.id === values.videoModel)
                    ?.durations.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                </select>
              ) : (
                <input
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  value={values.duration}
                  onChange={(e) => set("duration", Number(e.target.value))}
                />
              )}
            </label>
            <label>
              Published image reference
              <select
                value={values.reference}
                onChange={(e) => set("reference", e.target.value)}
              >
                <option value="">No reference</option>
                {publication.assets
                  .filter((a) => a.kind === "image")
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </fieldset>
      )}
      <fieldset>
        <legend>Sound</legend>
        <div className={styles.formGrid}>
          <label>
            Audio stage
            <select
              value={
                values.output === "audio" && values.audio === "none"
                  ? "sound"
                  : values.audio
              }
              onChange={(e) => set("audio", e.target.value)}
            >
              {values.output !== "audio" && (
                <option value="none">No separate audio</option>
              )}
              <option value="speech">Speech</option>
              <option value="sound">Sound effect</option>
              <option value="music">Music</option>
            </select>
          </label>
          {(values.audio !== "none" || values.output === "audio") && (
            <>
              <label>
                Published audio text
                <select
                  value={
                    values.audioPrompt ||
                    values.prompt ||
                    promptKey(
                      publication.prompts[0] ?? {
                        source: "brief",
                        label: "",
                        preview: "",
                      },
                    )
                  }
                  onChange={(e) => set("audioPrompt", e.target.value)}
                >
                  {publication.prompts.map((p) => (
                    <option key={promptKey(p)} value={promptKey(p)}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              {values.audio === "speech" ? (
                <>
                  <label>
                    Speech model
                    <select
                      value={
                        values.speechModel || catalog.audioModels.speech[0]?.id
                      }
                      onChange={(e) => set("speechModel", e.target.value)}
                    >
                      {catalog.audioModels.speech.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Voice
                    <select
                      value={values.voiceId}
                      onChange={(e) => set("voiceId", e.target.value)}
                    >
                      <option value="">Choose a voice</option>
                      {voices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <label>
                  Audio duration (seconds)
                  <input
                    type="number"
                    min={values.audio === "music" ? 10 : 0.5}
                    max={values.audio === "music" ? 180 : 30}
                    step={0.5}
                    value={values.audioSeconds}
                    onChange={(e) =>
                      set("audioSeconds", Number(e.target.value))
                    }
                  />
                </label>
              )}
            </>
          )}
        </div>
      </fieldset>
      <p className={styles.note}>
        Creating a run spends no credits. Each ready generation stage gets an
        exact quote and a separate approval. Later stages wait for resolved
        inputs; no whole-run charge is authorized.
      </p>
      <button
        className={styles.primary}
        disabled={busy || !publication.prompts.length}
        type="submit"
      >
        {busy ? <Loader2 size={16} /> : <GitBranch size={16} />} Create private
        run
      </button>
    </form>
  );
}
