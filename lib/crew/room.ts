/**
 * Crew, as data (design/particl-suites/CREW_ADDENDUM.md). Pure: who can be
 * seated, what each agent is told, how an answer is read, and what a round
 * may cost at most. The phase instructions and the two regexes are the
 * prototype's, verbatim (Particl Crew.dc.html) — they are the spec.
 */
export type CrewEffort = "low" | "medium" | "high";
export type CrewPhase = "propose" | "challenge" | "converge";
export type CrewContextKey = "brief" | "script" | "boards" | "cast" | "rig";
export type CrewContext = Record<CrewContextKey, boolean>;

export type CrewPreset = { id: string; name: string; department: string; color: string; stance: string };

/** The seven role cards, in the prototype's order and words. */
export const CREW_PRESETS: readonly CrewPreset[] = [
  { id: "director", name: "Director", department: "Story & performance", color: "#0A84FF", stance: "You care about intent and truth of performance. Argue for the image that carries the idea, resist anything that reads as an advert." },
  { id: "dop", name: "DOP", department: "Camera & light", color: "#FF9F0A", stance: "You think in lenses, light and movement. Every proposal must be shootable in one setup; name the lens and the light." },
  { id: "designer", name: "Production designer", department: "Worlds & elements", color: "#30D158", stance: "You own the world: location, palette, props, the product as an object. Make the product part of the environment, never a pack shot." },
  { id: "costume", name: "Costume stylist", department: "Wardrobe & silhouette", color: "#BF5AF2", stance: "You read silhouette, fabric and movement. Protect continuity between scenes." },
  { id: "editor", name: "Editor", department: "Pacing & assembly", color: "#FF453A", stance: "You think in cuts and seconds. Say where the cut lands and what the viewer knows at 0:04." },
  { id: "producer", name: "Producer", department: "Schedule & resources", color: "#F5F5F7", stance: "You weigh cost, time and risk. Prefer fewer shots done well; quote what things take." },
  { id: "continuity", name: "Continuity supervisor", department: "Continuity & context", color: "#64D2FF", stance: "You hold the project bible. Flag anything that contradicts the brief, script, boards or cast." },
];
/** A new room seats these five, the Producer in the chair. */
export const DEFAULT_SEATED = ["director", "dop", "designer", "editor", "producer"] as const;
export const DEFAULT_CHAIR = "producer";
export const CUSTOM_MEMBER = { name: "New member", department: "Describe the role", color: "#8E8E93", stance: "Write the stance this member argues from." };
export const DEFAULT_CONTEXT: CrewContext = { brief: true, script: true, boards: true, cast: false, rig: false };
export const CONTEXT_LABELS: [CrewContextKey, string][] = [["brief", "Brief"], ["script", "Script"], ["boards", "Boards"], ["cast", "Cast"], ["rig", "Rig"]];

export const CREW_EFFORTS: readonly CrewEffort[] = ["low", "medium", "high"];
export const PHASES: readonly CrewPhase[] = ["propose", "challenge", "converge"];
export const PHASE_LABEL: Record<CrewPhase | "note", string> = { propose: "Propose", challenge: "Challenge", converge: "Converge", note: "Note" };

export const ROUNDS_MAX = 6;
export const MEMBER_MAX_TOKENS = 220;
export const PARALLEL_CAP = 6;
export const REQUEST_TIMEOUT_MS = 45_000;
export const GOAL_MAX = 1200;
export const NOTE_MAX = 1200;
export const STANCE_MAX = 1200;
export const MEMBERS_MAX = 12;

export const TEMPERATURE: Record<CrewPhase, number> = { propose: 0.7, challenge: 0.5, converge: 0.2 };

export const PHASE_INSTRUCTION: Record<CrewPhase, string> = {
  propose: "PHASE: PROPOSE. Give ONE concrete proposal answering the goal, ≤60 words, in first person, no preamble.",
  challenge: "PHASE: CHALLENGE. Pick one other member’s proposal, start with \"@Name —\", then sharpen it or push back with a specific reason, ≤60 words.",
  converge: "PHASE: CONVERGE. You chair the room. Merge the strongest ideas into exactly 3 numbered solutions, one line each: \"1. Title — what we do, ≤25 words\". Output only the three lines.",
};

export type SeatedMember = { id: string; name: string; department: string; stance: string; effort: CrewEffort };

/** The system prompt of one agent for one phase. `project` is the enabled context, already text. */
export function roleCard(member: SeatedMember, project: string, phase: CrewPhase): string {
  return `You are ${member.name} (${member.department}) in a film crew brainstorm. ${member.stance}\n${project}\nReasoning effort: ${member.effort}.\n${PHASE_INSTRUCTION[phase]}`;
}

export type TranscriptLine = { name: string; to?: string | null; text: string };
export function transcriptText(lines: readonly TranscriptLine[]): string {
  return lines.map((t) => `${t.name}${t.to ? ` → ${t.to}` : ""}: ${t.text}`).join("\n");
}
export function userMessage(goal: string, lines: readonly TranscriptLine[], others?: readonly string[]): string {
  return `GOAL: ${goal.trim()}\n\nTRANSCRIPT SO FAR:\n${transcriptText(lines) || "(empty)"}${others?.length ? `\n\nOTHER MEMBERS: ${others.join(", ")}` : ""}`;
}

/** `@Name — …` → who it answers and the text without the address. */
export function parseChallenge(text: string): { to: string; text: string } {
  const match = text.match(/^@([^—\-:]+)/);
  return { to: match ? match[1].trim() : "", text: text.replace(/^@[^—\-:]+[—\-:]\s*/, "") };
}
/** The addressed member, by name, case-insensitively; null when the model named nobody seated. */
export function memberNamed<T extends { name: string }>(members: readonly T[], name: string): T | null {
  const wanted = name.trim().toLowerCase();
  return wanted ? members.find((m) => m.name.toLowerCase() === wanted) ?? null : null;
}
/** The chair's numbered lines, numbers removed. */
export function parseSolutions(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => /^\d+\./.test(line)).map((line) => line.replace(/^\d+\.\s*/, "")).filter(Boolean);
}

/** The longest a Rig shot's title is. */
export const SHOT_TITLE_MAX = 80;
/**
 * A solution as a draft Rig shot: the words before " — " name it (cut at a
 * word, with "…", when longer than a shot title may be); the rest is its text.
 */
export function solutionShot(solution: string): { title: string; text: string } {
  const [head, ...rest] = solution.split(" — ");
  const name = head.replace(/\s+/g, " ").trim();
  let title = name;
  if (name.length > SHOT_TITLE_MAX) {
    const cut = name.slice(0, SHOT_TITLE_MAX - 1);
    const space = cut.lastIndexOf(" ");
    title = `${(space >= SHOT_TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, "")}…`;
  }
  return { title: title || "Crew solution", text: (rest.join(" — ") || solution).trim() };
}

/** Every seated member speaks twice and the chair once more. */
export function callsInRound(seated: number): number {
  return seated > 0 ? seated * 2 + 1 : 0;
}
export function chairOf<T extends { id: string; isChair: boolean }>(active: readonly T[]): T | null {
  return active.find((m) => m.isChair) ?? active[active.length - 1] ?? null;
}

/** Why Run round is off, in the prototype's words; null when it can run. */
export function roundBlock(input: { goal: string; seated: number; running: boolean; roundsRun: number; keyConnected: boolean; hasProject: boolean }): string | null {
  if (input.running) return "";
  if (!input.hasProject) return "Open a project first.";
  if (!input.keyConnected) return "Add key in Workspace › Engines.";
  if (!input.goal.trim()) return "Write the goal.";
  if (!input.seated) return "Seat at least one member.";
  if (input.roundsRun >= ROUNDS_MAX) return `This room has run its ${ROUNDS_MAX} rounds. Start a new session.`;
  return null;
}

export type Rate = { inputUsdPerToken: number; outputUsdPerToken: number };
/**
 * The most a round can cost: every call at its full output allowance, with
 * the transcript it could be reading by then. The settled price is the tokens
 * the provider reports, which is never more than this.
 */
export function roundCeilingUsd(input: { seated: number; goalChars: number; contextChars: number; transcriptChars: number; stanceChars: number }, rate: Rate): number {
  const calls = callsInRound(input.seated);
  if (!calls) return 0;
  /* ~3 characters a token is conservative for English; +64 tokens of wire overhead a call. */
  const perProposal = MEMBER_MAX_TOKENS * 4;
  const grown = input.transcriptChars + input.seated * perProposal * 2;
  const promptTokens = Math.ceil((input.goalChars + input.contextChars + input.stanceChars + grown + 600) / 3) + 64;
  return calls * (promptTokens * rate.inputUsdPerToken + MEMBER_MAX_TOKENS * rate.outputUsdPerToken);
}
export function callCostUsd(usage: { promptTokens: number; completionTokens: number }, rate: Rate): number {
  return usage.promptTokens * rate.inputUsdPerToken + usage.completionTokens * rate.outputUsdPerToken;
}

/** Markdown minutes: goal, roster, transcript, solutions. */
export function minutesMarkdown(input: {
  project: string; goal: string; model: string; createdAt: number; roundsRun: number; spendCr: number | null;
  roster: { name: string; department: string; isChair: boolean; active: boolean }[];
  messages: { round: number; phase: CrewPhase | "note"; name: string; to?: string | null; text: string }[];
  solutions: { round: number; text: string; source: "converge" | "pin"; status: string }[];
}): string {
  const out = [`# Crew minutes — ${input.project}`, "", `**Goal.** ${input.goal}`, "", `${new Date(input.createdAt).toISOString().slice(0, 10)} · ${input.model} · ${input.roundsRun} ${input.roundsRun === 1 ? "round" : "rounds"}${input.spendCr == null ? "" : ` · ${input.spendCr} cr`}`, "", "## In the room", ""];
  for (const m of input.roster) out.push(`- ${m.name} — ${m.department}${m.isChair ? " (chair)" : ""}${m.active ? "" : " (muted)"}`);
  out.push("", "## Transcript");
  let head = "";
  for (const m of input.messages) {
    const next = m.phase === "note" ? head : `Round ${m.round} · ${PHASE_LABEL[m.phase]}`;
    if (next !== head && m.phase !== "note") { head = next; out.push("", `### ${head}`, ""); }
    out.push(`**${m.name}${m.to ? ` → ${m.to}` : ""}${m.phase === "note" ? " (note)" : ""}.** ${m.text}`, "");
  }
  out.push("## Solutions", "");
  if (!input.solutions.length) out.push("None yet.");
  input.solutions.forEach((s, i) => out.push(`${i + 1}. ${s.text} _(round ${s.round}, ${s.source === "pin" ? "pinned" : "chair"}${s.status === "open" ? "" : `, ${s.status.replace(/_/g, " ")}`})_`));
  return out.join("\n") + "\n";
}

/**
 * How a round settles (the room's money rule, in one place). The round is one
 * metered event: a chair that failed, or a room in which nobody proposed,
 * settles at zero — the messages are kept, the workspace is not billed, and
 * the note says so. Only a converged round bills the tokens reported.
 */
export function settleRound(input: { converged: boolean; proposals: number; spentUsd: number }): { billed: boolean; spendUsd: number; note: string | null } {
  if (!input.converged) return { billed: false, spendUsd: 0, note: input.proposals ? "Converge failed — run again (not billed)" : "Nobody in the room could answer — run again (not billed)" };
  return { billed: true, spendUsd: Math.max(0, input.spentUsd), note: null };
}

/** The minutes as a file the Library can keep: byte-identical markdown, named by the session. */
export function minutesFile(markdown: string, sessionId: string, when = new Date()): File {
  const stamp = when.toISOString().slice(0, 10);
  return new File([markdown], `crew-minutes-${stamp}-${sessionId.slice(0, 8)}.md`, { type: "text/markdown" });
}
