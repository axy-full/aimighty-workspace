"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { Project } from "@/lib/workbench/studio";
import {
  BILLING_LABELS,
  COMPOSER_TYPES,
  TYPE_LABELS,
  type BillingSource,
  type ComposerType,
} from "@/lib/workspace/composer";
import { composerEyebrow, renderPrimaryLabel } from "@/lib/workspace/make";
import { useWorkspace } from "@/lib/workspace/state";
import { useComposer, type ComposerHost } from "@/lib/workspace/use-composer";
import type { MobilePrimary } from "./MobileActionBar";
import { MobileSheet } from "./MobileSheet";

/**
 * The phone's composer (05-mobile "Make (M4)": "The composer docks as a card
 * above the pinned `Render · 19 CR · 5s`").
 *
 * There is no second composer. This is a phone-shaped skin over the state
 * machine the global Generate composer runs on — `lib/workspace/use-composer.ts`
 * — so the phone gets the same model catalogue, the same debounced live quote,
 * the same quote-then-approve dispatch through
 * `lib/workspace/generate-submit.ts`, the same connected-account path through
 * `lib/higgsfield-consumer/generation-client.ts`, and the same billing switch
 * (this workspace's credits by default). The desktop overlay
 * (components/workspace/GenerateComposer.tsx) is a different skin over the
 * same host; neither owns the machine.
 *
 * Shape on a phone: the wall's segmented control IS the composer's type (one
 * vocabulary, CLAUDE.md rule 5), the docked card carries the eyebrow and the
 * first prompt line, tapping it opens the rest as a sheet on the same chrome,
 * and the pinned primary carries the live price.
 */

const MakeComposerContext = createContext<{ host: ComposerHost; open: boolean; setOpen: (open: boolean) => void } | null>(null);

export function useMakeComposer() {
  return useContext(MakeComposerContext);
}

export function MakeComposerProvider({
  scope,
  project,
  onProject,
  workspaceName,
  children,
}: {
  scope: string;
  project: Project | null;
  onProject: (projectId: string) => void;
  workspaceName: string | null;
  children: ReactNode;
}) {
  const ws = useWorkspace();
  const onMake = ws.state.mobile === "make";
  /* The composer only reads models, quotes and the connected account while the
     wall it belongs to is on screen; its state outlives the visit. */
  /* The wall opens on Video (05-mobile M4); the type is one control for both. */
  const host = useComposer({ scope, open: onMake, project, onProject, workspaceName, initialType: "video" });
  const [open, setOpen] = useState(false);
  /* The expansion belongs to the Make screen, so a level change closes it —
     adjusted during render (the documented reset-on-change pattern) rather
     than in an effect, which would paint the sheet over the next screen once. */
  const [level, setLevel] = useState(ws.state.mobile);
  if (level !== ws.state.mobile) {
    setLevel(ws.state.mobile);
    if (open) setOpen(false);
  }
  return (
    <MakeComposerContext.Provider value={{ host, open, setOpen }}>{children}</MakeComposerContext.Provider>
  );
}

/** Seconds on the button: an engine's own duration, or the sound length. */
function composerSeconds(host: ComposerHost): number | null {
  if (host.model?.audioTask) return host.state.seconds;
  if (!host.model?.durations?.length) return null;
  return host.settings.duration;
}

/** The pinned primary on Make: `Render · 19 CR · 5s`, or why it cannot run. */
export function makePrimary(host: ComposerHost): MobilePrimary {
  const { label, cost } = renderPrimaryLabel({ credits: host.credits, seconds: composerSeconds(host) });
  return {
    label: host.submitting ? "Submitting" : label,
    cost: host.submitting ? null : cost,
    blocked: host.blocked,
    run: host.generate,
  };
}

/* ── The docked card ──────────────────────────────────────────────────── */

export function MakeComposerCard() {
  const ctx = useMakeComposer();
  if (!ctx) return null;
  const { host, setOpen } = ctx;
  const eyebrow = composerEyebrow({
    model: host.model?.label ?? null,
    ratio: host.settings.ratio,
    resolution: host.settings.resolution,
    duration: host.model?.durations?.length ? host.settings.duration : null,
    seconds: host.state.seconds,
    audio: Boolean(host.model?.audioTask),
  });
  const line = host.state.prompt.trim();
  return (
    <button type="button" className="pxm-composer-dock" data-testid="mobile-composer-card" onClick={() => setOpen(true)}>
      <span className="pxm-composer-dock-inner">
        <span className="pxm-grow">
          <span className="pxm-composer-eyebrow" data-functional-label="">{eyebrow}</span>
          <span className="pxm-composer-line" data-empty={line ? undefined : ""}>
            {line || "Write what to make"}
          </span>
        </span>
        <span className="pxm-composer-open" aria-hidden="true">↑</span>
      </span>
    </button>
  );
}

/* ── The rest of it, on the sheet chrome ──────────────────────────────── */

export function MakeComposerSheet() {
  const ctx = useMakeComposer();
  if (!ctx || !ctx.open) return null;
  const { host, setOpen } = ctx;
  const audioTask = host.model?.audioTask;
  const wantsVoice = audioTask === "speech";
  const wantsSeconds = audioTask === "sound" || audioTask === "music";
  const { label, cost } = renderPrimaryLabel({ credits: host.credits, seconds: composerSeconds(host) });

  return (
    <MobileSheet
      title="Composer"
      sub={host.wording}
      testId="mobile-composer-sheet"
      onClose={() => setOpen(false)}
    >
      <div className="pxm-form">
        <span className="pxm-kicker" data-functional-label="">Type</span>
        <div className="pxm-segmented" role="group" aria-label="Output type">
          {COMPOSER_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className="pxm-segment"
              data-kind={type}
              data-on={host.state.type === type ? "" : undefined}
              aria-pressed={host.state.type === type}
              onClick={() => host.dispatch({ type: "type", value: type as ComposerType })}
            >
              {TYPE_LABELS[type]}
            </button>
          ))}
        </div>

        <label className="pxm-form-label" htmlFor="pxm-composer-model">Model</label>
        <select
          id="pxm-composer-model"
          className="pxm-select"
          data-testid="mobile-composer-model"
          value={host.model?.id ?? ""}
          disabled={host.submitting || !host.offered.length}
          onChange={(event) => host.dispatch({ type: "model", value: event.target.value })}
        >
          {host.offered.length ? null : <option value="">No model available</option>}
          {host.offered.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>

        <label className="pxm-form-label" htmlFor="pxm-composer-prompt">{wantsVoice ? "Script" : "Prompt"}</label>
        <textarea
          id="pxm-composer-prompt"
          className="pxm-textarea"
          data-testid="mobile-composer-prompt"
          rows={4}
          maxLength={5000}
          value={host.state.prompt}
          disabled={host.submitting}
          onChange={(event) => host.dispatch({ type: "prompt", value: event.target.value })}
        />

        {wantsSeconds ? (
          <>
            <label className="pxm-form-label" htmlFor="pxm-composer-seconds">Seconds</label>
            <input
              id="pxm-composer-seconds"
              className="pxm-input"
              type="number"
              min={audioTask === "music" ? 10 : 1}
              max={audioTask === "music" ? 300 : 30}
              value={host.state.seconds}
              disabled={host.submitting}
              onChange={(event) => host.dispatch({ type: "seconds", value: Math.max(1, Number(event.target.value) || 1) })}
            />
          </>
        ) : null}

        {wantsVoice ? (
          <>
            <label className="pxm-form-label" htmlFor="pxm-composer-voice">Voice</label>
            <select
              id="pxm-composer-voice"
              className="pxm-select"
              value={host.state.voiceId}
              disabled={host.submitting}
              onChange={(event) => host.dispatch({ type: "voice", value: event.target.value })}
            >
              <option value="">Choose a voice</option>
              {(host.audio?.voices ?? []).map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
            </select>
          </>
        ) : null}

        <span className="pxm-kicker" data-functional-label="">Credits</span>
        <div className="pxm-segmented" role="group" aria-label="Credits used">
          {(["workspace", "connected"] as BillingSource[]).map((source) => (
            <button
              key={source}
              type="button"
              className="pxm-segment"
              data-on={host.state.billing === source ? "" : undefined}
              aria-pressed={host.state.billing === source}
              data-testid={`mobile-composer-billing-${source}`}
              onClick={() => host.dispatch({ type: "billing", value: source })}
            >
              {BILLING_LABELS[source]}
            </button>
          ))}
        </div>

        {host.state.references.length ? (
          <ul className="pxm-ref-list" aria-label="References">
            {host.state.references.map((reference) => (
              <li key={reference.key}>
                <span className="pxm-grow">{reference.name}</span>
                <button type="button" className="pxm-ref-remove" aria-label={`Remove ${reference.name}`} onClick={() => host.dispatch({ type: "removeReference", key: reference.key })}>×</button>
              </li>
            ))}
          </ul>
        ) : null}

        {host.projectNotice ? <p className="pxm-note" role="status" data-testid="mobile-composer-project-notice">{host.projectNotice}</p> : null}
        {host.state.notice ? <p className="pxm-problem" role="alert" data-testid="mobile-composer-notice">{host.state.notice}</p> : null}
        {host.blocked && !host.state.notice ? <p className="pxm-note" role="status" data-testid="mobile-composer-blocked">{host.blocked}</p> : null}

        {/* The one filled primary while this sheet is up: the pinned one is
            behind the scrim, so there is still exactly one on screen. */}
        <button
          type="button"
          className="pxm-primary pxm-primary-wide"
          data-testid="mobile-composer-render"
          aria-disabled={host.blocked ? true : undefined}
          title={host.blocked ?? undefined}
          onClick={() => host.generate()}
        >
          <span className="pxm-primary-label">
            {host.submitting ? "Submitting" : label}
            {cost && !host.submitting ? <span className="pxm-primary-cost">{cost}</span> : null}
          </span>
        </button>
      </div>
    </MobileSheet>
  );
}
