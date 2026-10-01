"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSession } from "@/lib/session";
import { useProject } from "@/lib/projectContext";
import { commandIn, matchingSkills, typingCommand, type SkillView } from "@/lib/atomikSkillsText";
import { SKILLS_CHANGED, openAtomikChat, useSkillsApi, type SkillsApi } from "@/lib/shell/use-skills";
import { RunSkillDialog, SaveSkillDialog, SkillHints, skillOptionId } from "./SkillForms";
import styles from "./skills.module.css";

/**
 * Skills in the Atomik composer (components/atomik/ChatComposer.tsx), in the
 * rail and on the phone's sheet: `/` lists the skills this person may run,
 * and picking one (or sending its exact command) opens its run form instead
 * of a planning turn; "Save as skill" keeps the plan on screen as a skill.
 * A planned run shows in the conversation, where each step waits for its
 * quote and Continue. Nothing here spends.
 */

/**
 * The skills behind `/`: read each time a command starts being typed, and
 * again after any change or a Try again. A read that fails keeps the skills
 * already read, and says so only when there are none to show.
 */
export function useComposerSkills(text: string) {
  const { signedIn, requestScope } = useSession();
  const api = useSkillsApi(requestScope);
  const wanted = Boolean(signedIn && requestScope && text.startsWith("/"));
  const [list, setList] = useState<{ scope: string; skills: SkillView[]; failed?: true } | null>(null);
  const [reading, setReading] = useState(false);
  const [stale, setStale] = useState(0);
  const sequence = useRef(0);
  const scope = requestScope ?? "";
  useEffect(() => {
    if (!wanted) return;
    /* Only the latest read lands; one left behind by a newer read is dropped, its state with it. */
    const mine = ++sequence.current;
    const timer = setTimeout(async () => {
      setReading(true);
      try {
        const skills = await api.list("active");
        if (mine === sequence.current) setList({ scope, skills });
      } catch {
        if (mine === sequence.current) setList((previous) => ({ scope, skills: previous?.scope === scope ? previous.skills : [], failed: true }));
      } finally { if (mine === sequence.current) setReading(false); }
    }, 0);
    return () => clearTimeout(timer);
  }, [wanted, api, scope, stale]);
  useEffect(() => {
    const again = () => setStale((n) => n + 1);
    window.addEventListener(SKILLS_CHANGED, again);
    return () => window.removeEventListener(SKILLS_CHANGED, again);
  }, []);
  const retry = useCallback(() => setStale((n) => n + 1), []);
  const skills = list?.scope === scope ? list.skills : [];
  /* While a command is still being typed (`/wave`), the skills it matches, best first: Enter opens the highlighted one. */
  const matches = typingCommand(text) ? matchingSkills(text, skills) : [];
  return {
    api, skills, matches, retry, failed: list?.scope === scope && list.failed === true,
    reading: wanted && list?.scope !== scope, exact: commandIn(text, skills), loading: reading,
  };
}

export type ComposerSkillsState = ReturnType<typeof useComposerSkills>;

/**
 * The composer's last word on a skill ("Saved as /x…", "Planned…"), held
 * outside any one composer and kept with the chat it is about: a checkpoint
 * arriving folds the rail, which draws its composer afresh, and the word
 * stays. Opening a skill or Save as skill, or sending a request, clears it.
 */
type Notice = { chatId: string; text: string } | null;
let notice: Notice = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export function sayAboutChat(chatId: string | null, text: string | null) {
  notice = chatId && text ? { chatId, text } : null;
  for (const fn of listeners) fn();
}
export function useSkillNotice(chatId: string | null): string | null {
  const current = useSyncExternalStore(subscribe, () => notice, () => null);
  return current && chatId && current.chatId === chatId ? current.text : null;
}

/** "Save as skill" beside the composer's pickers, while a plan with steps is on screen. */
export function SaveSkillButton({ onOpen, disabled }: { onOpen: () => void; disabled: boolean }) {
  return <button type="button" className={`${styles.button} ml-auto`} disabled={disabled} onClick={onOpen} data-testid="atomik-save-skill">Save as skill</button>;
}

export { SkillHints, skillOptionId };

/**
 * The composer's dialogs: running a skill (its parameters, engines and an
 * estimate), and saving the chat's plan as one. Rendered beside the
 * composer's form, never inside it, so no submit here reaches its Send.
 */
export function ComposerSkillDialogs({ api, running, saving, chat, onClose }: {
  api: SkillsApi; running: { skill: SkillView; values: Record<string, string> } | null; saving: string | null;
  /** The conversation on screen, whose plan a run joins; none, and the run starts one for this production. */
  chat: { id: string; projectId: string | null } | null;
  onClose: () => void;
}) {
  const { current: production } = useProject();
  const projectId = chat ? chat.projectId : production?.id ?? null;
  const planned = useCallback((run: { chatId: string }) => {
    /* The conversation shows the chat the plan was filed in; its first step is the checkpoint. */
    openAtomikChat({ chatId: run.chatId, projectId });
    sayAboutChat(run.chatId, "Planned. Each step waits for its price and your Continue.");
    onClose();
  }, [projectId, onClose]);
  if (running) return <RunSkillDialog api={api} skill={running.skill} values={running.values} chatId={chat?.id ?? null} projectId={chat ? null : projectId} onPlanned={planned} onClose={onClose} />;
  if (saving) return <SaveSkillDialog api={api} chatId={saving} onSaved={(skill) => { sayAboutChat(saving, `Saved as /${skill.slug}. Type / to run it again.`); onClose(); }} onClose={onClose} />;
  return null;
}
