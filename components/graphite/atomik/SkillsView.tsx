"use client";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import { useWorkspace } from "@/lib/workspace/state";
import { ProjectProvider, useProject } from "@/lib/projectContext";
import { MODELS } from "@/lib/models";
import { AtomikProvider, useAtomik } from "@/components/atomik/AtomikProvider";
import { SaveSkillForm, SkillRunForm, WithParameters } from "@/components/atomik/skills/SkillForms";
import { failed, openAtomikChat, useSkills, type PlannedRun, type SkillsApi } from "@/lib/shell/use-skills";
import {
  SKILL_LIMITS, SKILL_SCOPE_LABEL, SKILL_SLUG, engineSummary, settingsLine,
  type EngineChoice, type SavableRun, type SkillScope, type SkillStatus, type SkillStep, type SkillTemplate, type SkillVersionView, type SkillView,
} from "@/lib/atomikSkillsText";
import { LoadBanner } from "../TakeTile";
import styles from "./skills-view.module.css";

/**
 * Atomik › Skills, built in Particl: runs saved to be run again with new
 * words — every skill this person may see (the workspace's, and their own),
 * searchable, each with its steps, parameters and every version it has had.
 *
 * Saving, browsing and editing are free. Running a skill plans its steps for
 * nothing and files them in Atomik, where each waits for its own quote and a
 * person's Continue — shown here, below the run. Archive hides a skill from
 * this list and from `/` in the composer; Restore brings it back. Nothing is
 * deleted.
 */

const when = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const engineName = (id: string, engines: readonly EngineChoice[] = []) =>
  engines.find((e) => e.id === id)?.label ?? MODELS.find((m) => m.id === id)?.label ?? (id === "elevenlabs" ? "Voice, sound and music" : id);
const who = (you: boolean, name: string | null) => (you ? "you" : name ?? "a teammate");

export function SkillsView({ scope, project }: { scope: string; project: Project | null }) {
  /* Runs file into the production the team shares, as Memory keeps to it. */
  const productionId = project?.productionProjectId ?? null;
  const [status, setStatus] = useState<SkillStatus>("active");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const list = useSkills(scope, status);
  const api = list.api;
  const q = query.trim().toLowerCase().replace(/^\//, "");
  const shown = q ? list.skills.filter((s) => [s.name, s.slug, s.description, ...s.template.parameters.map((p) => p.label)].some((t) => t.toLowerCase().includes(q))) : list.skills;
  const ready = list.status === "ready";
  const searchId = useId();

  if (open) return <SkillDetail key={open} id={open} api={api} productionId={productionId} onBack={() => setOpen(null)} />;
  return (
    <div className="sk tc am gx-enter" data-testid="skills-view" aria-busy={list.status === "loading"}>
      <p className="tc-intro">Runs saved to run again with new words: type its /command in Atomik, or run it here. Saving and browsing are free; a run costs what its steps cost, each quoted before it runs.</p>
      <section className="tc-card" aria-labelledby="sk-list" data-testid="skills-list">
        <div className="tc-head">
          <h2 className="tc-title" id="sk-list">{status === "archived" ? "Archived skills" : "Skills"}</h2>
          {ready ? <span className="tc-summary">{shown.length} {shown.length === 1 ? "skill" : "skills"}</span> : null}
        </div>
        <div className={styles.toolbar}>
          <div className="gx-seg" role="group" aria-label="Show">
            {(["active", "archived"] as const).map((s) => (
              <button key={s} type="button" className="gx-seg-btn" aria-pressed={status === s} onClick={() => setStatus(s)} data-testid={`skills-show-${s}`}><span>{s === "active" ? "Active" : "Archived"}</span></button>
            ))}
          </div>
          <input id={searchId} type="search" className={`gx-field ${styles.search}`} placeholder="Search by name or /command" aria-label="Search skills"
            value={query} onChange={(e) => setQuery(e.target.value)} data-testid="skills-search" />
        </div>
        {list.status === "error" ? <LoadBanner banner={{ tone: "error", message: list.error ?? "Skills could not be loaded." }} onRetry={list.refresh} testId="skills-error" /> : null}
        {list.status === "loading" && !list.skills.length ? <p className="tc-pad gx-empty" role="status">Reading skills…</p>
          : shown.length ? shown.map((s) => <SkillRow key={`${s.id}:${s.version}:${s.status}`} skill={s} onOpen={() => setOpen(s.id)} />)
          : ready ? <p className="tc-pad gx-empty" data-testid="skills-empty">{q ? `No skill matches “${query.trim()}”.` : status === "archived" ? "Nothing archived." : "No skills yet. Save a run as a skill: below, or with Save as skill in Atomik."}</p> : null}
      </section>
      {status === "active" ? <SaveFromRun api={api} productionId={productionId} onSaved={(skill) => { setQuery(""); setOpen(skill.id); }} /> : null}
    </div>
  );
}

function SkillRow({ skill, onOpen }: { skill: SkillView; onOpen: () => void }) {
  const n = skill.template.steps.length;
  return (
    <div className="am-row" data-testid="skill-row" data-slug={skill.slug} data-scope={skill.scope} data-status={skill.status}>
      <div className="am-body">
        <div className="am-head">
          <span className={styles.name}>{skill.name}</span>
          <span className={styles.command}>/{skill.slug}</span>
          <span className="tc-pill" data-testid="skill-scope">{SKILL_SCOPE_LABEL[skill.scope]}</span>
          <span className="tc-pill">v{skill.version}</span>
        </div>
        <p className="am-text">{skill.description}</p>
        <span className="am-meta" data-testid="skill-meta">
          {n} {n === 1 ? "step" : "steps"} · {engineSummary(skill.template, (id) => engineName(id))} · Made by {who(skill.byYou, skill.byName)}
          {skill.status === "archived" && skill.archivedAt ? ` · archived by ${who(skill.archivedByYou, skill.archivedByName)} ${when(skill.archivedAt)}` : ` · updated ${when(skill.updatedAt)}`}
        </span>
      </div>
      <div className="am-actions">
        <button type="button" className="gx-hbtn" onClick={onOpen} aria-label={`Open ${skill.name}`} data-testid="skill-open">Open</button>
      </div>
    </div>
  );
}

/* ── One skill ─────────────────────────────────────────────────────────── */

type Loaded = { skill: SkillView; versions: SkillVersionView[]; engines: EngineChoice[] };
type Mode = { kind: "view" } | { kind: "run" } | { kind: "edit" } | { kind: "archive" } | { kind: "version"; version: number };

function SkillDetail({ id, api, productionId, onBack }: { id: string; api: SkillsApi; productionId: string | null; onBack: () => void }) {
  const { toast } = useWorkspace();
  const [loaded, setLoaded] = useState<{ status: "loading" | "ready" | "error"; value: Loaded | null; error: string | null }>({ status: "loading", value: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [planned, setPlanned] = useState<PlannedRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    api.get(id).then((value) => { if (live) setLoaded({ status: "ready", value, error: null }); })
      .catch((error) => { if (live) setLoaded((previous) => ({ status: "error", value: previous.value, error: failed(error, "This skill could not be loaded. Try again.") })); });
    return () => { live = false; };
  }, [api, id, attempt]);

  const value = loaded.value;
  if (!value) {
    return (
      <div className="sk tc am gx-enter" data-testid="skill-detail">
        <button type="button" className={`gx-hbtn ${styles.back}`} onClick={onBack} data-testid="skill-back">← All skills</button>
        {loaded.status === "error"
          ? <LoadBanner banner={{ tone: "error", message: loaded.error ?? "This skill could not be loaded." }} onRetry={reload} testId="skill-error" />
          : <p className="gx-empty" role="status">Reading the skill…</p>}
      </div>
    );
  }
  const { skill, versions, engines } = value;
  const archived = skill.status === "archived";
  const act = async (work: () => Promise<SkillView>, said: string) => {
    setBusy(true); setProblem(null);
    try { await work(); toast(said); setMode({ kind: "view" }); reload(); }
    catch (error) { setProblem(failed(error, "That could not be done. Try again.")); }
    finally { setBusy(false); }
  };

  return (
    <div className="sk tc am gx-enter" data-testid="skill-detail" data-slug={skill.slug} data-status={skill.status}>
      <button type="button" className={`gx-hbtn ${styles.back}`} onClick={onBack} data-testid="skill-back">← All skills</button>
      <section className="tc-card" aria-labelledby="sk-detail">
        <div className={styles.detailHead}>
          <h2 className={styles.detailTitle} id="sk-detail" data-testid="skill-name">{skill.name}</h2>
          <span className={styles.command}>/{skill.slug}</span>
          <p className="am-text">{skill.description}</p>
          <div className={styles.pills}>
            <span className="tc-pill" data-testid="skill-scope">{SKILL_SCOPE_LABEL[skill.scope]}</span>
            <span className="tc-pill" data-testid="skill-version">Version {skill.version}</span>
            {archived ? <span className="tc-pill" data-testid="skill-archived">Archived</span> : null}
          </div>
          <span className="am-meta" data-testid="skill-provenance">
            Made by {who(skill.byYou, skill.byName)} · version {skill.version} by {who(skill.editedByYou, skill.editedByName)} · {when(skill.updatedAt)}
          </span>
        </div>
        {mode.kind === "archive" ? (
          <div className={styles.actions} role="group" aria-label="Archive this skill">
            <span className={styles.confirm} role="status">Archive /{skill.slug}? It leaves this list and / in Atomik. Restore brings it back as it is; nothing is deleted.</span>
            <button type="button" className="gx-hbtn tc-danger" disabled={busy} onClick={() => void act(() => api.archive(skill.id), `/${skill.slug} is archived. Restore it from Archived.`)} data-testid="skill-archive-confirm">{busy ? "Archiving…" : "Archive"}</button>
            <button type="button" className="gx-hbtn" disabled={busy} onClick={() => setMode({ kind: "view" })} data-testid="skill-archive-keep">Keep it</button>
          </div>
        ) : (
          <div className={styles.bar}>
            {archived ? (
              <button type="button" className="gx-primary" disabled={busy} onClick={() => void act(() => api.restore(skill.id), `/${skill.slug} is back.`)} data-testid="skill-restore">{busy ? "Restoring…" : "Restore"}</button>
            ) : (<>
              <button type="button" className="gx-primary" disabled={busy} aria-pressed={mode.kind === "run"} onClick={() => { setPlanned(null); setMode(mode.kind === "run" ? { kind: "view" } : { kind: "run" }); }} data-testid="skill-run">Run</button>
              <button type="button" className="gx-hbtn" disabled={busy} aria-pressed={mode.kind === "edit"} onClick={() => setMode(mode.kind === "edit" ? { kind: "view" } : { kind: "edit" })} data-testid="skill-edit">Edit</button>
              <button type="button" className="gx-hbtn" disabled={busy} onClick={() => setMode({ kind: "archive" })} data-testid="skill-archive">Archive</button>
            </>)}
          </div>
        )}
        {problem ? <p className="gx-gen-error" role="alert" data-testid="skill-problem">{problem}</p> : null}
      </section>

      {mode.kind === "run" && !archived ? (
        <section className="tc-card" aria-labelledby="sk-run" data-testid="skill-run-card">
          <div className="tc-head"><h2 className="tc-title" id="sk-run">Run /{skill.slug}</h2></div>
          {!productionId ? <p className="tc-pad gx-empty" data-testid="skill-run-no-project">Open a saved project to run a skill here; its takes file into that project.</p>
            : planned ? <RunInAtomik run={planned} productionId={productionId} />
            : <div className={styles.form}><SkillRunForm api={api} skill={skill} projectId={productionId} onPlanned={setPlanned} onCancel={() => setMode({ kind: "view" })} heading={false} /></div>}
        </section>
      ) : null}

      {mode.kind === "edit" && !archived ? (
        <EditSkill skill={skill} engines={engines} api={api} onDone={(saved) => { toast(`Saved as version ${saved.version}. Version ${saved.version - 1} is kept.`); setMode({ kind: "view" }); reload(); }} onCancel={() => setMode({ kind: "view" })} />
      ) : mode.kind === "version" ? (
        <VersionView id={skill.id} version={mode.version} api={api} engines={engines} onBack={() => setMode({ kind: "view" })} />
      ) : (
        <TemplateCard template={skill.template} engines={engines} title={`Version ${skill.version} · in use`} />
      )}

      <section className="tc-card" aria-labelledby="sk-versions" data-testid="skill-versions">
        <div className="tc-head">
          <h2 className="tc-title" id="sk-versions">Versions</h2>
          <span className="tc-summary">{versions.length} kept · an edit adds the next one</span>
        </div>
        {versions.map((v) => (
          <div key={v.version} className="am-row" data-testid="skill-version-row" data-version={v.version}>
            <div className="am-body">
              <div className="am-head">
                <span className={styles.name}>Version {v.version}</span>
                {v.version === skill.version ? <span className="tc-pill">In use</span> : null}
              </div>
              <span className="am-meta">{v.name} · by {who(v.byYou, v.byName)} · {when(v.createdAt)}{v.note ? ` · ${v.note}` : ""}</span>
            </div>
            <div className="am-actions">
              {v.version !== skill.version ? (
                <button type="button" className="gx-hbtn" aria-pressed={mode.kind === "version" && mode.version === v.version} onClick={() => setMode({ kind: "version", version: v.version })} aria-label={`View version ${v.version}`} data-testid="skill-version-view">View</button>
              ) : null}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

/** A template's steps and parameters, read-only: each placeholder shown as the parameter it is. */
function TemplateCard({ template, engines, title, testId = "skill-template" }: { template: SkillTemplate; engines: readonly EngineChoice[]; title: string; testId?: string }) {
  const labels = Object.fromEntries(template.parameters.map((p) => [p.key, p.label]));
  return (
    <section className="tc-card" aria-label={title} data-testid={testId}>
      <div className="tc-head"><h2 className="tc-title">{title}</h2><span className="tc-summary">{template.steps.length} {template.steps.length === 1 ? "step" : "steps"}</span></div>
      <ol className={styles.steps}>
        {template.steps.map((s, i) => (
          <li key={i} className={styles.step} data-testid="skill-step" data-model={s.model}>
            <span className={styles.stepN}>{String(i + 1).padStart(2, "0")}</span>
            <span className={styles.stepBody}>
              <span className={styles.stepTitle}><WithParameters text={s.title} labels={labels} /></span>
              <span className={styles.meta}>{s.kind} · {engineName(s.model, engines)}{settingsLine(s.params) ? ` · ${settingsLine(s.params)}` : ""}</span>
              <p className={styles.prompt}><WithParameters text={s.prompt} labels={labels} /></p>
            </span>
          </li>
        ))}
      </ol>
      <div className="tc-head"><h3 className="tc-title">Parameters</h3></div>
      {template.parameters.length ? (
        <ul className={styles.params}>
          {template.parameters.map((p) => (
            <li key={p.key} className={styles.param} data-testid="skill-parameter">
              <span><strong>{p.label}</strong> <span className={styles.paramKey}>{`{{${p.key}}}`}</span></span>
              <span data-testid="skill-parameter-default">{p.default}</span>
            </li>
          ))}
        </ul>
      ) : <p className="tc-pad gx-empty">None: a run uses the steps as they are.</p>}
    </section>
  );
}

function VersionView({ id, version, api, engines, onBack }: { id: string; version: number; api: SkillsApi; engines: readonly EngineChoice[]; onBack: () => void }) {
  const [state, setState] = useState<{ key: string; value: SkillVersionView | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${id}:${version}:${attempt}`;
  useEffect(() => {
    let live = true;
    api.version(id, version).then((value) => { if (live) setState({ key, value, error: null }); })
      .catch((error) => { if (live) setState({ key, value: null, error: failed(error, "That version could not be loaded. Try again.") }); });
    return () => { live = false; };
  }, [api, id, version, key]);
  const current = state?.key === key ? state : null;
  return (
    <div className={styles.form} data-testid="skill-old-version">
      <div className={styles.actions}><button type="button" className="gx-hbtn" onClick={onBack} data-testid="skill-version-back">Back to the version in use</button></div>
      {current?.error ? <LoadBanner banner={{ tone: "error", message: current.error }} onRetry={() => setAttempt((n) => n + 1)} testId="skill-version-error" />
        : current?.value?.template ? (<>
          <p className="tc-note" data-testid="skill-version-meta">Version {current.value.version}: “{current.value.name}” · /{current.value.slug} · {SKILL_SCOPE_LABEL[current.value.scope]} · by {who(current.value.byYou, current.value.byName)} · {when(current.value.createdAt)}{current.value.note ? ` · ${current.value.note}` : ""}. Read-only.</p>
          <TemplateCard template={current.value.template} engines={engines} title={`Version ${current.value.version} · read-only`} testId="skill-version-template" />
        </>) : <p className="gx-empty" role="status">Reading version {version}…</p>}
    </div>
  );
}

/* ── Editing: the next version ─────────────────────────────────────────── */

export function EditSkill({ skill, engines, api, onDone, onCancel }: { skill: SkillView; engines: EngineChoice[]; api: SkillsApi; onDone: (saved: SkillView) => void; onCancel: () => void }) {
  const [name, setName] = useState(skill.name);
  const [slug, setSlug] = useState(skill.slug);
  const [description, setDescription] = useState(skill.description);
  const [scope, setScope] = useState<SkillScope>(skill.scope);
  const [note, setNote] = useState("");
  const [parameters, setParameters] = useState(skill.template.parameters);
  const [steps, setSteps] = useState<SkillStep[]>(skill.template.steps);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = { name: useId(), slug: useId(), description: useId(), note: useId() };
  const keys = parameters.map((p) => `{{${p.key}}}`).join(", ");
  const setStep = (i: number, next: Partial<SkillStep>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...next } : s)));
  const moveEngine = (i: number, model: string) => {
    const engine = engines.find((e) => e.id === model);
    const s = steps[i];
    if (!engine) return setStep(i, { model });
    /* The settings follow the engine: a value it lacks moves to its first; the server snaps to the nearest. */
    setStep(i, { model, params: {
      ...s.params,
      ...(engine.ratios.length ? { ratio: s.params.ratio && engine.ratios.includes(s.params.ratio) ? s.params.ratio : engine.ratios[0] } : {}),
      ...(engine.resolutions.length ? { resolution: s.params.resolution && engine.resolutions.includes(s.params.resolution) ? s.params.resolution : engine.resolutions[0] } : {}),
      ...(engine.durations.length ? { seconds: s.params.seconds && engine.durations.includes(s.params.seconds) ? s.params.seconds : engine.durations[0] } : {}),
    } });
  };
  const valid = name.trim().length >= 2 && description.trim().length >= 3 && SKILL_SLUG.test(slug) && steps.every((s) => s.prompt.trim().length >= 3);
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true); setProblem(null);
    try {
      onDone(await api.edit(skill.id, {
        expectedVersion: skill.version, name, slug, description, note,
        ...(skill.canChangeScope ? { scope } : {}),
        template: { steps, parameters },
      }));
    } catch (error) { setProblem(failed(error, "That edit could not be saved. Try again.")); }
    finally { setBusy(false); }
  };
  return (
    <section className="tc-card" aria-labelledby="sk-edit" data-testid="skill-edit-form">
      <div className="tc-head">
        <h2 className="tc-title" id="sk-edit">Edit · saves as version {skill.version + 1}</h2>
        <span className="tc-summary">Version {skill.version} stays as it is</span>
      </div>
      <div className={styles.form}>
        <label className={styles.label} htmlFor={ids.name}>Name</label>
        <input id={ids.name} className="gx-field" value={name} maxLength={SKILL_LIMITS.name} onChange={(e) => setName(e.target.value)} data-testid="skill-edit-name" />
        <label className={styles.label} htmlFor={ids.slug}>Command</label>
        <input id={ids.slug} className="gx-field" value={`/${slug}`} maxLength={SKILL_LIMITS.slug + 1} spellCheck={false} autoCapitalize="none"
          onChange={(e) => setSlug(e.target.value.replace(/^\/+/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-"))} data-testid="skill-edit-slug" />
        <label className={styles.label} htmlFor={ids.description}>What it makes, in a line</label>
        <input id={ids.description} className="gx-field" value={description} maxLength={SKILL_LIMITS.description} onChange={(e) => setDescription(e.target.value)} data-testid="skill-edit-description" />
        {skill.canChangeScope ? (
          <div className={styles.label} role="group" aria-label="Who sees it">
            Who sees it
            <div className="gx-seg">
              {(["personal", "workspace"] as const).map((s) => (
                <button key={s} type="button" className="gx-seg-btn" aria-pressed={scope === s} onClick={() => setScope(s)} data-testid={`skill-edit-scope-${s}`}><span>{SKILL_SCOPE_LABEL[s]}</span></button>
              ))}
            </div>
          </div>
        ) : <p className="tc-note">{SKILL_SCOPE_LABEL[skill.scope]}. Only the person who made it changes who sees it.</p>}
      </div>

      <div className="tc-head"><h3 className="tc-title">Parameters</h3></div>
      {parameters.length ? parameters.map((p, i) => (
        <div key={p.key} className={`${styles.editParam} ${styles.editStep}`} data-testid="skill-edit-param">
          <label className={styles.label}>{`{{${p.key}}}`} is called
            <input className="gx-field" value={p.label} maxLength={SKILL_LIMITS.label} onChange={(e) => setParameters(parameters.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} data-testid="skill-edit-param-label" />
          </label>
          <label className={styles.label}>Default
            <input className="gx-field" value={p.default} maxLength={SKILL_LIMITS.value} onChange={(e) => setParameters(parameters.map((x, j) => (j === i ? { ...x, default: e.target.value } : x)))} data-testid="skill-edit-param-default" />
          </label>
        </div>
      )) : <p className="tc-pad gx-empty">None.</p>}

      <div className="tc-head"><h3 className="tc-title">Steps</h3>{keys ? <span className="tc-summary">Write parameters as {keys}</span> : null}</div>
      {steps.map((s, i) => {
        const offered = engines.filter((e) => e.kind === s.kind);
        const engine = engines.find((e) => e.id === s.model);
        return (
          <div key={i} className={styles.editStep} data-testid="skill-edit-step">
            <label className={styles.label}>Step {i + 1} title
              <input className="gx-field" value={s.title} maxLength={SKILL_LIMITS.title} onChange={(e) => setStep(i, { title: e.target.value })} data-testid="skill-edit-step-title" />
            </label>
            <label className={styles.label}>Prompt
              <textarea className="gx-textarea" rows={4} maxLength={SKILL_LIMITS.prompt} value={s.prompt} onChange={(e) => setStep(i, { prompt: e.target.value })} data-testid="skill-edit-step-prompt" />
            </label>
            {s.kind === "audio" ? <span className={styles.meta}>{engineName(s.model, engines)}{settingsLine(s.params) ? ` · ${settingsLine(s.params)}` : ""}</span> : (
              <div className={styles.settings}>
                <label className={styles.label}>Engine
                  <select className="gx-select" value={s.model} onChange={(e) => moveEngine(i, e.target.value)} data-testid="skill-edit-step-engine">
                    {!engine ? <option value={s.model}>{`${engineName(s.model, engines)} (can’t run here now)`}</option> : null}
                    {offered.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
                  </select>
                </label>
                {engine?.ratios.length ? (
                  <label className={styles.label}>Shape
                    <select className="gx-select" value={s.params.ratio ?? engine.ratios[0]} onChange={(e) => setStep(i, { params: { ...s.params, ratio: e.target.value } })} data-testid="skill-edit-step-ratio">
                      {engine.ratios.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </label>
                ) : null}
                {engine?.resolutions.length ? (
                  <label className={styles.label}>Size
                    <select className="gx-select" value={s.params.resolution ?? engine.resolutions[0]} onChange={(e) => setStep(i, { params: { ...s.params, resolution: e.target.value } })} data-testid="skill-edit-step-resolution">
                      {engine.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </label>
                ) : null}
                {engine?.durations.length ? (
                  <label className={styles.label}>Length
                    <select className="gx-select" value={String(s.params.seconds ?? engine.durations[0])} onChange={(e) => setStep(i, { params: { ...s.params, seconds: Number(e.target.value) } })} data-testid="skill-edit-step-seconds">
                      {engine.durations.map((d) => <option key={d} value={d}>{d}s</option>)}
                    </select>
                  </label>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
      <div className={styles.form}>
        <label className={styles.label} htmlFor={ids.note}>What changed (optional)</label>
        <input id={ids.note} className="gx-field" value={note} maxLength={SKILL_LIMITS.note} onChange={(e) => setNote(e.target.value)} placeholder="Warmer light on the hero still" data-testid="skill-edit-note" />
        {problem ? <p className="gx-gen-error" role="alert" data-testid="skill-edit-problem">{problem}</p> : null}
        <div className={styles.actions}>
          <button type="button" className="gx-primary" disabled={!valid || busy} onClick={() => void save()} data-testid="skill-edit-save">{busy ? "Saving…" : `Save version ${skill.version + 1}`}</button>
          <button type="button" className="gx-hbtn" disabled={busy} onClick={onCancel} data-testid="skill-edit-cancel">Cancel</button>
        </div>
      </div>
    </section>
  );
}

/* ── Saving a run from here ────────────────────────────────────────────── */

function SaveFromRun({ api, productionId, onSaved }: { api: SkillsApi; productionId: string | null; onSaved: (skill: SkillView) => void }) {
  const { toast } = useWorkspace();
  const [runs, setRuns] = useState<{ key: string; value: SavableRun[] | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  const key = `${productionId ?? ""}:${attempt}`;
  useEffect(() => {
    let live = true;
    api.runs(productionId).then((value) => { if (live) setRuns({ key, value, error: null }); })
      .catch((error) => { if (live) setRuns({ key, value: null, error: failed(error, "Runs could not be loaded. Try again.") }); });
    return () => { live = false; };
  }, [api, productionId, key]);
  const current = runs?.key === key ? runs : null;
  return (
    <section className="tc-card" aria-labelledby="sk-runs" data-testid="skills-runs">
      <div className="tc-head">
        <h2 className="tc-title" id="sk-runs">Save a run as a skill</h2>
        <span className="tc-summary">{productionId ? "Atomik runs in this project" : "Recent Atomik runs"}</span>
      </div>
      {saving ? (
        <div className={styles.form}>
          <SaveSkillForm api={api} chatId={saving} onSaved={(skill) => { setSaving(null); toast(`Saved as /${skill.slug}.`); onSaved(skill); }} onCancel={() => setSaving(null)} heading={false} />
        </div>
      ) : current?.error ? <LoadBanner banner={{ tone: "error", message: current.error }} onRetry={() => setAttempt((n) => n + 1)} testId="skills-runs-error" />
        : !current ? <p className="tc-pad gx-empty" role="status">Reading runs…</p>
        : current.value?.length ? current.value.map((r) => (
          <div key={r.chatId} className="am-row" data-testid="skills-run-row">
            <div className="am-body">
              <span className={styles.name}>{r.title}</span>
              <span className="am-meta">{r.steps} {r.steps === 1 ? "step" : "steps"} · {when(r.updatedAt)}</span>
            </div>
            <div className="am-actions">
              <button type="button" className="gx-hbtn" onClick={() => setSaving(r.chatId)} aria-label={`Save ${r.title} as a skill`} data-testid="skills-run-save">Save as skill</button>
            </div>
          </div>
        )) : <p className="tc-pad gx-empty" data-testid="skills-runs-empty">No Atomik runs with steps yet. Ask Atomik for something, then save its plan here.</p>}
    </section>
  );
}

/* ── The run, in Atomik ────────────────────────────────────────────────── */

/**
 * The run a skill just planned, in the same Atomik conversation the rail
 * shows (components/atomik/AtomikProvider.tsx): its first proposed step is
 * the checkpoint, priced live by the route that will render it, and Continue
 * approves that step alone at that price. Nothing runs by itself.
 */
function RunInAtomik({ run, productionId }: { run: PlannedRun; productionId: string }) {
  return (
    <ProjectProvider>
      <AtomikProvider>
        <RunSteps run={run} productionId={productionId} />
      </AtomikProvider>
    </ProjectProvider>
  );
}

function RunSteps({ run, productionId }: { run: PlannedRun; productionId: string }) {
  const project = useProject();
  const a = useAtomik();
  const { setSelection, selection } = project;
  /* The conversation is the production's: this one, so its chat is the one on screen. */
  useEffect(() => { if (selection !== productionId) setSelection(productionId); }, [selection, setSelection, productionId]);
  /* After the provider above is listening (its effects run after this one's). */
  useEffect(() => {
    const timer = setTimeout(() => openAtomikChat({ chatId: run.chatId, projectId: productionId }), 0);
    return () => clearTimeout(timer);
  }, [run.chatId, productionId]);
  const mine = a.chat?.id === run.chatId;
  const steps = useMemo(() => (mine ? a.plan : []), [mine, a.plan]);
  if (!mine) return <p className="tc-pad gx-empty" role="status" data-testid="skill-run-opening">Opening the plan in Atomik…</p>;
  const checkpoint = a.current.kind === "checkpoint" ? a.current.step : null;
  const done = steps.filter((s) => s.status === "done").length;
  const price = (n: number | null, billed: boolean) => (n === null ? null : billed ? a.fmt(n) : `about ${a.fmt(n)}`);
  return (
    <div className={styles.form} data-testid="skill-run-approval">
      <p className="tc-note">Planned in Atomik as “{a.chat?.title}”. {done} of {steps.length} done. Each step waits for your Continue at the price shown; the rail shows the same plan.</p>
      <ol className={styles.steps} aria-label="Planned steps">
        {steps.map((s, i) => {
          const n = a.credits(s);
          return (
            <li key={s.id} className={styles.step} data-testid="skill-plan-step" data-status={s.status}>
              <span className={styles.stepN}>{String(i + 1).padStart(2, "0")}</span>
              <span className={styles.stepBody}>
                <span className={styles.stepTitle}>{s.title}</span>
                <span className={styles.meta}>{a.engineLabel(s.model)} · {s.status === "proposed" ? (checkpoint?.id === s.id ? "checkpoint" : "waiting") : s.status}</span>
              </span>
              <span className={styles.price} data-testid="skill-plan-price">{price(n, s.status === "done") ?? a.priceLabel(s)}</span>
            </li>
          );
        })}
      </ol>
      {checkpoint ? (
        <div className={styles.checkpoint} role="group" aria-label="Checkpoint" data-testid="skill-checkpoint">
          <p className={styles.checkpointLine}>Next: {checkpoint.title} on {a.engineLabel(checkpoint.model)}. Continue approves this step at the price shown; nothing else runs.</p>
          <div className={styles.actions}>
            <button type="button" className="gx-primary" disabled={!a.approvable(checkpoint) || a.busy} onClick={() => void a.approve(checkpoint)} data-testid="skill-continue">
              {a.busy ? "Starting…" : a.approvable(checkpoint) && a.credits(checkpoint) !== null ? `Continue · about ${a.fmt(a.credits(checkpoint)!)}` : "Pricing…"}
            </button>
            <button type="button" className="gx-hbtn" disabled={a.busy} onClick={() => void a.stop(checkpoint)} data-testid="skill-stop">Stop here</button>
          </div>
          {a.stepQuoteError ? <p className="gx-gen-error" role="alert" data-testid="skill-quote-error">{a.stepQuoteError}</p> : null}
        </div>
      ) : a.current.kind === "done" ? <p className="tc-note" role="status" data-testid="skill-run-done">Every step has run. The takes are in the project.</p>
        : a.current.kind === "planning" ? <p className="tc-note" role="status">Atomik is planning in this chat.</p> : null}
      {a.error ? <p className="gx-gen-error" role="alert" data-testid="skill-run-error">{a.error}</p> : null}
    </div>
  );
}

/** The Inspector's page body here: what skills are, and what they cost. */
export function SkillsInspector() {
  return (
    <div className="tc-insp" data-inspector-body="skills">
      <span className="tc-insp-title">Skills</span>
      <span className="tc-insp-sub">Atomik Agent</span>
      <p className="tc-insp-note">Saving, browsing and editing are free. A run plans its steps for nothing, then each step waits for its own quote and your Continue. An edit adds a version; Archive hides a skill and Restore brings it back. Nothing is deleted.</p>
    </div>
  );
}
