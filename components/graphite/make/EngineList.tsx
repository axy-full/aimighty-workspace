"use client";
import { useState } from "react";
import { DEFAULT_ENHANCER, ENHANCER_LABEL } from "@/lib/shell/enhancer";
import { exact } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import { CINEMA_BANK } from "@/lib/workspace/cinema-vocabulary";
import { AUDIO_SECONDS, TAKES_MAX, draftOffered, shownTotal, soundOffered, stepAudioSeconds } from "@/lib/workspace/composer";
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
  const { state, model, settings, composer, enhancer } = make;
  const [advanced, setAdvanced] = useState(false);
  /* What a closed Advanced is holding that differs from the plain default, said on its line, so nothing that changes what is made hides. */
  const advancedNotes = [
    !settings.draft && state.count > 1 ? `${state.count} takes` : null,
    settings.draft ? "Draft" : null,
    settings.generateAudio ? "With sound" : null,
    enhancer.auto ? "Auto enhance" : null,
    make.soundTask === "music" && state.instrumental ? "Instrumental" : null,
  ].filter(Boolean) as string[];
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
          <span className="gx-mk-eyebrow" id="gx-mk-seconds">{make.soundTask === "music" ? "Music length" : "Length"}</span>
          <div className="gx-mk-inline">
            {make.soundTask === "music" ? (
              <div className="gx-mk-chips" role="group" aria-labelledby="gx-mk-seconds" data-testid="gen-seconds">
                {[...new Set([...MUSIC_LENGTHS.filter((n) => n >= AUDIO_SECONDS.music.min && n <= AUDIO_SECONDS.music.max), composer.seconds])].sort((x, y) => x - y).map((n) => (
                  <button key={n} type="button" className="gx-chip" aria-pressed={composer.seconds === n} onClick={() => composer.dispatch({ type: "seconds", value: n, task: "music" })} data-testid="make-music-chip">{composer.seconds === n ? "✓ " : ""}{n} s</button>
                ))}
                <span data-testid="gen-seconds-value" hidden>{composer.seconds} s</span>
              </div>
            ) : (
            <div className="gx-stepper" role="group" aria-labelledby="gx-mk-seconds" data-testid="gen-seconds">
                <button type="button" aria-label="Shorter" disabled={composer.seconds <= AUDIO_SECONDS[make.soundTask].min} onClick={() => composer.dispatch({ type: "seconds", value: stepAudioSeconds(make.soundTask!, composer.seconds, -1), task: make.soundTask! })}>–</button>
              <span aria-live="polite" data-testid="gen-seconds-value">{composer.seconds} s</span>
              <button type="button" aria-label="Longer" disabled={composer.seconds >= AUDIO_SECONDS[make.soundTask].max} onClick={() => composer.dispatch({ type: "seconds", value: stepAudioSeconds(make.soundTask!, composer.seconds, 1), task: make.soundTask! })}>+</button>
            </div>
            )}
            {make.soundTask === "music" ? (
              <button type="button" className="gx-toggle" role="switch" aria-checked={state.instrumental} onClick={() => composer.dispatch({ type: "instrumental", value: !state.instrumental })} data-testid="gen-instrumental">
                <span className="gx-toggle-dot" aria-hidden="true" /><span>Instrumental</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <button type="button" className="gx-mk-fold" aria-expanded={advanced} aria-controls={`${id}-advanced`} onClick={() => setAdvanced(!advanced)} data-testid="make-advanced-toggle">
        <span>Advanced</span>{!advanced && advancedNotes.length ? <span className="gx-mk-fold-notes" data-testid="make-advanced-notes">{advancedNotes.join(" · ")}</span> : null}<span className="gx-mk-fold-mark" aria-hidden="true">{advanced ? "–" : "+"}</span>
      </button>
      {advanced ? <Advanced make={make} id={`${id}-advanced`} scope={scope} lengths={lengths.filter((d) => !chips.includes(d)).length ? lengths : []} /> : null}
    </div>
  );
}

/** Music is asked in whole lengths; the frame draws these three (each is inside the engine's 10 s to 5 min). */
const MUSIC_LENGTHS = [15, 30, 60];
/** What Sound can be: a voice, music, or effects, each the offered engine that does it. */
const SOUND_KINDS = [{ task: "speech", label: "Voice" }, { task: "music", label: "Music" }, { task: "sound", label: "Effects" }] as const;
const TAKE_CHOICES = [1, 2, 3, 4];

function Row({ name, value, testId }: { name: string; value: React.ReactNode; testId?: string }) {
  return <div className="gx-mk-row2" data-testid={testId}><span className="gx-mk-row2-name">{name}</span><span className="gx-mk-row2-value">{value}</span></div>;
}

/**
 * Advanced, folded under Change: everything Make can set beyond the words and the engine, in the order the Make details
 * frames draw it (Gaps B): what the brief already set, the shot's film chips, Enhance with Auto, the settings (aspect, draft,
 * resolution, length, sound), the number of takes with each total, and for audio the voice, the sound kind and the music length.
 * Each is today's composer setting; nothing here prices anything of its own: the figures are the composer's quote and the enhancer's.
 */
function Advanced({ make, id, scope, lengths }: { make: MakeModel; id: string; scope: string; lengths: number[] }) {
  const { state, model, settings, composer, enhancer } = make;
  const set = composer.dispatch;
  const project = composer.project;
  const audio = state.type === "audio";
  const takes = settings.draft ? 1 : state.count;
  const choices = TAKE_CHOICES.includes(takes) ? TAKE_CHOICES : [...TAKE_CHOICES, takes].sort((a, b) => a - b);
  const enhanceNote = !enhancer.auto ? "off"
    : make.autoNeeds ? (make.enhanceCredits != null ? <>on · <Price value={exact(make.enhanceCredits)} /> in the figure</> : "on · pricing")
    : enhancer.enhanced ? "on · uses the enhancement below" : "off here";
  return (
    <div className="gx-mk-advanced" id={id} data-testid="make-advanced">
      {project && (project.aspect || project.fps) ? (
        <div className="gx-mk-field" data-testid="make-from-brief">
          <span className="gx-mk-eyebrow">From the brief<span className="gx-mk-note"> · set once, used everywhere</span></span>
          <div className="gx-mk-chips" role="list" aria-label="From the brief">
            {project.aspect ? <span role="listitem" className="gx-chip" data-static="">{project.aspect}</span> : null}
            {project.fps ? <span role="listitem" className="gx-chip" data-static="">{project.fps} fps</span> : null}
          </div>
        </div>
      ) : null}

      {!audio ? (
        <div className="gx-mk-field" data-testid="make-shot-control">
          <span className="gx-mk-eyebrow">Shot control<span className="gx-mk-note"> · one per row, Auto until picked</span></span>
          {make.cinemaModel
            ? <FilmChips key="cinema" scope={scope} type={state.type} setup={state.cinema} onChange={make.setCinema} bank={CINEMA_BANK} testId="gen-cinema" />
            : <FilmChips key="film" scope={scope} type={state.type} setup={state.shot} onChange={make.setShot} />}
        </div>
      ) : null}

      {/* The sample workspace spends nothing: Enhance is not offered there (the owner's switch). */}
      {make.spendOff ? null : <div className="gx-mk-field" data-testid="make-enhance">
        <span className="gx-mk-eyebrow">Enhance</span>
        <Row name="Auto · enhance first" value={enhanceNote} testId="enhance-auto-state" />
        <div className="gx-mk-inline">
          <button type="button" className="gx-toggle" role="switch" aria-checked={enhancer.auto} onClick={() => enhancer.setAuto(!enhancer.auto)} title="With Auto on, Make enhances the words first and the button's figure includes it." data-testid="enhance-auto">
            <span className="gx-toggle-dot" aria-hidden="true" /><span>Auto</span>
          </button>
          <button type="button" className="gx-hbtn" disabled={Boolean(enhancer.blocked) || enhancer.busy} {...(enhancer.credits == null ? {} : spendAttrsOf(exact(enhancer.credits)))} onClick={enhancer.enhance} aria-busy={enhancer.busy || undefined} data-testid="enhance">
            {enhancer.busy ? "Enhancing…" : enhancer.credits == null ? "Enhance now" : <>Enhance now · <Price value={exact(enhancer.credits)} /></>}
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
      </div>}

      {audio ? (
        <div className="gx-mk-field" data-testid="make-voice">
          <span className="gx-mk-eyebrow">Voice</span>
          {model?.audioTask === "speech" && composer.voice ? <Row name="Voice" value={composer.voice.name} testId="make-voice-name" /> : null}
          {model ? <Row name="Model" value={model.label} /> : null}
        </div>
      ) : null}

      {audio ? (
        <div className="gx-mk-field" data-testid="make-sound-kind">
          <span className="gx-mk-eyebrow">Sound</span>
          <div className="gx-mk-chips" role="group" aria-label="Sound">
            {SOUND_KINDS.map(({ task, label }) => {
              const engine = make.offered.find((m) => m.audioTask === task);
              return engine ? (
                <button key={task} type="button" className="gx-chip" aria-pressed={model?.audioTask === task} onClick={() => set({ type: "model", value: engine.id })} data-testid={`make-sound-${task}`}>{model?.audioTask === task ? "✓ " : ""}{label}</button>
              ) : null;
            })}
          </div>
        </div>
      ) : null}

      {!audio ? (
        <div className="gx-mk-field" data-testid="make-settings">
          <span className="gx-mk-eyebrow">Settings</span>
          {model?.ratios?.length && model.ratios.length > 1 ? (
            <div className="gx-mk-chips" role="group" aria-label="Aspect">
              {model.ratios.map((r) => <button key={r} type="button" className="gx-chip" aria-pressed={settings.ratio === r} onClick={() => set({ type: "pick", value: { ratio: r } })}>{settings.ratio === r ? "✓ " : ""}{r}{r === project?.aspect ? " · from the brief" : ""}</button>)}
            </div>
          ) : settings.ratio ? <Row name="Aspect" value={`${settings.ratio}${settings.ratio === project?.aspect ? " · from the brief" : ""}`} /> : null}
          {state.type === "video" && draftOffered(model) ? (
            <div data-testid="gen-draft-option">
              <button type="button" className="gx-toggle" role="switch" aria-checked={Boolean(settings.draft)} onClick={() => set({ type: "pick", value: { draft: !settings.draft } })} data-testid="gen-draft-toggle">
                <span className="gx-toggle-dot" aria-hidden="true" /><span>Draft first · 480p</span>
              </button>
              {settings.draft ? <p className="gx-mk-line-note" data-testid="gen-draft-note">A watermarked draft at the 480p price. Make its 1080p final from it within seven days.</p> : null}
            </div>
          ) : null}
          {model?.resolutions?.length && model.resolutions.length > 1 ? (
            <div className="gx-mk-chips" role="group" aria-label="Resolution">
              {model.resolutions.map((r) => (
                <button key={r} type="button" className="gx-chip" aria-pressed={settings.resolution === r} disabled={Boolean(settings.draft) && r !== settings.resolution}
                  title={settings.draft && r !== settings.resolution ? "A draft is 480p; its final is 1080p." : undefined} onClick={() => set({ type: "pick", value: { resolution: r } })}>{settings.resolution === r ? "✓ " : ""}{r}</button>
              ))}
            </div>
          ) : null}
          {lengths.length ? (
            <label className="gx-mk-row2">
              <span className="gx-mk-row2-name">Length</span>
              <select className="gx-select" value={settings.duration} onChange={(e) => set({ type: "pick", value: { duration: Number(e.target.value) } })} data-testid="gen-length">
                {lengths.map((d) => <option key={d} value={d}>{d} s</option>)}
              </select>
            </label>
          ) : null}
          {soundOffered(model) ? (
            <div data-testid="gen-sound-option">
              <button type="button" className="gx-toggle" role="switch" aria-checked={Boolean(settings.generateAudio)} onClick={() => set({ type: "pick", value: { generateAudio: !settings.generateAudio } })} data-testid="gen-sound-toggle">
                <span className="gx-toggle-dot" aria-hidden="true" /><span>With sound</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="gx-mk-field" data-testid="gen-takes">
        <span className="gx-mk-eyebrow" id={`${id}-takes`}>{settings.draft ? "Takes · one draft at a time" : "Takes"}</span>
        <div className="gx-mk-chips" role="group" aria-labelledby={`${id}-takes`}>
          {choices.map((n) => {
            /* No totals in the sample workspace, where nothing is made. */
            const total = make.spendOff ? null : shownTotal(composer.quote, composer.quoteKey, n);
            return (
              <button key={n} type="button" className="gx-chip" aria-pressed={takes === n} disabled={Boolean(settings.draft) || n > TAKES_MAX} onClick={() => set({ type: "count", value: n })} data-testid={`gen-takes-${n}`}>
                {takes === n ? "✓ " : ""}×{n}{total != null ? <> · <Price value={exact(total)} /></> : null}
              </button>
            );
          })}
          <span className="gx-mk-note" data-testid="gen-takes-count" hidden>{takes}</span>
        </div>
      </div>
    </div>
  );
}
