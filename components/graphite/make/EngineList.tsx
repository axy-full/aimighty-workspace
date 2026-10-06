"use client";
import { spendAttrsOf } from "@/lib/spend";
import { useState } from "react";
import { DEFAULT_ENHANCER, ENHANCER_LABEL } from "@/lib/shell/enhancer";
import { exact } from "@/lib/shell/price-words";
import { CINEMA_BANK } from "@/lib/workspace/cinema-vocabulary";
import { AUDIO_SECONDS, TAKES_MAX, draftOffered, soundOffered, stepAudioSeconds } from "@/lib/workspace/composer";
import { FilmChips } from "../FilmVocabulary";
import { Price } from "../Price";
import type { MakeModel } from "./use-make";

/* The lengths the Change frame draws as chips; an engine's other lengths are in Advanced. */
const DRAWN_LENGTHS = [4, 5, 6, 8, 10];
const TYPE_WORD = { video: "Video", image: "Image", audio: "Audio" } as const;

/**
 * Change (the Change frame, `make=change`): this type's engines, each priced where the composer stands, the one in use
 * tinted; for video, the drawn lengths. What a sound needs to be priced (a voice, a length) sits under the engines. Then
 * Advanced, folded: every setting the handoff does not draw (README § 0 rule 2: advanced settings sit folded).
 */
export function EngineList({ make, id, scope }: { make: MakeModel; id: string; scope: string }) {
  const { state, model, settings, composer } = make;
  const [advanced, setAdvanced] = useState(false);
  const lengths = model?.durations ?? [];
  const chips = lengths.length ? [...new Set([...DRAWN_LENGTHS.filter((d) => lengths.includes(d)), settings.duration])].sort((a, b) => a - b) : [];
  return (
    <div className="gx-mk-list" id={id} aria-busy={make.readingRates || undefined} data-testid="make-engines">
      {make.offered.length ? (
        <div className="gx-mk-rows" role="group" aria-label={`${TYPE_WORD[state.type]} engines`}>
          {make.offered.map((m) => {
            const row = make.rowValue(m);
            return (
              <button key={m.id} type="button" className="gx-mk-row" aria-pressed={m.id === model?.id} onClick={() => make.pickEngine(m)} data-testid="make-engine-row" data-engine={m.id}>
                <span className="gx-mk-row-text">
                  <span className="gx-mk-row-name">{m.label}</span>
                  {m.description ? <span className="gx-mk-row-sub">{m.description}</span> : null}
                </span>
                <span className="gx-mk-row-price" title={row.value ? undefined : row.title}><Price value={row.value} /></span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="gx-mk-line-note" role="status">{make.readingModels ? "Reading the engines…" : composer.blocked ?? `No ${TYPE_WORD[state.type].toLowerCase()} engine is connected here.`}</p>
      )}
      {chips.length > 1 && state.type === "video" ? (
        <div className="gx-mk-chips" role="group" aria-label="Length">
          {chips.map((d) => (
            <button key={d} type="button" className="gx-chip" aria-pressed={settings.duration === d} onClick={() => composer.dispatch({ type: "pick", value: { duration: d } })} data-testid="make-length">{d} s</button>
          ))}
        </div>
      ) : null}
      {model?.audioTask === "speech" ? (
        <label className="gx-mk-field">
          <span className="gx-mk-eyebrow">Voice</span>
          <select className="gx-select" value={composer.voice?.id ?? ""} onChange={(e) => composer.dispatch({ type: "voice", value: e.target.value })} data-testid="gen-voice">
            {composer.voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
      ) : null}
      {make.soundTask ? (
        <div className="gx-mk-field">
          <span className="gx-mk-eyebrow" id="gx-mk-seconds">Length</span>
          <div className="gx-mk-inline">
            <div className="gx-stepper" role="group" aria-labelledby="gx-mk-seconds" data-testid="gen-seconds">
              <button type="button" aria-label="Shorter" disabled={composer.seconds <= AUDIO_SECONDS[make.soundTask].min} onClick={() => composer.dispatch({ type: "seconds", value: stepAudioSeconds(make.soundTask!, composer.seconds, -1), task: make.soundTask! })}>–</button>
              <span aria-live="polite" data-testid="gen-seconds-value">{composer.seconds} s</span>
              <button type="button" aria-label="Longer" disabled={composer.seconds >= AUDIO_SECONDS[make.soundTask].max} onClick={() => composer.dispatch({ type: "seconds", value: stepAudioSeconds(make.soundTask!, composer.seconds, 1), task: make.soundTask! })}>+</button>
            </div>
            {make.soundTask === "music" ? (
              <button type="button" className="gx-toggle" role="switch" aria-checked={state.instrumental} onClick={() => composer.dispatch({ type: "instrumental", value: !state.instrumental })} data-testid="gen-instrumental">
                <span className="gx-toggle-dot" aria-hidden="true" /><span>Instrumental</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <button type="button" className="gx-mk-fold" aria-expanded={advanced} aria-controls={`${id}-advanced`} onClick={() => setAdvanced(!advanced)} data-testid="make-advanced-toggle">
        <span>Advanced</span><span className="gx-mk-fold-mark" aria-hidden="true">{advanced ? "–" : "+"}</span>
      </button>
      {advanced ? <Advanced make={make} id={`${id}-advanced`} scope={scope} lengths={lengths.filter((d) => !chips.includes(d)).length ? lengths : []} /> : null}
    </div>
  );
}

/** Advanced, folded under Change: the settings the handoff does not draw, each as today's composer offers it. */
function Advanced({ make, id, scope, lengths }: { make: MakeModel; id: string; scope: string; lengths: number[] }) {
  const { state, model, settings, composer, enhancer } = make;
  const set = composer.dispatch;
  return (
    <div className="gx-mk-advanced" id={id} data-testid="make-advanced">
      {model?.resolutions?.length && model.resolutions.length > 1 ? (
        <div className="gx-mk-field">
          <span className="gx-mk-eyebrow">Resolution</span>
          <div className="gx-mk-chips" role="group" aria-label="Resolution">
            {model.resolutions.map((r) => (
              <button key={r} type="button" className="gx-chip" aria-pressed={settings.resolution === r} disabled={Boolean(settings.draft) && r !== settings.resolution}
                title={settings.draft && r !== settings.resolution ? "A draft is 480p; its final is 1080p." : undefined} onClick={() => set({ type: "pick", value: { resolution: r } })}>{r}</button>
            ))}
          </div>
        </div>
      ) : null}
      {model?.ratios?.length && model.ratios.length > 1 ? (
        <div className="gx-mk-field">
          <span className="gx-mk-eyebrow">Aspect</span>
          <div className="gx-mk-chips" role="group" aria-label="Aspect">
            {model.ratios.map((r) => <button key={r} type="button" className="gx-chip" aria-pressed={settings.ratio === r} onClick={() => set({ type: "pick", value: { ratio: r } })}>{r}</button>)}
          </div>
        </div>
      ) : null}
      {lengths.length ? (
        <label className="gx-mk-field">
          <span className="gx-mk-eyebrow">Length</span>
          <select className="gx-select" value={settings.duration} onChange={(e) => set({ type: "pick", value: { duration: Number(e.target.value) } })} data-testid="gen-length">
            {lengths.map((d) => <option key={d} value={d}>{d} s</option>)}
          </select>
        </label>
      ) : null}
      {state.type === "video" && draftOffered(model) ? (
        <div className="gx-mk-field" data-testid="gen-draft-option">
          <button type="button" className="gx-toggle" role="switch" aria-checked={Boolean(settings.draft)} onClick={() => set({ type: "pick", value: { draft: !settings.draft } })} data-testid="gen-draft-toggle">
            <span className="gx-toggle-dot" aria-hidden="true" /><span>Draft first · 480p</span>
          </button>
          {settings.draft ? <p className="gx-mk-line-note" data-testid="gen-draft-note">A watermarked draft at the 480p price. Make its 1080p final from it within seven days.</p> : null}
        </div>
      ) : null}
      {soundOffered(model) ? (
        <div className="gx-mk-field" data-testid="gen-sound-option">
          <button type="button" className="gx-toggle" role="switch" aria-checked={Boolean(settings.generateAudio)} onClick={() => set({ type: "pick", value: { generateAudio: !settings.generateAudio } })} data-testid="gen-sound-toggle">
            <span className="gx-toggle-dot" aria-hidden="true" /><span>With sound</span>
          </button>
        </div>
      ) : null}
      <div className="gx-mk-field" data-testid="gen-takes">
        <span className="gx-mk-eyebrow" id={`${id}-takes`}>{settings.draft ? "Takes · one draft at a time" : "Takes"}</span>
        <div className="gx-stepper" role="group" aria-labelledby={`${id}-takes`}>
          <button type="button" aria-label="Fewer" disabled={Boolean(settings.draft) || state.count <= 1} onClick={() => set({ type: "count", value: state.count - 1 })}>–</button>
          <span data-testid="gen-takes-count">{settings.draft ? 1 : state.count}</span>
          <button type="button" aria-label="More" disabled={Boolean(settings.draft) || state.count >= TAKES_MAX} onClick={() => set({ type: "count", value: state.count + 1 })}>+</button>
        </div>
      </div>
      {state.type !== "audio" ? (
        <div className="gx-mk-field">
          <span className="gx-mk-eyebrow">Shot</span>
          {make.cinemaModel
            ? <FilmChips key="cinema" scope={scope} type={state.type} setup={state.cinema} onChange={make.setCinema} bank={CINEMA_BANK} testId="gen-cinema" />
            : <FilmChips key="film" scope={scope} type={state.type} setup={state.shot} onChange={make.setShot} />}
        </div>
      ) : null}
      <div className="gx-mk-field">
        <span className="gx-mk-eyebrow">Words</span>
        <div className="gx-mk-inline">
          <button type="button" className="gx-toggle" role="switch" aria-checked={enhancer.auto} onClick={() => enhancer.setAuto(!enhancer.auto)} title="With an enhancement on the card, it is what Make sends." data-testid="enhance-auto">
            <span className="gx-toggle-dot" aria-hidden="true" /><span>Auto</span>
          </button>
          <button type="button" className="gx-hbtn" disabled={Boolean(enhancer.blocked) || enhancer.busy} onClick={enhancer.enhance} aria-busy={enhancer.busy || undefined} data-testid="enhance" {...spendAttrsOf(exact(enhancer.credits))}>
            {enhancer.busy ? "Enhancing…" : enhancer.credits == null ? "Enhance" : <>Enhance · <Price value={exact(enhancer.credits)} /></>}
          </button>
        </div>
        {enhancer.blocked ? <p className="gx-mk-line-note" data-testid="enhance-reason">{enhancer.blocked}</p> : null}
        {enhancer.error ? <p className="gx-mk-error" role="alert">{enhancer.error}</p> : null}
        {enhancer.enhanced ? (
          <div className="gx-mk-enhanced" data-testid="enhanced-card">
            <span className="gx-mk-eyebrow">Enhanced · {ENHANCER_LABEL[enhancer.provider ?? DEFAULT_ENHANCER]}{enhancer.charged != null ? <> · <Price value={exact(enhancer.charged)} /></> : null}</span>
            <p>{enhancer.enhanced}</p>
            <div className="gx-mk-inline">
              <button type="button" className="gx-hbtn" onClick={() => { make.setPrompt(enhancer.enhanced!); enhancer.dismiss(); }} data-testid="enhanced-use">Use this</button>
              <button type="button" className="gx-hbtn" onClick={enhancer.dismiss} data-testid="enhanced-keep">Keep mine</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
