"use client";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  aboutCredits, nextActionBody, nextDefaults, nextDurations, nextProblem, nextRatios, nextResolutions, nextShotOf, nextSourceOf, sourceFacts, topazScales,
  type NextSettings, type PricedAction, type PricedActionId,
} from "@/lib/shell/next-actions";
import {
  NextRefusal, followNextRun, nextRunKey, pressNext, quoteNext, readNextRun, subscribeNextRuns,
  type NextRefusalDetail,
} from "@/lib/workspace/next-action-run";
import { EXTEND_MOVES } from "@/lib/tasks";
import { MAX_REASON } from "@/lib/approval";
import { TOPAZ_IMAGE_PRESETS, type TopazImageSettings } from "@/lib/topaz";
import { pendingGenerationKey } from "@/lib/workbench/pending-generation";
import { rememberWorkspaceQuote } from "@/lib/workspace/last-quote";
import type { LibraryEntry } from "@/lib/workspace/library";

/**
 * One priced Next action on one take (lib/shell/next-actions.ts), opened from
 * its button in the Next row: its few settings, the estimate for exactly that
 * request ("about N cr", read as the settings change, charging nothing), and
 * the one button that sends it — after a fresh quote, and only at the estimate
 * shown; a moved estimate is asked about again (lib/workspace/next-action-run.ts).
 * Once sent, the new take is followed until it lands (a new take, filed with
 * its source; the source stays as it is) or fails (what happened, what its
 * provider did with the charge, and Retry, priced again).
 */

const VERB: Record<PricedActionId, string> = { upscale: "Upscaling", outpaint: "Outpainting", animate: "Animating", reframe: "Reframing", extend: "Extending" };
/** An example answer to the approved shot's question, in each action's terms. */
const REASON_HINT: Record<PricedActionId, string> = {
  upscale: "Sharper for delivery", outpaint: "Square for the poster", animate: "A moving version for the trailer",
  reframe: "Vertical for socials", extend: "Longer for the edit",
};
const WORDS_LIMIT = 2000;

type Quote = { key: string; credits?: number; refusal?: { message: string; detail: NextRefusalDetail }; error?: string };

export function NextActionPanel({ id, scope, entry, action, project, onClose, onOpenTake }: {
  id: string;
  scope: string;
  entry: LibraryEntry;
  action: PricedAction;
  /** The workbench project (its library is read again when the new take is sent and lands) and its saved production. */
  project: { id: string; productionProjectId: string };
  onClose: () => void;
  /** Open a take by its library id (the new one, once it lands). */
  onOpenTake?: (id: string) => void;
}) {
  const [settings, setSettings] = useState<NextSettings>(() => nextDefaults(action.id, entry));
  const [reason, setReason] = useState("");
  /** The approved shot's question, once it has been asked: the field stays while the answer is written. */
  const [asked, setAsked] = useState<{ title: string; line: string } | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [nonce, setNonce] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const panel = useRef<HTMLDivElement>(null);

  const facts = useMemo(() => sourceFacts(entry), [entry]);
  const source = useMemo(() => nextSourceOf(entry), [entry]);
  const shotId = nextShotOf(entry, project.productionProjectId);
  const body = useMemo(() => nextActionBody({ settings, source, productionProjectId: project.productionProjectId, shotId, reason }), [settings, source, project.productionProjectId, shotId, reason]);
  const key = JSON.stringify([scope, body, nonce]);
  const problem = nextProblem(settings);

  const runKey = nextRunKey(scope, entry.take.id, action.id);
  const run = useSyncExternalStore(subscribeNextRuns, () => readNextRun(runKey), () => null);
  const following = run?.phase === "following";

  useEffect(() => { panel.current?.scrollIntoView({ block: "nearest" }); }, []);

  /* The estimate for exactly what would be sent, read as the settings change (a quote reserves nothing and charges nothing). */
  useEffect(() => {
    if (problem || following) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      quoteNext(scope, body, controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return;
          setQuote({ key, credits: value.credits });
          /* The figure the header's credits pill weighs the balance against, as Gen's price is (lib/workspace/last-quote.ts). */
          rememberWorkspaceQuote(scope, value.credits);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof NextRefusal) {
            if (error.detail.needsReason) setAsked(error.detail.needsReason);
            setQuote({ key, refusal: { message: error.message, detail: error.detail } });
          } else setQuote({ key, error: "The estimate could not be read." });
        });
    }, 350);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, body, scope, problem, following]);

  const current = quote?.key === key ? quote : null;
  const shown = current?.credits != null ? current.credits : null;
  const retrying = run?.phase === "failed";
  const word = retrying ? "Retry" : action.label;
  const change = (next: NextSettings) => { setSettings(next); setNote(null); };

  const press = async () => {
    if (shown == null || sending.current || following) return;
    sending.current = true;
    setBusy(true);
    setNote(null);
    try {
      const out = await pressNext({
        scope, body, shown, label: word,
        storageId: pendingGenerationKey(scope, project.id, `next:${action.id}:${entry.take.id}`),
      });
      if (out.state === "queued") followNextRun(runKey, { scope, projectId: project.id, jobId: out.jobId, credits: out.credits, status: out.status, note: out.note });
      else if (out.state === "repriced") { setQuote({ key, credits: out.credits }); rememberWorkspaceQuote(scope, out.credits); setNote(out.note); }
      else if (out.state === "refused") {
        setNote(out.note);
        if (out.detail?.needsReason) setAsked(out.detail.needsReason);
        /* Refused as it stands (a changed estimate, a shot approved meanwhile): it is priced again before anything else goes. */
        setNonce((n) => n + 1);
      } else setNote(out.note);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const refusal = current?.refusal ?? null;
  const pricing = !problem && !following && !current;
  const priceText = shown != null ? aboutCredits(shown) : pricing ? "pricing…" : null;

  return (
    <div className="gx-next-panel" id={id} ref={panel} role="group" aria-label={`${action.label} ${entry.take.name}`} data-testid="next-panel" data-action={action.id}>
      <div className="gx-next-panel-head">
        <span className="gx-next-panel-title">{action.label}</span>
        <span className="gx-next-label" data-functional-label="">{action.engine} · this workspace’s credits</span>
      </div>
      <p className="gx-next-note">A new take from this one; {entry.take.name} stays as it is.</p>
      <fieldset className="gx-next-fields" disabled={busy || following}>
        <Controls settings={settings} facts={facts} onChange={change} />
        {/* The approved shot's question, then the answer it asks for: kept with the new take (lib/approval.ts). */}
        {asked ? <p className="gx-next-note" id={`${id}-asked`} data-testid="next-asked">{asked.title} {asked.line}</p> : null}
        {asked ? (
          <Field label="Why another take?">
            {(labelled) => <input className="gx-field" aria-labelledby={labelled} aria-describedby={`${id}-asked`} maxLength={MAX_REASON} value={reason} placeholder={REASON_HINT[action.id]} onChange={(e) => setReason(e.target.value)} data-testid="next-reason" />}
          </Field>
        ) : null}
      </fieldset>
      <div className="gx-next-go-row">
        <button type="button" className="gx-primary gx-gen-go gx-next-go" disabled={busy || following || shown == null} data-priced={shown != null ? "" : undefined}
          onClick={() => void press()} data-testid="next-go" aria-label={priceText ? `${word} · ${priceText}` : word}>
          {busy ? "Sending…" : <><span className="gx-go-act">{word}</span>{priceText ? <span className="gx-go-price"><span className="gx-go-sep">{" · "}</span>{priceText}</span> : null}</>}
        </button>
        <button type="button" className="gx-hbtn" disabled={busy} onClick={onClose} data-testid="next-close">{run?.phase === "landed" ? "Done" : "Cancel"}</button>
      </div>
      {problem && !following ? <p className="gx-next-note" data-testid="next-blocked">{problem}</p> : null}
      {current?.error && !following ? (
        <div className="gx-next-go-row">
          <p className="gx-next-note" data-tone="red" role="alert" data-testid="next-quote-error">{current.error}</p>
          <button type="button" className="gx-hbtn" onClick={() => setNonce((n) => n + 1)} data-testid="next-try-again">Try again</button>
        </div>
      ) : null}
      {refusal && !following && !(refusal.detail.needsReason && asked) ? <p className="gx-next-note" data-tone="red" role="alert" data-testid="next-refused">{refusal.message}</p> : null}
      {note ? <p className="gx-next-note" role="status" data-testid="next-note">{note}</p> : null}
      {run?.phase === "following" ? (
        <p className="gx-next-note" role="status" data-testid="next-following">
          {run.status === "held" ? (run.note ?? "Held until credits or a render slot free up. Nothing is charged until it runs.")
            : `${VERB[action.id]}${run.status === "queued" ? " — queued" : "…"} It lands in Takes as a new take.`}
          {run.checking ? ` ${run.checking}` : ""}
        </p>
      ) : null}
      {run?.phase === "landed" ? (
        <div className="gx-next-done" role="status" data-testid="next-landed">
          <p className="gx-next-note">
            {run.generation.shotCode
              ? `Done: a new take, ${run.generation.shotCode} v${run.generation.version}, filed with ${entry.take.name}, which stays as it is.`
              : `Done: a new take in Takes, made from ${entry.take.name}, which stays as it is.`}
          </p>
          {onOpenTake ? <button type="button" className="gx-hbtn" onClick={() => onOpenTake(`generation:${run.generation.id}`)} data-testid="next-open-result">Open the new take</button> : null}
        </div>
      ) : null}
      {run?.phase === "failed" ? <p className="gx-next-note" data-tone="red" role="alert" data-testid="next-failed">{run.line}</p> : null}
      {run?.phase === "lost" ? <p className="gx-next-note" role="status" data-testid="next-lost">{run.note}</p> : null}
    </div>
  );
}

/** A labelled control: the label is the control's name (aria-labelledby), and reads at the label floor. */
function Field({ label, children }: { label: string; children: (labelledBy: string) => ReactNode }) {
  const labelId = useId();
  return (
    <div className="gx-next-field">
      <span className="gx-next-label" id={labelId} data-functional-label="">{label}</span>
      {children(labelId)}
    </div>
  );
}

/** A small single choice, the shell's segmented control (a 40px option in a 44px track on a phone). */
function Choice<T extends string | number>({ labelledBy, options, value, onChange, testId }: {
  labelledBy: string; options: { value: T; label: string; why?: string | null }[]; value: T; onChange: (value: T) => void; testId: string;
}) {
  return (
    <div className="gx-seg gx-seg--sm gx-next-seg" role="radiogroup" aria-labelledby={labelledBy} data-testid={testId}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" className="gx-seg-btn" aria-checked={value === o.value} disabled={Boolean(o.why)} title={o.why ?? undefined}
          onClick={() => onChange(o.value)}><span>{o.label}</span></button>
      ))}
    </div>
  );
}

function Toggle({ on, label, onChange, testId }: { on: boolean; label: string; onChange: (on: boolean) => void; testId: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="gx-toggle gx-next-toggle" onClick={() => onChange(!on)} data-testid={testId}>
      <span className="gx-toggle-dot" aria-hidden="true" />{label}
    </button>
  );
}

function Select<T extends string | number>({ labelledBy, options, value, onChange, testId }: {
  labelledBy: string; options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; testId: string;
}) {
  return (
    <select className="gx-select" aria-labelledby={labelledBy} value={String(value)} data-testid={testId}
      onChange={(e) => { const picked = options.find((o) => String(o.value) === e.target.value); if (picked) onChange(picked.value); }}>
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
}

const sizes = () => nextResolutions().map((r) => ({ value: r, label: r }));
const lengths = () => nextDurations().map((d) => ({ value: d, label: `${d}s` }));

/** Each action's few settings: the ones its engine takes, nothing more. */
function Controls({ settings: s, facts, onChange }: { settings: NextSettings; facts: ReturnType<typeof sourceFacts>; onChange: (next: NextSettings) => void }) {
  switch (s.action) {
    case "upscale":
      if (s.media === "video") return (
        <>
          <Field label="Frame rate">{(l) => <Choice labelledBy={l} testId="next-fps" value={s.fps} onChange={(fps) => onChange({ ...s, fps })} options={[{ value: 30, label: "30 fps" }, { value: 60, label: "60 fps" }]} />}</Field>
          <p className="gx-next-note">Astra chooses the output size, usually 4K, and keeps the clip’s length.</p>
        </>
      );
      return (
        <>
          <Field label="Scale">{(l) => <Choice labelledBy={l} testId="next-scale" value={s.topaz.factor} onChange={(factor) => onChange({ ...s, topaz: { ...s.topaz, factor } })}
            options={topazScales(facts).map((o) => ({ value: o.factor, label: `${o.factor}×`, why: o.why }))} />}</Field>
          <Field label="Model">{(l) => <Select labelledBy={l} testId="next-topaz-model" value={s.topaz.model} onChange={(model) => onChange({ ...s, topaz: { ...s.topaz, model } })}
            options={TOPAZ_IMAGE_PRESETS.map((m) => ({ value: m as TopazImageSettings["model"], label: m }))} />}</Field>
          <Toggle on={s.topaz.faceEnhancement} label="Enhance faces" testId="next-faces" onChange={(on) => onChange({ ...s, topaz: { ...s.topaz, faceEnhancement: on } })} />
        </>
      );
    case "outpaint":
    case "reframe":
      return (
        <>
          <Field label="New aspect">{(l) => <Select labelledBy={l} testId="next-ratio" value={s.ratio} onChange={(ratio) => onChange({ ...s, ratio })} options={nextRatios(s.action).map((r) => ({ value: r, label: r }))} />}</Field>
          <Field label="What the new edges show (optional)">{(l) => <input className="gx-field" aria-labelledby={l} maxLength={WORDS_LIMIT} value={s.prompt} placeholder="More of the harbour" onChange={(e) => onChange({ ...s, prompt: e.target.value })} data-testid="next-words" />}</Field>
        </>
      );
    case "animate":
      return (
        <>
          <Field label="What moves">{(l) => <textarea className="gx-textarea gx-next-text" aria-labelledby={l} maxLength={WORDS_LIMIT} value={s.prompt} placeholder="The camera pushes in slowly; the flags stir in the wind" onChange={(e) => onChange({ ...s, prompt: e.target.value })} data-testid="next-words" />}</Field>
          <Field label="Aspect">{(l) => <Select labelledBy={l} testId="next-ratio" value={s.ratio} onChange={(ratio) => onChange({ ...s, ratio })} options={nextRatios("animate").map((r) => ({ value: r, label: r }))} />}</Field>
          <Field label="Size">{(l) => <Choice labelledBy={l} testId="next-size" value={s.resolution} onChange={(resolution) => onChange({ ...s, resolution })} options={sizes()} />}</Field>
          <Field label="Length">{(l) => <Select labelledBy={l} testId="next-length" value={s.duration} onChange={(duration) => onChange({ ...s, duration })} options={lengths()} />}</Field>
          <Toggle on={s.audio} label="Sound" testId="next-sound" onChange={(audio) => onChange({ ...s, audio })} />
        </>
      );
    case "extend":
      return (
        <>
          <Field label="Direction">{(l) => <Choice labelledBy={l} testId="next-direction" value={s.direction} onChange={(direction) => onChange({ ...s, direction })}
            options={EXTEND_MOVES.map((m) => ({ value: m.id as "forward" | "backward", label: m.label }))} />}</Field>
          <Field label={s.direction === "backward" ? "What happens before" : "What happens next"}>{(l) => <textarea className="gx-textarea gx-next-text" aria-labelledby={l} maxLength={WORDS_LIMIT} value={s.prompt} placeholder={s.direction === "backward" ? "She walks up to the pier from the road" : "The ferry clears the harbour mouth"} onChange={(e) => onChange({ ...s, prompt: e.target.value })} data-testid="next-words" />}</Field>
          <Field label="Size">{(l) => <Choice labelledBy={l} testId="next-size" value={s.resolution} onChange={(resolution) => onChange({ ...s, resolution })} options={sizes()} />}</Field>
          <Field label="Length">{(l) => <Select labelledBy={l} testId="next-length" value={s.duration} onChange={(duration) => onChange({ ...s, duration })} options={lengths()} />}</Field>
          <Toggle on={s.audio} label="Sound" testId="next-sound" onChange={(audio) => onChange({ ...s, audio })} />
        </>
      );
  }
}
