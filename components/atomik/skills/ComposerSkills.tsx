"use client";
import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/lib/session";
import { useProject } from "@/lib/projectContext";
import type { SkillView } from "@/lib/atomikSkillsText";
import { SKILLS_CHANGED, openAtomikChat, useSkillsApi, type SkillsApi } from "@/lib/shell/use-skills";
import { RunSkillDialog, SaveSkillDialog, SkillHints, commandIn } from "./SkillForms";
import styles from "./skills.module.css";

/**
 * Skills in the Atomik composer (components/atomik/ChatComposer.tsx), in the
 * rail and on the phone's sheet: `/` lists the skills this person may run,
 * and picking one (or sending its exact command) opens its run form instead
 * of a planning turn; "Save as skill" keeps the plan on screen as a skill.
 * A planned run shows in the conversation, where each step waits for its
 * quote and Continue. Nothing here spends.
 */

/** The skills behind `/`: read each time a command starts being typed, and again after any change. */
export function useComposerSkills(text: string) {
  const { signedIn, requestScope } = useSession();
  const api = useSkillsApi(requestScope);
  const wanted = Boolean(signedIn && requestScope && text.startsWith("/"));
  const [list, setList] = useState<{ scope: string; skills: SkillView[] } | null>(null);
  const [reading, setReading] = useState(false);
  const [stale, setStale] = useState(0);
  const scope = requestScope ?? "";
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    const timer = setTimeout(async () => {
      setReading(true);
      try {
        const skills = await api.list("active");
        if (live) setList({ scope, skills });
      } catch { /* `/` stays ordinary text when the list cannot be read */ }
      finally { if (live) setReading(false); }
    }, 0);
    return () => { live = false; clearTimeout(timer); };
  }, [wanted, api, scope, stale]);
  useEffect(() => {
    const again = () => setStale((n) => n + 1);
    window.addEventListener(SKILLS_CHANGED, again);
    return () => window.removeEventListener(SKILLS_CHANGED, again);
  }, []);
  const skills = list?.scope === scope ? list.skills : [];
  return { api, skills, reading: wanted && list?.scope !== scope, exact: commandIn(text, skills), loading: reading };
}

export type ComposerSkillsState = ReturnType<typeof useComposerSkills>;

/** "Save as skill" beside the composer's pickers, while a plan with steps is on screen. */
export function SaveSkillButton({ onOpen, disabled }: { onOpen: () => void; disabled: boolean }) {
  return <button type="button" className={`${styles.button} ml-auto`} disabled={disabled} onClick={onOpen} data-testid="atomik-save-skill">Save as skill</button>;
}

export { SkillHints };

/**
 * The composer's dialogs: running a skill (its parameters, engines and an
 * estimate), and saving the chat's plan as one. Rendered beside the
 * composer's form, never inside it, so no submit here reaches its Send.
 */
export function ComposerSkillDialogs({ api, running, saving, chat, onClose, onSaved }: {
  api: SkillsApi; running: { skill: SkillView; values: Record<string, string> } | null; saving: string | null;
  /** The conversation on screen, whose plan a run joins; none, and the run starts one for this production. */
  chat: { id: string; projectId: string | null } | null;
  onClose: () => void; onSaved: (said: string) => void;
}) {
  const { current: production } = useProject();
  const projectId = chat ? chat.projectId : production?.id ?? null;
  const planned = useCallback((run: { chatId: string }) => {
    /* The conversation shows the chat the plan was filed in; its first step is the checkpoint. */
    openAtomikChat({ chatId: run.chatId, projectId });
    onSaved("Planned. Each step waits for its price and your Continue.");
    onClose();
  }, [projectId, onClose, onSaved]);
  if (running) return <RunSkillDialog api={api} skill={running.skill} values={running.values} chatId={chat?.id ?? null} projectId={chat ? null : projectId} onPlanned={planned} onClose={onClose} />;
  if (saving) return <SaveSkillDialog api={api} chatId={saving} onSaved={(skill) => { onSaved(`Saved as /${skill.slug}. Type / to run it again.`); onClose(); }} onClose={onClose} />;
  return null;
}
