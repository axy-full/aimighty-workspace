import { billCredits } from "../creditTerms";
import { id as newId } from "../db";
import { reserveGenerationSpend } from "../generationRequests";
import { meter } from "../meter";
import { paidByPlatform } from "../platformSpend";
import { currentTenant } from "../tenant";
import type { Project } from "../workbench/studio";
import { projectContext } from "./context";
import { mockAnswer } from "./mock";
import {
  PARALLEL_CAP, callCostUsd, chairOf, memberNamed, parseChallenge, parseSolutions, roleCard, roundCeilingUsd, userMessage,
  type CrewPhase, type Rate, type TranscriptLine,
} from "./room";
import { addMessage, addSolution, listMessages, type CrewMember, type CrewSession, type CrewSolution, type StoredMessage } from "./store";
import { askGrok, xaiModel } from "./xai";

/**
 * One round (CREW_ADDENDUM.md): Propose in parallel, Challenge in parallel
 * with every proposal in view, then one Converge request to the chair. One
 * agent per member, one request per member per phase.
 *
 * Money. The round is ONE metered event, reserved at its ceiling before the
 * first request and settled at the tokens the provider reported. A request
 * that failed adds nothing. A round whose chair failed — or in which nobody
 * proposed — settles at zero: the messages are kept, the round is not billed.
 */
export type RoundEvent =
  | { event: "phase"; data: { round: number; phase: CrewPhase } }
  | { event: "thinking"; data: { memberId: string; phase: CrewPhase } }
  | { event: "message"; data: StoredMessage & { to: string | null } }
  | { event: "failed"; data: { memberId: string; phase: CrewPhase; reason: string } }
  | { event: "solutions"; data: CrewSolution[] }
  | { event: "done"; data: { round: number; billed: boolean; spendCr: number | null; note: string | null } };

export type RoundQuote = { model: string; calls: number; ceilingUsd: number; estimateCredits: number };

export function quoteRound(input: { session: CrewSession; project: Project; active: CrewMember[]; transcriptChars: number; rate: Rate }): RoundQuote {
  const context = projectContext(input.project, input.session.context);
  const ceilingUsd = roundCeilingUsd({
    seated: input.active.length, goalChars: input.session.goal.length, contextChars: context.length, transcriptChars: input.transcriptChars,
    stanceChars: Math.max(0, ...input.active.map((m) => m.stance.length + m.name.length + m.department.length)),
  }, input.rate);
  return { model: xaiModel(), calls: input.active.length * 2 + 1, ceilingUsd, estimateCredits: paidByPlatform("xai") ? billCredits(ceilingUsd, "text") : 0 };
}

async function pooled<T>(items: readonly T[], run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL_CAP, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  }));
}

export async function runRound(input: {
  session: CrewSession; project: Project; active: CrewMember[]; rate: Rate; ceilingUsd: number; userId: string;
  emit: (event: RoundEvent) => void;
}): Promise<{ billed: boolean; spendUsd: number; spendCr: number | null }> {
  const { session, project, active, rate, emit } = input;
  const round = session.roundsRun + 1;
  const context = projectContext(project, session.context);
  const event = { id: newId("crewround"), kind: "text" as const, engine: "xai", model: session.model, projectId: project.productionProjectId ?? null, createdBy: input.userId };
  await reserveGenerationSpend({ ...event, status: "running", engineCostUsd: input.ceilingUsd }, { token: currentTenant()?.token });

  let spentUsd = 0;
  let converged = false;
  let proposals = 0;
  try {
    const history = await listMessages(session.id);
    const nameOf = (id: string | null) => (id ? history.find((m) => m.memberId === id)?.name ?? active.find((m) => m.id === id)?.name ?? null : null);
    const lines: TranscriptLine[] = history.map((m) => ({ name: m.name, to: nameOf(m.toMemberId), text: m.text }));

    const speak = async (member: CrewMember, phase: CrewPhase, snapshot: readonly TranscriptLine[], others: string[]) => {
      emit({ event: "thinking", data: { memberId: member.id, phase } });
      const answer = await askGrok({
        system: roleCard(member, context, phase), user: userMessage(session.goal, snapshot, phase === "challenge" ? others : undefined),
        phase, effort: member.effort, mock: () => mockAnswer(member.presetId, phase, others),
      });
      if (!answer.ok) { emit({ event: "failed", data: { memberId: member.id, phase, reason: answer.reason } }); return null; }
      spentUsd += callCostUsd(answer, rate);
      const parsed = phase === "challenge" ? parseChallenge(answer.text) : { to: "", text: answer.text };
      const to = phase === "challenge" ? memberNamed(active.filter((m) => m.id !== member.id), parsed.to) : null;
      const stored = await addMessage({
        sessionId: session.id, round, phase, memberId: member.id, toMemberId: to?.id ?? null, name: member.name,
        department: phase === "converge" ? "Chair" : member.department, color: member.color, text: parsed.text || answer.text,
        tokensIn: answer.promptTokens, tokensOut: answer.completionTokens,
      });
      lines.push({ name: member.name, to: to?.name ?? null, text: stored.text });
      emit({ event: "message", data: { ...stored, to: to?.name ?? (parsed.to || null) } });
      return stored;
    };

    emit({ event: "phase", data: { round, phase: "propose" } });
    const beforePropose = [...lines];
    await pooled(active, async (m) => { if (await speak(m, "propose", beforePropose, [])) proposals++; });

    if (proposals) {
      emit({ event: "phase", data: { round, phase: "challenge" } });
      const beforeChallenge = [...lines];
      if (active.length > 1) await pooled(active, async (m) => { await speak(m, "challenge", beforeChallenge, active.filter((o) => o.id !== m.id).map((o) => o.name)); });

      const chair = chairOf(active)!;
      emit({ event: "phase", data: { round, phase: "converge" } });
      const verdict = await speak(chair, "converge", [...lines], []);
      const texts = verdict ? parseSolutions(verdict.text) : [];
      if (texts.length) {
        const solutions: CrewSolution[] = [];
        for (const text of texts.slice(0, 3)) solutions.push(await addSolution({ sessionId: session.id, round, text, source: "converge" }));
        emit({ event: "solutions", data: solutions });
        converged = true;
      }
    }
  } catch (error) {
    await meter({ ...event, status: "failed", engineCostUsd: 0 });
    throw error;
  }

  if (!converged) {
    await meter({ ...event, status: "failed", engineCostUsd: 0 });
    emit({ event: "done", data: { round, billed: false, spendCr: null, note: proposals ? "Converge failed — run again (not billed)" : "Nobody in the room could answer — run again (not billed)" } });
    return { billed: false, spendUsd: 0, spendCr: null };
  }
  await meter({ ...event, status: "succeeded", engineCostUsd: spentUsd }, { critical: true });
  const spendCr = paidByPlatform("xai") ? billCredits(spentUsd, "text") : null;
  emit({ event: "done", data: { round, billed: true, spendCr, note: null } });
  return { billed: true, spendUsd: spentUsd, spendCr };
}
