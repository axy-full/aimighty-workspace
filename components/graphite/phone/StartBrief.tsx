"use client";
import type { ProjectSummary } from "@/lib/workspace/data";
import { BriefBox } from "../home/BriefBox";
import { StartFooter } from "../home/StartFooter";
import { TemplateRow } from "../home/TemplateRow";
import { useHomeStart, type CreateFromSeed, type OpenBoard } from "../home/use-home-start";
import "../home/home.css";
import { NEEDS_CONNECTION } from "./HomeScreen";

/**
 * "What are we making?" on the phone's Home: the brief, its aspect and length, **Start · up to N cr**, and the four
 * templates (Film, Ad campaign, Social clips, Start from a script).
 *
 * The signed-in phone Home is not drawn with this (frame A is "Needs you" and the projects); the signed-out phone
 * Home is (README § 3.7, frame P1: the box, the chips, Start, the templates in two columns). So this is the desktop
 * Home's own box, Start and templates (components/graphite/home), in P1's layout, run by the same hook
 * (home/use-home-start.ts): the same create, the same Start price from the server (Atomik's thinking, "up to N cr"),
 * the same one-press approval of that thinking. Nothing is paid before the press, and only a person presses it.
 * Offline the box keeps its words and the two buttons that act say "Needs a connection" (README § 3.6 states).
 */
export function StartBrief({ scope, projects, online, onPick, onCreate, onOpened }: {
  scope: string;
  projects: readonly ProjectSummary[];
  online: boolean;
  onPick: (id: string) => void;
  onCreate: CreateFromSeed;
  /** A project is open (made, or reused): on the phone the board is its Record. */
  onOpened: OpenBoard;
}) {
  const s = useHomeStart({ scope, projects, onPick, onCreate, openBoard: onOpened });
  const locked = s.pending !== null || !online;
  return (
    <section className="ph-section ph-start" aria-labelledby="ph-start-title" data-testid="phone-start">
      <h2 className="ph-start-title" id="ph-start-title" data-testid="phone-start-title">What are we making?</h2>
      <BriefBox draft={s.draft} onDraft={s.onDraft} refs={s.refs} onRefs={s.setRefs} briefFile={s.briefFile} onBriefFile={s.setBriefFile} busy={s.pending !== null}
        footer={<StartFooter thinking={s.thinking} figure={s.figure} busy={s.pending === "start"} disabled={locked} onStart={() => void s.start()} onRetry={s.retryThinking} problem={s.startProblem} />} />
      <TemplateRow pending={s.pending === "sample" || s.pending === "start" ? null : s.pending} disabled={locked} onPick={(t) => void s.create(t)} />
      {!online ? <p className="ph-row-line" role="status" data-testid="phone-start-offline">{NEEDS_CONNECTION}</p> : null}
      {s.problem ? <p className="ph-row-line ph-row-line--warn" role="alert" data-testid="phone-start-problem">{s.problem}</p> : null}
    </section>
  );
}
