"use client";
import { useMemo, useState } from "react";
import { EffortPicker, ModelPicker, type ThinkingModel } from "@/components/atomik/ModelPicker";
import { AGENT_FAMILIES, DEFAULT_AGENT, familyModels, readAgent, resolveAgent, writeAgent, type AgentChoice } from "@/lib/production/agent";

/** The viewer's agent choice, resolved against the models the workspace can reach today. */
export function useAgentChoice(models: readonly ThinkingModel[]) {
  /* Read once on mount; on the server there is no storage and the default stands. */
  const [choice, setChoice] = useState<AgentChoice>(() => (typeof window === "undefined" ? DEFAULT_AGENT : readAgent()));
  const update = (next: AgentChoice) => { setChoice(next); writeAgent(next); };
  const resolved = useMemo(() => resolveAgent(models, choice), [models, choice]);
  return { choice, update, model: resolved.model, effort: resolved.effort };
}

/**
 * Production › Agent: Claude, Grok or OpenAI, then the model and its effort.
 * Every agent step of the suite runs on this choice and is priced before it runs.
 */
/** `bare` renders the controls without their own card, inside another section (Brief's Develop with an agent). */
export function AgentBar({ models, agent, disabled, loaded, bare = false }: { models: readonly ThinkingModel[]; agent: ReturnType<typeof useAgentChoice>; disabled?: boolean; loaded: boolean; bare?: boolean }) {
  const { choice, update, model, effort } = agent;
  const offered = familyModels(models, choice.family);
  return (
    <section className={bare ? "pd-agent pd-agent--bare" : "gx-gen-card pd-agent"} aria-label="Agent" data-testid="agent-bar" data-section="agent">
      <div className="pd-agent-row">
        <div className="gx-gen-row pd-agent-family">
          <span className="gx-eyebrow" data-functional-label="">Agent</span>
          <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label="Agent">
            {AGENT_FAMILIES.map((family) => {
              const none = loaded && !familyModels(models, family.id).length;
              return (
                <button key={family.id} type="button" role="radio" className="gx-seg-btn" aria-checked={choice.family === family.id} disabled={disabled || none}
                  title={none ? `No ${family.label} model is connected to this workspace.` : undefined}
                  onClick={() => update({ family: family.id, model: "", effort: "auto" })} data-testid={`agent-${family.id}`}>
                  <span>{family.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="gx-gen-row pd-agent-model">
          <span className="gx-eyebrow" data-functional-label="">Model</span>
          <ModelPicker label="Agent model" value={model?.id ?? ""} models={offered} allowAuto={false} disabled={disabled || !offered.length}
            onPick={(id) => update({ ...choice, model: id, effort: "auto" })} />
        </div>
        <div className="gx-gen-row pd-agent-effort">
          <span className="gx-eyebrow" data-functional-label="">Effort</span>
          <EffortPicker label="Agent effort" compact model={model ?? undefined} value={effort} disabled={disabled || !model}
            onPick={(value) => update({ ...choice, model: model?.id ?? "", effort: value })} />
        </div>
      </div>
      <p className="gx-hint pd-agent-hint">
        {!loaded ? "Reading the workspace’s agents…" : !models.length ? "No agent is connected to this workspace. Connect one in Workspace › Engines." : "Every agent step in Production runs on this choice, and is priced before it runs."}
      </p>
    </section>
  );
}
