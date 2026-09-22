"use client";
import { useState } from "react";
import { SKILL_PACKS, SKILLS_REPO } from "@/lib/shell/skills";
import { useShell } from "@/lib/shell/state";
import { useWorkspace } from "@/lib/workspace/state";

/** Atomik › Skills (FINAL_SPEC §5): the eight packs, each with Install. Models stay in Atomik › Models. */
export function SkillsView() {
  const shell = useShell();
  const { toast } = useWorkspace();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (id: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); toast("Install command copied."); }
    catch { toast("Copy the install command from the row."); }
  };
  return (
    <div className="sk gx-enter" data-testid="skills-view">
      <p className="bz-intro">The agent’s tool reach is these packs. Install opens the pack; the command installs it where the agent runs. Thinking-model choice stays in <button type="button" className="cw-link" onClick={() => shell.goSuite("atomik", "models")}>Atomik › Models</button>.</p>
      <div className="sk-list">
        {SKILL_PACKS.map((p) => (
          <div className="sk-row" key={p.id} data-testid="skill-row">
            <span className="cw-dot" style={{ background: "#30D158" }} aria-hidden="true" />
            <span style={{ minWidth: 0, flex: 1 }}>
              <span className="sk-name">{p.id}</span>
              <span className="cw-dim">{p.line}</span>
            </span>
            <code className="cw-mono sk-cmd" title={p.install}>{copied === p.id ? "copied" : p.install}</code>
            <button type="button" className="gx-hbtn" onClick={() => void copy(p.id, p.install)}>Copy</button>
            <a className="gx-hbtn" href={p.href} target="_blank" rel="noreferrer">Install</a>
          </div>
        ))}
      </div>
      <p className="cw-dim">All packs: <a className="cw-link" href={SKILLS_REPO} target="_blank" rel="noreferrer">{SKILLS_REPO.replace("https://", "")}</a></p>
    </div>
  );
}
