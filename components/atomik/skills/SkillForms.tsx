"use client";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMoney } from "@/lib/price";
import {
  SKILL_LIMITS, SKILL_SCOPE_LABEL, SKILL_SLUG, SkillTextError,
  engineProblemText, keyOf, matchingSkills, settingsLine, slugOf, templateFromRun, typingCommand,
  type ParameterDraft, type SkillDraft, type SkillRunPreview, type SkillRunStep, type SkillScope, type SkillView,
} from "@/lib/atomikSkillsText";
import { SkillRequestError, failed, type PlannedRun, type SkillsApi } from "@/lib/shell/use-skills";
import styles from "./skills.module.css";

/**
 * Atomik skills, the pieces every surface shares: the composer's `/` list,
 * the form that runs a skill, the form that saves a run as one, and the
 * dialog they open in over the rail or the phone sheet. The Skills page
 * (components/graphite/atomik/SkillsView.tsx) shows the same forms in place.
 *
 * Nothing here spends. Running a skill plans its steps for nothing; each
 * step then waits in Atomik for its own quote and a person's Continue.
 */

/* ── Words with their parameters shown ─────────────────────────────────── */

/** A template's words, each `{{key}}` shown as the parameter it is. */
export function WithParameters({ text, labels }: { text: string; labels: Record<string, string> }) {
  const parts = text.split(/\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/);
  return <>{parts.map((part, i) => (i % 2 === 1
    ? <span key={i} className={styles.placeholder} data-testid="skill-placeholder">{labels[part] ?? part}</span>
    : <Fragment key={i}>{part}</Fragment>))}</>;
}

/* ── A dialog over the rail or the phone sheet ─────────────────────────── */

export function SkillDialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = box.current?.querySelector<HTMLElement>("input, textarea, button:not([data-close])");
    first?.focus({ preventScroll: true });
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={styles.veil} onClick={onClose} data-testid="skill-dialog-veil">
      <div ref={box} className={styles.dialog} role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}
        /* Escape closes this dialog only: the rail's sheet under it stays open. */
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onClose(); } }}
        data-testid="skill-dialog">
        {children}
      </div>
    </div>,
    document.body,
  );
}

function DialogHead({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className={styles.dialogHead}>
      <div>{children}</div>
      <button type="button" className={`${styles.button} ${styles.close}`} onClick={onClose} aria-label="Close" data-close="" data-testid="skill-dialog-close">×</button>
    </div>
  );
}

/* ── The composer's `/` ───────────────────────────────────────────────── */

/** The id of a listed skill, for the composer's `aria-activedescendant`. */
export const skillOptionId = (listId: string, index: number) => `${listId}-${index}`;

/**
 * `/` in the composer: the skills this person may run, as they type. The
 * highlighted one (`active`; the first until the arrows move it) is what
 * Enter opens; the composer's field points at it for a screen reader.
 */
export function SkillHints({ text, skills, loading, onPick, disabled, listId, active = 0, failed = false, onRetry }: {
  text: string; skills: readonly SkillView[]; loading: boolean; onPick: (skill: SkillView) => void; disabled: boolean; listId?: string; active?: number;
  /** The last read failed and there are no skills to show: said, with Try again. */
  failed?: boolean; onRetry?: () => void;
}) {
  if (!typingCommand(text)) return null;
  const matches = matchingSkills(text, skills);
  if (!matches.length) {
    if (loading) return <p className={styles.hint} role="status">Reading skills…</p>;
    if (failed) {
      return (
        <div className={styles.row} role="alert" data-testid="skill-hint-error">
          <span className={styles.hint}>Skills could not be read.</span>
          {onRetry ? <button type="button" className={styles.button} onClick={onRetry} disabled={disabled} data-testid="skill-hint-retry">Try again</button> : null}
        </div>
      );
    }
    return <p className={styles.hint} data-testid="skill-hint-none">{skills.length ? `No skill is called ${text}.` : "No skills yet. Save a run as a skill to run it again from here."}</p>;
  }
  return (
    <div role="listbox" id={listId} aria-label="Skills" className={styles.list} data-testid="skill-hints">
      {matches.map((s, i) => (
        <button key={s.id} id={listId ? skillOptionId(listId, i) : undefined} type="button" role="option" aria-selected={i === active} disabled={disabled}
          onClick={() => onPick(s)} className={styles.option} title={s.description} data-testid="skill-hint">
          <span className={styles.optionCommand}>/{s.slug}</span>
          <span className={styles.optionLine}>{s.name}{s.scope === "workspace" ? " · workspace" : " · just you"}</span>
        </button>
      ))}
    </div>
  );
}

/* ── Running a skill ──────────────────────────────────────────────────── */

/** A step's estimate as the person reads it: about a figure, or where it will be priced. */
function useEstimate() {
  const money = useMoney();
  return (step: Pick<SkillRunStep, "estCredits" | "estUsd">): { label: string; value: number | null } => {
    const n = money.inCredits ? step.estCredits : step.estUsd;
    return n == null ? { label: "priced at its checkpoint", value: null } : { label: `about ${money.price(n)}`, value: n };
  };
}

/**
 * Run a skill: its parameters, each step on its engine with an estimate, and
 * any engine that is switched off or no longer offered — named with the
 * nearest allowed one, which the person may choose. Planning files the steps
 * in Atomik as proposals, for nothing; each then waits for its own quote and
 * a person's Continue.
 */
export function SkillRunForm({ api, skill, chatId = null, projectId, onPlanned, onCancel, heading = true, planLabel = "Plan these steps", initialValues = {} }: {
  api: SkillsApi; skill: SkillView; chatId?: string | null; projectId: string | null;
  onPlanned: (run: PlannedRun) => void; onCancel?: () => void; heading?: boolean; planLabel?: string;
  /** Values typed after the command; every other parameter starts at its default. */
  initialValues?: Record<string, string>;
}) {
  const money = useMoney();
  const estimate = useEstimate();
  const parameters = skill.template.parameters;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(parameters.map((p) => [p.key, initialValues[p.key] ?? p.default])));
  const [engines, setEngines] = useState<Record<string, string>>({});
  const key = JSON.stringify([values, engines]);
  const enginesKey = JSON.stringify(engines);
  const [preview, setPreview] = useState<{ key: string; engines: string; value: SkillRunPreview | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const empty = parameters.filter((p) => !(values[p.key] ?? "").trim());

  useEffect(() => {
    if (parameters.some((p) => !(values[p.key] ?? "").trim())) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const value = await api.preview(skill.id, { values, engines });
        if (live) setPreview({ key, engines: enginesKey, value, error: null });
      } catch (error) {
        if (live) setPreview({ key, engines: enginesKey, value: null, error: failed(error, "The skill could not be previewed. Try again.") });
      }
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [api, skill.id, parameters, values, engines, key, enginesKey, attempt]);

  /* The preview for exactly these words and engines; while the next one is asked for, the last one with the same
     engines stays on screen (its prices do not depend on the words), and Plan waits for the fresh one. */
  const current = preview?.key === key ? preview : null;
  const shown = current?.value ?? (!empty.length && preview?.engines === enginesKey ? preview.value : null);
  const problems = shown?.problems ?? [];
  const priced = (shown?.steps ?? []).map(estimate);
  const total = priced.reduce((sum, p) => sum + (p.value ?? 0), 0);
  const unpriced = priced.filter((p) => p.value === null).length;
  const ready = Boolean(current?.value) && !problems.length && !empty.length && !busy;

  const plan = async () => {
    if (!ready) return;
    setBusy(true); setProblem(null);
    try {
      onPlanned(await api.run(skill.id, { values, engines, chatId, projectId }));
    } catch (error) {
      /* An engine switched off since the preview: show the choice again, never swap it. */
      if (error instanceof SkillRequestError && error.problems.length) setPreview({ key, engines: enginesKey, value: shown ? { ...shown, problems: error.problems } : null, error: null });
      setProblem(failed(error, "The skill could not be planned. Try again."));
    } finally { setBusy(false); }
  };

  return (
    <div className={styles.form} data-testid="skill-run-form" aria-busy={!current && !empty.length}>
      {heading ? (
        <div className={styles.head}>
          <h2 className={styles.title}>{skill.name}</h2>
          <span className={styles.command}>/{skill.slug} · version {skill.version}</span>
          <p className={styles.note}>{skill.description}</p>
        </div>
      ) : null}
      {parameters.length ? (
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Parameters</legend>
          {parameters.map((p) => (
            <label key={p.key} className={styles.label}>
              {p.label}
              <input className={styles.field} value={values[p.key] ?? ""} maxLength={SKILL_LIMITS.value}
                onChange={(e) => { setValues({ ...values, [p.key]: e.target.value }); setProblem(null); }} data-testid={`skill-param-${p.key}`} />
            </label>
          ))}
        </fieldset>
      ) : <p className={styles.note}>This skill takes no parameters.</p>}
      {empty.length ? <p className={styles.error} role="alert" data-testid="skill-param-empty">Fill in {empty.map((p) => p.label).join(", ")}.</p> : null}

      {problems.map((p) => (
        <div key={p.step} className={styles.problem} role="group" aria-label={`Engine for step ${p.step + 1}`} data-testid="skill-engine-problem">
          <p className={styles.problemText}>Step {p.step + 1}, {p.title}: {engineProblemText(p)}</p>
          {p.choices.length ? (
            <div className={styles.row}>
              {p.choices.slice(0, 4).map((c, i) => (
                <button key={c.id} type="button" className={`${styles.button} ${i === 0 ? styles.primary : ""}`} disabled={busy}
                  onClick={() => { setEngines({ ...engines, [p.step]: c.id }); setProblem(null); }} data-testid="skill-engine-use">Use {c.label}</button>
              ))}
            </div>
          ) : null}
        </div>
      ))}

      {shown ? (
        <ol className={styles.steps} aria-label="Steps">
          {shown.steps.map((s, i) => (
            <li key={s.index} className={styles.step} data-testid="skill-run-step" data-model={s.model}>
              <span className={styles.stepN}>{String(s.index + 1).padStart(2, "0")}</span>
              <span className={styles.stepBody}>
                <span className={styles.stepTitle}>{s.title}</span>
                <span className={styles.stepMeta}>{[s.label, settingsLine(s.params)].filter(Boolean).join(" · ")}</span>
                {s.swapped ? (
                  <span className={styles.row}>
                    <span className={styles.stepMeta}>You chose this engine.</span>
                    <button type="button" className={styles.button} disabled={busy} onClick={() => { const next = { ...engines }; delete next[s.index]; setEngines(next); }} data-testid="skill-engine-undo">Undo</button>
                  </span>
                ) : null}
              </span>
              <span className={`${styles.price} ${priced[i].value === null ? styles.pending : ""}`} data-testid="skill-run-price">{priced[i].label}</span>
            </li>
          ))}
        </ol>
      ) : empty.length ? null : current?.error ? (
        <div className={styles.row}>
          <p className={styles.error} role="alert" data-testid="skill-preview-error">{current.error}</p>
          <button type="button" className={styles.button} onClick={() => setAttempt((n) => n + 1)} data-testid="skill-preview-retry">Try again</button>
        </div>
      ) : <p className={styles.status} role="status">Filling in the steps…</p>}

      {shown ? (
        <div className={styles.total} data-testid="skill-run-total">
          <span>Estimated total</span>
          <strong>{`about ${money.price(total)}`}{unpriced ? ` + ${unpriced} priced at ${unpriced === 1 ? "its checkpoint" : "their checkpoints"}` : ""}</strong>
        </div>
      ) : null}
      <p className={styles.note}>Planning is free. Each step then waits in Atomik for its own quote and your Continue; nothing runs by itself.</p>
      {problem ? <p className={styles.error} role="alert" data-testid="skill-run-problem">{problem}</p> : null}
      <div className={styles.actions}>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={!ready} onClick={() => void plan()} data-testid="skill-plan">{busy ? "Planning…" : planLabel}</button>
        {onCancel ? <button type="button" className={styles.button} disabled={busy} onClick={onCancel} data-testid="skill-run-cancel">Cancel</button> : null}
      </div>
    </div>
  );
}

/* ── Saving a run as a skill ───────────────────────────────────────────── */

type ParamRow = { id: string; label: string; phrase: string };
let rowSeq = 0;
const rowId = () => `p${++rowSeq}`;

/**
 * Save a run as a skill: its name and command, a line on what it makes, who
 * sees it, the steps to keep (with engines and settings), and which words
 * become parameters — the phrases the person's own request and the prompts
 * share are suggested. What the run made is never kept.
 */
export function SaveSkillForm({ api, chatId, onSaved, onCancel, heading = true }: {
  api: SkillsApi; chatId: string; onSaved: (skill: SkillView) => void; onCancel?: () => void; heading?: boolean;
}) {
  const [draft, setDraft] = useState<{ status: "loading" | "ready" | "error"; value: SkillDraft | null; error: string | null }>({ status: "loading", value: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<SkillScope>("personal");
  const [kept, setKept] = useState<string[]>([]);
  const [rows, setRows] = useState<ParamRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = { name: useId(), slug: useId(), description: useId() };

  useEffect(() => {
    let live = true;
    api.draft(chatId).then((value) => {
      if (!live) return;
      setDraft({ status: "ready", value, error: null });
      setName(value.name); setSlug(value.slug);
      setKept(value.steps.filter((s) => s.keep).map((s) => s.id));
      setRows(value.parameters.map((p) => ({ id: rowId(), label: p.label, phrase: p.phrase })));
    }).catch((error) => { if (live) setDraft({ status: "error", value: null, error: failed(error, "That run could not be read. Try again.") }); });
    return () => { live = false; };
  }, [api, chatId, attempt]);

  const value = draft.value;
  const command = slugEdited ? slug : slugOf(name || "skill");
  /* The parameters as the server takes them: each named from its label, once. */
  const parameters: ParameterDraft[] = useMemo(() => {
    const taken = new Set<string>();
    return rows.filter((r) => r.phrase.trim()).map((r) => {
      const key = keyOf(r.label.trim() || r.phrase, taken);
      taken.add(key);
      return { key, label: r.label.trim() || r.phrase.trim(), phrase: r.phrase.trim() };
    });
  }, [rows]);
  /* The template as it will be saved, checked here with the rules the server holds. */
  const built = useMemo(() => {
    const chosen = value ? value.steps.filter((s) => kept.includes(s.id)) : [];
    if (!chosen.length) return { template: null, error: "Keep at least one step." };
    try { return { template: templateFromRun(chosen.map((s) => ({ kind: s.kind, title: s.title, prompt: s.prompt, model: s.model, params: s.settings })), parameters), error: null }; }
    catch (error) { return { template: null, error: error instanceof SkillTextError ? error.message : "Check the steps and parameters." }; }
  }, [value, kept, parameters]);
  const labels = Object.fromEntries(parameters.map((p) => [p.key, p.label]));
  const valid = Boolean(built.template) && name.trim().length >= 2 && description.trim().length >= 3 && SKILL_SLUG.test(command);

  const save = async () => {
    if (!valid || busy || !value) return;
    setBusy(true); setProblem(null);
    try {
      onSaved(await api.save({ chatId, stepIds: kept, parameters, name, slug: command, description, scope }));
    } catch (error) { setProblem(failed(error, "That skill could not be saved. Try again.")); }
    finally { setBusy(false); }
  };

  if (draft.status !== "ready" || !value) {
    return (
      <div className={styles.form} data-testid="skill-save-form">
        {draft.status === "error" ? (
          <div className={styles.row}>
            <p className={styles.error} role="alert" data-testid="skill-save-load-error">{draft.error}</p>
            <button type="button" className={styles.button} onClick={() => { setDraft({ status: "loading", value: null, error: null }); setAttempt((n) => n + 1); }} data-testid="skill-save-retry">Try again</button>
          </div>
        ) : <p className={styles.status} role="status">Reading the run…</p>}
        {onCancel ? <div className={styles.actions}><button type="button" className={styles.button} onClick={onCancel}>Cancel</button></div> : null}
      </div>
    );
  }

  return (
    /* Its submit stops here: the composer this dialog opens from is a form of its own, and its submit is a paid turn. */
    <form className={styles.form} onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); void save(); }} data-testid="skill-save-form">
      {heading ? (
        <div className={styles.head}>
          <h2 className={styles.title}>Save as skill</h2>
          <p className={styles.note}>Keeps the steps, their engines and settings, and the words you choose as parameters. Nothing the run made is kept, and saving is free.</p>
        </div>
      ) : null}
      <label className={styles.label} htmlFor={ids.name}>Name</label>
      <input id={ids.name} className={styles.field} value={name} maxLength={SKILL_LIMITS.name} onChange={(e) => { setName(e.target.value); setProblem(null); }} data-testid="skill-save-name" />
      <label className={styles.label} htmlFor={ids.slug}>Command</label>
      <input id={ids.slug} className={styles.field} value={`/${command}`} maxLength={SKILL_LIMITS.slug + 1} spellCheck={false} autoCapitalize="none"
        onChange={(e) => { setSlugEdited(true); setSlug(e.target.value.replace(/^\/+/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-")); setProblem(null); }} data-testid="skill-save-slug" />
      {!SKILL_SLUG.test(command) ? <p className={styles.error} role="alert">A command is 2 to 40 lower-case letters, digits and dashes, starting with a letter.</p> : null}
      <label className={styles.label} htmlFor={ids.description}>What it makes, in a line</label>
      <input id={ids.description} className={styles.field} value={description} maxLength={SKILL_LIMITS.description} onChange={(e) => { setDescription(e.target.value); setProblem(null); }}
        placeholder="A hero still, a skate pass and a music bed for a product." data-testid="skill-save-description" />
      <div className={styles.fieldset} role="group" aria-label="Who sees it">
        <span className={styles.legend}>Who sees it</span>
        <div className={styles.segmented}>
          {(["personal", "workspace"] as const).map((s) => (
            <button key={s} type="button" className={styles.choice} aria-pressed={scope === s} onClick={() => setScope(s)} data-testid={`skill-save-scope-${s}`}>{s === "personal" ? "Just me" : "Workspace"}</button>
          ))}
        </div>
        <p className={styles.note}>{scope === "personal" ? "Only you see and run it." : "Everyone in this workspace sees, runs and can edit it."}</p>
      </div>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Steps to keep</legend>
        {value.steps.map((s, i) => (
          <label key={s.id} className={styles.check} data-disabled={Boolean(s.why)} data-testid="skill-save-step">
            <input type="checkbox" checked={kept.includes(s.id)} disabled={Boolean(s.why) || busy}
              onChange={(e) => setKept(e.target.checked ? value.steps.filter((x) => x.id === s.id || kept.includes(x.id)).map((x) => x.id) : kept.filter((id) => id !== s.id))} />
            <span className={styles.stepBody}>
              <span className={styles.stepTitle}>{String(i + 1).padStart(2, "0")} · {s.title}</span>
              <span className={styles.stepMeta}>{[s.label, settingsLine(s.settings)].filter(Boolean).join(" · ")}</span>
              {s.why ? <span className={styles.stepMeta}>Not kept: {s.why}.</span> : !s.latest ? <span className={styles.stepMeta}>From an earlier plan in this chat.</span> : null}
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Parameters</legend>
        <p className={styles.note}>Words a run asks for again. Each stands for a phrase in the prompts; that phrase becomes its default.</p>
        {rows.map((r) => (
          <div key={r.id} className={styles.param} data-testid="skill-save-param">
            <label className={styles.label}>Name
              <input className={styles.field} value={r.label} maxLength={SKILL_LIMITS.label} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, label: e.target.value } : x)))} data-testid="skill-save-param-label" />
            </label>
            <label className={styles.label}>Stands for
              <input className={styles.field} value={r.phrase} maxLength={SKILL_LIMITS.value} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, phrase: e.target.value } : x)))} data-testid="skill-save-param-phrase" />
            </label>
            <button type="button" className={styles.button} onClick={() => setRows(rows.filter((x) => x.id !== r.id))} aria-label={`Remove ${r.label || r.phrase || "parameter"}`} data-testid="skill-save-param-remove">Remove</button>
          </div>
        ))}
        {rows.length < SKILL_LIMITS.parameters ? (
          <div className={styles.row}>
            <button type="button" className={styles.button} onClick={() => setRows([...rows, { id: rowId(), label: "", phrase: "" }])} data-testid="skill-save-param-add">Add a parameter</button>
          </div>
        ) : null}
      </fieldset>

      {built.template ? (
        <ol className={styles.steps} aria-label="What the skill keeps">
          {built.template.steps.map((s, i) => (
            <li key={i} className={styles.step}>
              <span className={styles.stepN}>{String(i + 1).padStart(2, "0")}</span>
              <span className={styles.stepBody}>
                <span className={styles.stepTitle}><WithParameters text={s.title} labels={labels} /></span>
                <p className={styles.stepPrompt}><WithParameters text={s.prompt} labels={labels} /></p>
              </span>
              <span />
            </li>
          ))}
        </ol>
      ) : <p className={styles.error} role="alert" data-testid="skill-save-invalid">{built.error}</p>}
      {problem ? <p className={styles.error} role="alert" data-testid="skill-save-problem">{problem}</p> : null}
      <div className={styles.actions}>
        <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={!valid || busy} data-testid="skill-save">{busy ? "Saving…" : "Save skill"}</button>
        {onCancel ? <button type="button" className={styles.button} disabled={busy} onClick={onCancel} data-testid="skill-save-cancel">Cancel</button> : null}
      </div>
      <p className={styles.note}>{SKILL_SCOPE_LABEL[scope]} · saving is free</p>
    </form>
  );
}

/* ── The dialogs the composer opens ────────────────────────────────────── */

export function SaveSkillDialog({ api, chatId, onSaved, onClose }: { api: SkillsApi; chatId: string; onSaved: (skill: SkillView) => void; onClose: () => void }) {
  return (
    <SkillDialog label="Save as skill" onClose={onClose}>
      <DialogHead onClose={onClose}>
        <h2 className={styles.title}>Save as skill</h2>
        <p className={styles.note}>Keeps the steps, their engines and settings, and the words you choose as parameters. Nothing the run made is kept, and saving is free.</p>
      </DialogHead>
      <SaveSkillForm api={api} chatId={chatId} onSaved={onSaved} onCancel={onClose} heading={false} />
    </SkillDialog>
  );
}

export function RunSkillDialog({ api, skill, values, chatId, projectId, onPlanned, onClose }: {
  api: SkillsApi; skill: SkillView; values?: Record<string, string>; chatId: string | null; projectId: string | null; onPlanned: (run: PlannedRun) => void; onClose: () => void;
}) {
  return (
    <SkillDialog label={`Run /${skill.slug}`} onClose={onClose}>
      <DialogHead onClose={onClose}>
        <h2 className={styles.title}>{skill.name}</h2>
        <span className={styles.command}>/{skill.slug} · version {skill.version}</span>
        <p className={styles.note}>{skill.description}</p>
      </DialogHead>
      <SkillRunForm api={api} skill={skill} chatId={chatId} projectId={projectId} onPlanned={onPlanned} onCancel={onClose} heading={false} initialValues={values} />
    </SkillDialog>
  );
}
