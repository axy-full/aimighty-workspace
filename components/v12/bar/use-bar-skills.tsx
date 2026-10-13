"use client";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { commandIn, type SkillView } from "@/lib/atomikSkillsText";
import { useShell } from "@/lib/shell/state";
import { openAtomikChat } from "@/lib/shell/use-skills";
import { useComposerSkills } from "@/components/atomik/skills/ComposerSkills";
import { RunSkillDialog } from "@/components/atomik/skills/SkillForms";
import { useToast } from "@/components/v12/ui/Toast";
import { commandOf, matchRows, skillRows, typingSlash, type SkillRow } from "@/lib/v12/skills";
import { useSession } from "@/lib/session";
import type { BarSkills } from "./Bar";
import { SkillPrice } from "./SkillPrice";

/** Why a built-in cannot be run from this bar (it needs a Campaign board's product and brand). */
export const FORMATS_FROM_BOARD = "Formats are made from a Campaign board's Formats stage.";

/**
 * The "/" skills list for a bar (components/v12/bar/Bar.tsx `skills`): saved Atomik skills, read as the Atomik composer reads
 * them, and the built-ins that exist as Campaign formats. Picking only writes "/slug " into the words (the Bar does that).
 *
 * Enter on a made command opens what runs today, and each of those prices before it runs and spends only on a person's tap:
 *  - a saved skill: its run form (components/atomik/skills/SkillForms.tsx), which plans its steps for nothing and files them
 *    in an Atomik chat, each step waiting for its own quote and a person's Continue;
 *  - a format: `onBuiltIn` (a Campaign board opens its Formats stage, where Pick and Make are), or the reason it cannot here.
 */
export function useBarSkills(text: string, setText: (text: string) => void, options: { onBuiltIn?: (row: Extract<SkillRow, { kind: "built-in" }>) => string | null; /** The board a plan is filed under (a board's bar); none: a chat of its own. */ projectId?: string | null } = {}): BarSkills {
  const { signedIn } = useSession();
  const toast = useToast();
  const shell = useShell();
  const skills = useComposerSkills(text);
  const [running, setRunning] = useState<{ skill: SkillView; values: Record<string, string> } | null>(null);
  const rows = useMemo(() => skillRows(signedIn ? skills.skills : []), [signedIn, skills.skills]);
  const listed = typingSlash(text) ? matchRows(text, rows) : [];
  const { api } = skills;
  const { onBuiltIn } = options;
  const projectId = options.projectId ?? null;

  const onRun = useCallback((typed: string): boolean => {
    const saved = commandIn(typed, skills.skills);
    if (saved) { setRunning({ skill: saved.skill, values: saved.values }); return true; }
    const made = commandOf(typed, rows);
    if (!made || made.row.kind !== "built-in") return false;
    const refused = made.row.format.notBuilt ?? onBuiltIn?.(made.row) ?? (onBuiltIn ? null : FORMATS_FROM_BOARD);
    if (refused) toast({ text: refused }); else setText("");
    return true;
  }, [skills.skills, rows, onBuiltIn, toast, setText]);

  const dialogs: ReactNode = running ? (
    <RunSkillDialog api={api} skill={running.skill} values={running.values} chatId={null} projectId={projectId}
      onPlanned={(run) => {
        /* The conversation shows the chat the plan was filed in; its first step is the checkpoint. */
        openAtomikChat({ chatId: run.chatId, projectId });
        shell.openAtomik("panel");
        toast({ text: "Planned. Each step waits for its price and your Continue." });
        setText("");
        setRunning(null);
      }}
      onClose={() => setRunning(null)} />
  ) : null;

  return {
    listed: listed.map((row) => ({
      key: row.key, slug: row.slug, name: row.name, line: row.line, price: <SkillPrice row={row} api={api} />,
      off: row.kind === "built-in" ? row.format.notBuilt : null,
    })),
    loading: skills.loading || skills.reading,
    failed: skills.failed,
    onRetry: skills.retry,
    onPick: (row) => { toast({ text: row.off ?? `/${row.slug} · its quote is shown before it runs` }); },
    onRun,
    dialogs,
  };
}
