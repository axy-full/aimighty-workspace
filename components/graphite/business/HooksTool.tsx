"use client";
import { useState } from "react";
import { AtomikRunDialog } from "@/components/workbench/AtomikRunDialog";
import { useWorkspace } from "@/lib/workspace/state";
import { OWN_LIMITS, aboutCredits, briefHooks, hooksRequest, mergeHooks, type OwnPage } from "@/lib/shell/business-own";
import { CardHead, Field, SaveLine, briefOf, changeBrief, useLatest, type OwnEditor } from "./own-kit";
import { useOwnAgent } from "./use-own-agent";

/** Only the suite agents' planners (Anthropic, OpenAI) run the Campaign agent (lib/workbench/atomik-server.ts). */
const SUITE_MODEL = /^(anthropic|openai)\//;
const REQUEST_MAX = 4000;

/**
 * Business › Hooks: up to twelve opening lines for the campaign, written by
 * hand or by the Campaign agent against the brand kit, the product's approved
 * facts and the chosen brief (the existing Atomik suite agent, `moleculr`).
 * The agent is paid: the Atomik dialog shows its approximate price before it
 * runs, and nothing it writes joins the list until you take it.
 */
export function HooksTool({ scope, editor, onOpen }: { scope: string; editor: OwnEditor; onOpen: (page: OwnPage) => void }) {
  const p = editor.project!;
  const latest = useLatest(p);
  const { toast } = useWorkspace();
  const brief = briefOf(p);
  const hooks = brief.hooks;
  const [request, setRequest] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const saved = Boolean(p.productionProjectId);
  const agent = useOwnAgent(scope, p.id, saved);
  const models = agent.data?.models.filter((m) => SUITE_MODEL.test(m.id)) ?? [];
  const configured = Boolean(agent.data?.configured) && models.length > 0;
  const runs = (agent.data?.jobs ?? []).filter((job) => job.suite === "moleculr" || job.plan?.suiteAgent?.suite === "moleculr").slice(0, 4);
  const asked = request ?? hooksRequest(brief);
  const setHooks = (next: string[]) => changeBrief(editor, (b) => ({ ...b, hooks: next.slice(0, OWN_LIMITS.hooks).map((h) => h.slice(0, OWN_LIMITS.hookChars)) }));
  const take = (proposed: string[]) => {
    const merged = mergeHooks(briefOf(latest.current).hooks, proposed);
    changeBrief(editor, (b) => ({ ...b, hooks: merged.hooks }));
    void editor.ensureSaved();
    toast(merged.added ? `${merged.added} ${merged.added === 1 ? "hook" : "hooks"} added${merged.skipped ? ` · ${merged.skipped} did not fit in twelve` : ""}` : merged.skipped ? "The list already holds twelve hooks." : "Those hooks are on the list already.");
  };
  const blocked = !saved ? "Save the project first: the agent reads its saved brief." : !agent.data ? (agent.error ? "The agent’s runs could not be read. Try again below." : "Reading the agent’s runs…")
    : !configured ? "No priced thinking model is set up for this workspace. Ask an admin to add one in Workspace › Engines." : agent.working ? "The agent is working." : asked.trim().length < 3 ? "Say what the hooks should do." : null;

  return (
    <div className="bo gx-enter" data-testid="hooks-tool">
      <section className="gx-gen-card" aria-label="Hooks" data-testid="hooks-list">
        <CardHead label={`Hooks · ${briefHooks(brief).length} of ${OWN_LIMITS.hooks}`}><span className="gx-hint">Opening lines, not product claims</span></CardHead>
        {hooks.length ? (
          <ol className="bo-hooks">
            {hooks.map((hook, i) => (
              <li key={i} className="bo-hook">
                <span className="bo-hook-n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                <input className="gx-field" aria-label={`Hook ${i + 1}`} value={hook} maxLength={OWN_LIMITS.hookChars} placeholder="An opening line" onChange={(e) => setHooks(hooks.map((h, j) => (j === i ? e.target.value : h)))} data-testid="hooks-line" />
                <button type="button" className="gx-hbtn" aria-label={`Remove hook ${i + 1}`} onClick={() => setHooks(hooks.filter((_, j) => j !== i))}>×</button>
              </li>
            ))}
          </ol>
        ) : <p className="gx-hint">No hooks yet. Write the first line, or have the agent write them below.</p>}
        <div className="gx-gen-enhance">
          <button type="button" className="gx-hbtn" disabled={hooks.length >= OWN_LIMITS.hooks} onClick={() => setHooks([...hooks, ""])} data-testid="hooks-add">+ Hook</button>
          <button type="button" className="gx-hbtn" disabled={!briefHooks(brief).length} onClick={() => onOpen("format")}>Use one in Format</button>
          {hooks.length >= OWN_LIMITS.hooks ? <span className="gx-hint">Twelve is the most a campaign keeps.</span> : null}
        </div>
      </section>

      <section className="gx-gen-card" aria-label="Write them with the agent" data-testid="hooks-agent">
        <CardHead label="Write them with the agent"><span className="gx-hint">Paid · priced first</span></CardHead>
        <p className="gx-hint">The Campaign agent reads the brand kit, the product’s approved facts and the chosen brief. You see its approximate price before it runs, and you choose which lines to keep.</p>
        <Field label="What to ask">
          <textarea className="gx-textarea bo-short" value={asked} maxLength={REQUEST_MAX} onChange={(e) => setRequest(e.target.value)} data-testid="hooks-request" />
        </Field>
        <div className="gx-gen-enhance">
          <button type="button" className="gx-primary" disabled={Boolean(blocked)} aria-describedby={blocked ? "hooks-blocked" : undefined} onClick={() => setDialog(true)} data-testid="hooks-price">See the price</button>
          {request !== null ? <button type="button" className="gx-hbtn" onClick={() => setRequest(null)}>Reset the request</button> : null}
        </div>
        {blocked ? <p className="gx-reason" id="hooks-blocked" data-testid="hooks-blocked">{blocked}</p> : null}
        {agent.error ? <div className="gx-retry" role="alert"><span className="gx-gen-error">{agent.error}</span><button type="button" className="gx-hbtn" onClick={() => void agent.refresh()}>Try again</button></div> : null}
        {runs.length ? (
          <div className="bo-runs" data-testid="hooks-runs">
            {runs.map((job) => {
              const proposed = job.plan?.suiteAgent?.hooks ?? [];
              const fresh = proposed.filter((h) => !briefHooks(brief).some((x) => x.toLowerCase() === h.trim().toLowerCase()));
              const state = job.status === "succeeded" ? "Written" : job.status === "queued" || job.status === "running" ? "Writing…" : "Needs review";
              return (
                <article className="bo-run" key={job.id} data-testid="hooks-run">
                  <div className="bo-head">
                    <span className="bo-strong">{state}</span>
                    <span className="gx-hint" data-testid="hooks-run-cost">{job.credits != null ? `${job.credits.toLocaleString("en-US")} cr` : `${aboutCredits(job.estimateCredits)} · up to ${job.estimateCredits.toLocaleString("en-US")} cr reserved`}</span>
                  </div>
                  {job.error ? <p className="gx-gen-error" role="alert">{job.error}</p> : null}
                  {proposed.length ? (
                    <>
                      <ul className="bo-proposed">{proposed.map((h, i) => <li key={i}>{h}</li>)}</ul>
                      <div className="gx-gen-enhance">
                        <button type="button" className="gx-primary" disabled={!fresh.length} onClick={() => take(proposed)} data-testid="hooks-take">{fresh.length ? `Add ${fresh.length} ${fresh.length === 1 ? "hook" : "hooks"}` : "All on the list"}</button>
                      </div>
                    </>
                  ) : job.status === "succeeded" ? <p className="gx-hint">This run wrote no hooks.</p> : null}
                </article>
              );
            })}
          </div>
        ) : null}
      </section>
      <SaveLine editor={editor} testId="hooks-save" />
      {dialog && saved ? (
        <AtomikRunDialog key={`${scope}:${p.id}:hooks`} approximate scope={scope} project={p} models={models}
          target={{ suite: "moleculr", request: `[moleculr] ${asked.trim()}`, role: "marketing", model: "auto", effort: "auto", depth: "Considered", refs: [] }}
          onSave={editor.ensureSaved} onClose={() => setDialog(false)} onQueued={() => { setDialog(false); void agent.refresh(); }} />
      ) : null}
    </div>
  );
}
