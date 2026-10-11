"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import { useShell } from "@/lib/shell/state";
import { failed, openAtomikChat, useSkills, type PlannedRun } from "@/lib/shell/use-skills";
import { engineProblemText, settingsLine, type EngineChoice, type SavableRun, type SkillRunPreview, type SkillVersionView, type SkillView } from "@/lib/atomikSkillsText";
import { priceSum, upTo } from "@/lib/shell/price-words";
import { SaveSkillDialog } from "@/components/atomik/skills/SkillForms";
import { EditSkill } from "../atomik/SkillsView";
import { LoadBanner } from "../TakeTile";
import { Price } from "../Price";
import { ThreadCheckpoint } from "./ThreadCheckpoint";
import { when } from "./words";

/**
 * Control room › Skills (Atomik frame i; README § 3.4, § 4 "Run again with new
 * words"): saved runs, run again with new words. Built on Atomik's skills
 * (lib/atomikSkills.ts through lib/shell/use-skills.ts): saving, browsing and
 * editing are free, and running a skill files its steps in an Atomik thread
 * for nothing. Each step then waits for its own Continue at its live price
 * (the plan's checkpoint, shown here), so the figure on screen is the steps'
 * estimate, not a charge: nothing is spent until a person continues a step.
 */
export function SkillsRoom({ scope, project }: { scope: string; project: Project | null }) {
  const list = useSkills(scope, "active");
  const api = list.api;
  const productionId = project?.productionProjectId ?? null;
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.skills.filter((k) => !q || `${k.name} /${k.slug}`.toLowerCase().includes(q));
  }, [list.skills, query]);
  const current = list.skills.find((k) => k.id === picked) ?? shown[0] ?? null;

  return (
    <div className="cr-body cr-body--skills" data-testid="skills">
      <section className="cr-col" aria-label="Skills">
        {list.error ? <LoadBanner banner={{ tone: list.skills.length ? "stale" : "error", message: list.error }} onRetry={list.refresh} testId="skills-error" /> : null}
        <div className="cr-block">
          <div className="cr-block-head">
            <span className="cr-eyebrow">Skills</span>
            {list.status === "ready" ? <span className="cr-count">{list.skills.length} {list.skills.length === 1 ? "skill" : "skills"}</span> : null}
          </div>
          <input className="cr-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or /command" aria-label="Search skills" data-testid="skills-search" />
          {list.status === "loading" && !list.skills.length ? <p className="cr-empty" role="status" aria-busy="true">Reading skills…</p>
            : shown.length ? (
              <ul className="cr-list" aria-label="Saved skills">
                {shown.map((k) => (
                  <li key={k.id}>
                    <button type="button" className="cr-skill" aria-current={k.id === current?.id || undefined} onClick={() => setPicked(k.id)} data-testid="skill-row">
                      <span className="cr-min">
                        <span className="cr-slug">/{k.slug}</span>
                        <span className="cr-decided-title">{k.name}</span>
                        <span className="cr-decided-line">{k.template.steps.length} {k.template.steps.length === 1 ? "step" : "steps"} · {k.editedByYou ? "edited by you" : k.editedByName ? `edited by ${k.editedByName}` : "saved"} · {when(k.updatedAt)}</span>
                      </span>
                      <span className="cr-run-n">v{k.version}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : list.status === "ready" ? (
              <p className="cr-empty" data-testid="skills-empty">{query.trim() ? `No skill matches “${query.trim()}”.` : "No skills yet. A done run becomes one below."}</p>
            ) : null}
        </div>
        <SaveFromRun scope={scope} api={api} productionId={productionId} onSaved={(skill) => { void list.refresh(); setPicked(skill.id); }} />
      </section>
      <section className="cr-col" aria-label="The skill">
        {current ? <SkillDetail key={current.id} skill={current} api={api} productionId={productionId} onChanged={(skill) => { void list.refresh(); setPicked(skill.id); }} /> : null}
      </section>
    </div>
  );
}

type Api = ReturnType<typeof useSkills>["api"];

/** "Save a run as a skill": a done run of this project, saved through the existing form. */
function SaveFromRun({ scope, api, productionId, onSaved }: { scope: string; api: Api; productionId: string | null; onSaved: (skill: SkillView) => void }) {
  const [runs, setRuns] = useState<SavableRun[] | null>(null);
  const [chatId, setChatId] = useState("");
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.runs(productionId).then((r) => { if (live) { setRuns(r); setProblem(null); } }).catch((e) => { if (live) setProblem(failed(e, "Runs could not be loaded. Try again.")); });
    return () => { live = false; };
  }, [api, productionId, scope]);
  return (
    <div className="cr-block" data-testid="skills-save">
      <span className="cr-eyebrow">Save a run as a skill</span>
      <p className="cr-text">A done run becomes a skill: its steps and parameters, none of its outputs, approvals or provider results. Run it again with new words.</p>
      <select className="cr-input" value={chatId} onChange={(e) => setChatId(e.target.value)} aria-label="Done run" data-testid="skills-save-run">
        <option value="">Choose a done run…</option>
        {(runs ?? []).map((r) => <option key={r.chatId} value={r.chatId}>{r.title} · {r.steps} {r.steps === 1 ? "step" : "steps"}</option>)}
      </select>
      {problem ? <p className="cr-row-error" role="alert">{problem}</p> : null}
      <button type="button" className="cr-btn cr-align-end" disabled={!chatId} onClick={() => setOpen(true)} data-testid="skills-save-open">Save as skill</button>
      {open && chatId ? <SaveSkillDialog api={api} chatId={chatId} onSaved={(skill) => { setOpen(false); setChatId(""); onSaved(skill); }} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** One skill: what it does, its parameters, its steps with their estimates, Run, Edit, and its versions. */
function SkillDetail({ skill, api, productionId, onChanged }: { skill: SkillView; api: Api; productionId: string | null; onChanged: (skill: SkillView) => void }) {
  const shell = useShell();
  const [engines, setEngines] = useState<EngineChoice[]>([]);
  const [versions, setVersions] = useState<SkillVersionView[]>([]);
  const [viewing, setViewing] = useState<SkillVersionView | null>(null);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(skill.template.parameters.map((p) => [p.key, p.default])));
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ key: string; value: SkillRunPreview | null; error: string | null } | null>(null);
  const [run, setRun] = useState<PlannedRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get(skill.id).then((r) => { if (live) { setEngines(r.engines); setVersions(r.versions); } }).catch(() => { /* the detail still shows what the list holds */ });
    return () => { live = false; };
  }, [api, skill.id, skill.version]);

  const empty = skill.template.parameters.filter((p) => !(values[p.key] ?? "").trim());
  const key = JSON.stringify([values, chosen, skill.version]);
  useEffect(() => {
    if (empty.length) return;
    let live = true;
    /* The free preview: each step filled with these words, on its engine, with its estimate. */
    const timer = setTimeout(() => {
      api.preview(skill.id, { values, engines: chosen })
        .then((value) => { if (live) setPreview({ key, value, error: null }); })
        .catch((e) => { if (live) setPreview({ key, value: null, error: failed(e, "The skill could not be previewed. Try again.") }); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [api, skill.id, values, chosen, key, empty.length]);

  const fresh = preview?.key === key ? preview.value : null;
  const steps = (fresh ?? preview?.value)?.steps ?? [];
  const problems = fresh?.problems ?? [];
  /* Credits only: a step's estimate as "up to", the figure its Continue is capped at once priced live (lead decision 6: no dollars). */
  const prices = steps.map((s) => (s.estCredits == null ? null : upTo(s.estCredits)));
  const unpriced = prices.filter((p) => p === null).length;
  const total = prices.some((p) => p !== null) ? priceSum(prices.filter((p) => p !== null)) : null;
  const ready = Boolean(fresh) && !problems.length && !empty.length && !busy && !!productionId;

  const plan = useCallback(async () => {
    if (!ready) return;
    setBusy(true); setProblem(null);
    try { setRun(await api.run(skill.id, { values, engines: chosen, projectId: productionId })); }
    catch (e) { setProblem(failed(e, "The skill could not be planned. Try again.")); }
    finally { setBusy(false); }
  }, [ready, api, skill.id, values, chosen, productionId]);

  if (editing) {
    return (
      <div className="cr-block" data-testid="skill-editing">
        <EditSkill skill={skill} engines={engines} api={api} onDone={(saved) => { setEditing(false); onChanged(saved); }} onCancel={() => setEditing(false)} />
      </div>
    );
  }
  return (
    <>
      <div className="cr-block" data-testid="skill-detail">
        <div className="cr-block-head">
          <h2 className="cr-h2" data-testid="skill-slug">/{skill.slug}</h2>
          <span className="cr-count">v{skill.version} · {skill.editedByYou ? "edited by you" : skill.editedByName ? `edited by ${skill.editedByName}` : "saved"} · {when(skill.updatedAt)}</span>
        </div>
        {skill.description ? <p className="cr-text">{skill.description}</p> : null}
        <span className="cr-eyebrow">Parameters</span>
        {skill.template.parameters.length ? (
          <div className="cr-params">
            {skill.template.parameters.map((p) => (
              <label key={p.key} className="cr-label">{p.label}
                <input className="cr-input" value={values[p.key] ?? ""} placeholder={p.default} onChange={(e) => { setValues({ ...values, [p.key]: e.target.value }); setRun(null); }} data-testid={`skill-param-${p.key}`} />
              </label>
            ))}
          </div>
        ) : <p className="cr-text">This skill takes no parameters; it reads the project as it stands.</p>}
        {empty.length ? <p className="cr-row-why" role="alert">Fill in {empty.map((p) => p.label).join(", ")}.</p> : null}
        <span className="cr-eyebrow">Steps</span>
        {problems.map((p) => (
          <div key={p.step} className="cr-text" role="group" aria-label={`Engine for step ${p.step + 1}`} data-testid="skill-engine-problem">
            <p className="cr-row-why">Step {p.step + 1}, {p.title}: {engineProblemText(p)}</p>
            <div className="cr-row-actions">
              {p.choices.slice(0, 3).map((c) => <button key={c.id} type="button" className="cr-btn" onClick={() => setChosen({ ...chosen, [p.step]: c.id })}>Use {c.label}</button>)}
            </div>
          </div>
        ))}
        {steps.length ? (
          <ol className="cr-list" aria-label="Steps" data-testid="skill-steps">
            {steps.map((s, i) => (
              <li key={s.index} className="cr-step cr-step--n" data-testid="skill-step">
                <span className="cr-run-n">{String(s.index + 1).padStart(2, "0")}</span>
                <span className="cr-min">
                  <span className="cr-decided-title">{s.title}</span>
                  <span className="cr-decided-line">{[s.label, settingsLine(s.params)].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="cr-figure cr-right">{prices[i] ? <Price value={prices[i]} /> : "priced at its Continue"}</span>
              </li>
            ))}
          </ol>
        ) : empty.length ? null : preview?.error ? <p className="cr-row-error" role="alert">{preview.error}</p> : <p className="cr-empty" role="status">Filling in the steps…</p>}
        <p className="cr-text" data-testid="skill-foot">
          {total ? <>Steps together: <Price value={total} />{unpriced ? `, and ${unpriced} priced at ${unpriced === 1 ? "its" : "their"} Continue` : ""}. </> : null}
          Running files the steps in Atomik for nothing; each then waits for its own Continue at its live price.
        </p>
        {!productionId ? <p className="cr-row-why" data-testid="skill-no-project">Open a project to run this skill in it.</p> : null}
        {problem ? <p className="cr-row-error" role="alert">{problem}</p> : null}
        <div className="cr-row-actions">
          <button type="button" className="cr-btn" onClick={() => setEditing(true)} data-testid="skill-edit">Edit · saves as v{skill.version + 1}</button>
          <button type="button" className="cr-primary" disabled={!ready} onClick={() => void plan()} data-testid="skill-run">{busy ? "Planning…" : `Run /${skill.slug}`}</button>
        </div>
        {run && productionId ? (
          <div data-testid="skill-run-planned">
            <p className="cr-text">Planned in Atomik. Each step waits for your Continue at the price shown.</p>
            <ThreadCheckpoint chatId={run.chatId} productionId={productionId} />
            <button type="button" className="cr-link" onClick={() => { openAtomikChat({ chatId: run.chatId, projectId: productionId }); shell.goSuite("atomik", "agent"); }} data-testid="skill-open-atomik">Open in Atomik ›</button>
          </div>
        ) : null}
      </div>
      <div className="cr-block" data-testid="skill-versions">
        <span className="cr-eyebrow">Versions</span>
        {(versions.length ? versions : [{ version: skill.version } as SkillVersionView]).map((v) => (
          <div key={v.version} className="cr-decided">
            <span className="cr-dot" data-tone={v.version === skill.version ? "accent" : "quiet"} aria-hidden="true" />
            <span className="cr-min">
              <span className="cr-decided-title">v{v.version}{v.version === skill.version ? " · current" : ""}</span>
              <span className="cr-decided-line">{v.version === skill.version ? "runs when you press Run" : `kept as it was${v.createdAt ? ` · ${when(v.createdAt)}` : ""}`}{v.note ? ` · ${v.note}` : ""}</span>
            </span>
            {v.version === skill.version ? null : (
              <button type="button" className="cr-btn" onClick={() => void api.version(skill.id, v.version).then(setViewing).catch(() => setViewing(null))} data-testid="skill-version-view">View</button>
            )}
          </div>
        ))}
        {viewing?.template ? (
          <div className="cr-checkpoint" data-testid="skill-version-steps">
            <span className="cr-eyebrow">v{viewing.version}</span>
            <ol className="cr-list">{viewing.template.steps.map((s, i) => <li key={i} className="cr-decided-line">{String(i + 1).padStart(2, "0")} · {s.title}</li>)}</ol>
            <button type="button" className="cr-btn cr-align-end" onClick={() => setViewing(null)}>Close</button>
          </div>
        ) : null}
      </div>
    </>
  );
}
