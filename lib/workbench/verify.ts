import { RigBuildError } from "../production/rig-build";
import { cardSource, shotPreviewAsset } from "../workspace/rig";
import { mediaReferenceIdentity } from "./media-reference-input";
import { createNode } from "./node-graph";
import { PROJECT_LIMITS } from "./project-limits";
import { refKindOf } from "./ref-kind";
import { SHOT_NODE_TYPES, uid, type Asset, type CanvasNode, type Project, type RefKind } from "./studio";

/*
 * The agentic Rig, step 5 (plan PR 7): a Verify card checks one take against
 * the production's masters and says pass, fail or "needs you", with reasons.
 *
 * A Verify card is the Rig's `review` card with a `verify` block (declared on
 * the node schema by #464), so a tab from before it reads it as a Review card,
 * which is true. The take source (a shot) and the masters (Cast, Environment
 * and Element cards) are wired into it. Refs are context and never scored.
 *
 * Pure and shared: the browser reads the same subject, key and verdicts the
 * server prices and stores (lib/workbench/verify-server.ts). The code decides
 * a verdict from the judge's scores; the judge only scores.
 */

/** Bumped when the checks, their thresholds or the judge's instructions change: a new rubric is a new check. */
export const VERIFY_RUBRIC = 1;
export const VERIFY_CHECKS = ["identity", "wardrobe", "environment", "props", "artifacts"] as const;
export type VerifyCheck = (typeof VERIFY_CHECKS)[number];
export const VERIFY_CHECK_LABELS: Record<VerifyCheck, string> = { identity: "Identity", wardrobe: "Wardrobe", environment: "Environment", props: "Props", artifacts: "Artifacts" };
/** Only Cast, Environment and Element cards are masters and scored; a Ref is context. (The locked-master step, #476, keeps the same list; one can import the other once both land.) */
export type MasterKind = Exclude<RefKind, "ref">;
export const MASTER_KINDS: readonly MasterKind[] = ["cast", "environment", "element"];
/** Which master anchors which check. Artifacts (extra limbs, warped text, morphing, flicker) need none. */
export const CHECK_MASTER: Record<VerifyCheck, MasterKind | null> = { identity: "cast", wardrobe: "cast", environment: "environment", props: "element", artifacts: null };
/**
 * Video frames, v1: the three stills the browser sampler already takes
 * (lib/workbench/atomik-reference-types.ts atomikFrameTimes, at 10%, 50% and
 * 90% of the clip), stored as uploads with their sha256. The server has no
 * decoder, so a video is checked while someone has the board open.
 */
export const VERIFY_FRAMES = { videoAt: [0.1, 0.5, 0.9], max: 3 } as const;
/** At most this many masters in one check: with the take's frames, eight review copies at most. */
export const VERIFY_MAX_MASTERS = 5;

/**
 * Strict thresholds (owner, 28 September: "when a check is unsure, it asks
 * you"). A score at or above `pass` passes, at or below `fail` fails, and
 * anything between is unsure, so nothing passes on a guess.
 */
export const VERIFY_THRESHOLDS: Record<VerifyCheck, { pass: number; fail: number }> = {
  identity: { pass: 0.85, fail: 0.4 },
  wardrobe: { pass: 0.8, fail: 0.4 },
  environment: { pass: 0.75, fail: 0.35 },
  props: { pass: 0.8, fail: 0.4 },
  artifacts: { pass: 0.85, fail: 0.5 },
};

export type CheckVerdict = "pass" | "fail" | "unsure";
export type Verdict = "pass" | "fail" | "needs_you";

/** One check's verdict from its score. A check the judge could not see (`seen` false) is unsure whatever it scored. */
export function checkVerdict(check: VerifyCheck, score: number | null | undefined, seen = true): CheckVerdict {
  if (!seen || typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) return "unsure";
  const t = VERIFY_THRESHOLDS[check];
  return score >= t.pass ? "pass" : score <= t.fail ? "fail" : "unsure";
}
/** The card's verdict: any failed check fails it; otherwise any unsure one needs a person; only a clean sweep passes. */
export function overallVerdict(checks: readonly { verdict: CheckVerdict }[]): Verdict {
  if (!checks.length) return "needs_you";
  if (checks.some((c) => c.verdict === "fail")) return "fail";
  if (checks.some((c) => c.verdict === "unsure")) return "needs_you";
  return "pass";
}

export type VerifyCheckResult = {
  check: VerifyCheck; verdict: CheckVerdict; score: number | null;
  /** At most three, in the judge's words. */
  reasons: string[];
  /** Which of the take's frames shows it best (0-based), or null. */
  frame: number | null;
};
/** The judge's scorecard, as a development job's result. */
export type VerifyResult = { nodeId: string; takeId: string; verdict: Verdict; checks: VerifyCheckResult[]; summary: string };
/** A take's frame the judge saw: its time in the clip (null for a still), the stored still, and the digest of the review copy sent. */
export type VerifyFrame = { t: number | null; uploadId: string | null; sha256: string };
/** A master a check used. `elementId`: the element its card stands for, when it has one (what "N takes were checked against this master" counts). */
export type VerifyMasterRecord = { kind: MasterKind; nodeId: string; title: string; identity: string; version: number; elementId?: string };
/** A stored check (tenant table `take_verifications`), as the browser reads it. */
export type TakeVerification = {
  id: string; takeId: string; verifyNodeId: string;
  /** The key the check is stored under, in the clear: the browser compares it with the card's own. */
  masterSet: string; rubric: number; framesKey: string;
  masters: VerifyMasterRecord[]; frames: VerifyFrame[]; checks: VerifyCheckResult[];
  verdict: Verdict; judgeModel: string;
  /** Credits it was charged (0 on the workspace's own key, where the vendor bills it). */
  credits: number; ownKey: boolean; createdAt: number;
  /** Against the saved board: whether the card that asked still checks this take against these masters. */
  standing?: VerifyStanding;
  /** Against the saved board: whether the masters of the card that asked are still the ones this take was checked against (Takes' badge). */
  mastersCurrent?: boolean;
};

/* ── What a Verify card checks ─────────────────────────────────────────── */

export function isVerifyCard(node: Pick<CanvasNode, "type" | "verify"> | null | undefined): boolean {
  return !!node && node.type === "review" && !!node.verify && typeof node.verify === "object";
}
const isShot = (node: CanvasNode) => (SHOT_NODE_TYPES as readonly string[]).includes(node.type);
const visual = (asset: Asset | null | undefined): asset is Asset => !!asset && (asset.kind === "image" || asset.kind === "video");

/** The bundled sample stills (lib/workbench/atomik-references.ts reads them from /public). */
const SAMPLE = /^\/campaign\/(?:hero|character|environment)\.webp$/;
/** A picture's durable identity: its generation or upload (immutable bytes), or a bundled sample. Null for anything else. */
export function mediaIdentity(asset: Pick<Asset, "generationId" | "uploadId" | "url" | "kind"> | null | undefined): string | null {
  if (!asset) return null;
  const id = mediaReferenceIdentity(asset as Asset);
  if (id) return "genId" in id ? `generation:${id.genId}` : `upload:${id.uploadId}`;
  return asset.kind === "image" && SAMPLE.test(asset.url) ? `sample:${asset.url}` : null;
}

/** What a master is checked against: the picture the judge is shown, and the identity its master set is hashed from. */
export type MasterSource = { asset: Asset | null; identity: string | null };

/**
 * THE SEAM for locked masters (plan PR 4, #476). Today a master is its
 * reference card's current source, identified by its immutable upload or
 * render. When locked masters land, a card whose element is locked (the
 * elements table's answer: masterCheck in lib/masters.ts on the server, the
 * Rig's set of masters in the browser) returns here the version its lock froze
 * and, as its identity, the lock snapshot's sha256 (`sha256:<hex>`). The
 * master set, its hash in take_verifications and "checked against an older
 * master" then follow the lock itself, and a source that drifted under the
 * lock reads as a new master. Nothing else in this file needs to change.
 */
export function preferLockedMaster(node: CanvasNode, current: Asset | null): MasterSource {
  void node;
  return { asset: current, identity: mediaIdentity(current) };
}

export type VerifyMaster = { node: CanvasNode; kind: MasterKind; asset: Asset | null; identity: string | null };
export type VerifySubject = {
  /** The shot wired in, with the take it shows now. */
  take: { node: CanvasNode; asset: Asset | null; identity: string | null } | null;
  masters: VerifyMaster[];
  /** Other cards wired in (Refs, notes): context, never scored. */
  context: CanvasNode[];
  /** The checks the wired masters anchor, plus artifacts, in rubric order. */
  checks: VerifyCheck[];
  /** Why it cannot be checked now, or null. */
  problem: string | null;
};

/** What a Verify card checks right now: its take, its masters and the checks they anchor. */
export function verifySubject(project: Pick<Project, "nodes" | "assets"> & Partial<Pick<Project, "sharedAssets">>, node: CanvasNode): VerifySubject {
  const full = project as Project;
  const linked = node.linked.map((id) => project.nodes.find((n) => n.id === id)).filter((n): n is CanvasNode => !!n);
  const shots = linked.filter(isShot);
  const masters: VerifyMaster[] = [], context: CanvasNode[] = [];
  for (const card of linked) {
    if (isShot(card)) continue;
    const kind = refKindOf(card, project);
    if (kind && kind !== "ref") masters.push({ node: card, kind, ...preferLockedMaster(card, cardSource(full, card)?.asset ?? null) });
    else context.push(card);
  }
  const shot = shots[0];
  const asset = shot ? shotPreviewAsset(full, shot.id) : null;
  const take = shot ? { node: shot, asset: visual(asset) ? asset : null, identity: visual(asset) ? mediaIdentity(asset) : null } : null;
  const checks = VERIFY_CHECKS.filter((c) => CHECK_MASTER[c] === null || masters.some((m) => m.kind === CHECK_MASTER[c]));
  const problem = !shot ? "Wire a shot into this card: its take is what gets checked."
    : shots.length > 1 ? "Wire one shot into this card. It checks one take at a time."
    : !take?.asset ? `${shot.title || "This shot"} has no take yet. Generate one first.`
    : !take.identity ? "Save this take in the workspace before checking it."
    : masters.length > VERIFY_MAX_MASTERS ? `Check against at most ${VERIFY_MAX_MASTERS} masters at once. Unwire the others.`
    : masterProblem(masters);
  return { take, masters, context, checks, problem };
}
function masterProblem(masters: VerifyMaster[]): string | null {
  for (const m of masters) {
    const name = m.node.title || "A master";
    if (!m.asset) return `${name} has no picture yet. Give it one, or unwire it.`;
    if (m.asset.kind !== "image") return `${name} is a video. A check compares against a still master; unwire it or use a still.`;
    if (!m.identity) return `Save ${name}'s picture in the workspace before checking against it.`;
  }
  return null;
}

/* ── The key a check is stored under ───────────────────────────────────── */

/** The same take, masters, rubric and frames read the stored check for free. */
export type VerifyKey = { takeId: string; masterSet: string; rubric: number; framesKey: string };
/** The masters as one canonical string: each master's kind and the identity of its picture, sorted, each once. */
export function masterSetKey(masters: readonly Pick<VerifyMaster, "kind" | "identity">[]): string {
  return [...new Set(masters.flatMap((m) => (m.identity ? [`${m.kind}:${m.identity}`] : [])))].sort().join("|");
}
/** Which frames a take is read at: a still once, a video at the sampler's fixed points. */
export function framesKey(asset: Pick<Asset, "kind">): string {
  return asset.kind === "video" ? `video:${VERIFY_FRAMES.videoAt.join(",")}` : "still";
}
export function verifyKeyOf(subject: VerifySubject): VerifyKey | null {
  if (subject.problem || !subject.take?.asset || !subject.take.identity) return null;
  return { takeId: subject.take.identity, masterSet: masterSetKey(subject.masters), rubric: VERIFY_RUBRIC, framesKey: framesKey(subject.take.asset) };
}
export function sameVerifyKey(a: VerifyKey, b: Pick<TakeVerification, "takeId" | "masterSet" | "rubric" | "framesKey">): boolean {
  return a.takeId === b.takeId && a.masterSet === b.masterSet && a.rubric === b.rubric && a.framesKey === b.framesKey;
}

/** What a card checks now, as far as it can be read even while the card has a problem (a master with no picture, say). */
export type VerifyParts = { takeId: string | null; masterSet: string; rubric: number };
export function verifyParts(subject: VerifySubject): VerifyParts {
  return { takeId: subject.take?.identity ?? null, masterSet: masterSetKey(subject.masters), rubric: VERIFY_RUBRIC };
}

/**
 * How a stored check stands against what its card checks now. A check of the
 * same take against other masters is "checked against an older master": the
 * plan's staleness, rebuilt on the evidence the check actually used.
 */
export type VerifyStanding = "current" | "older-master" | "older-take" | "older-rubric";
export function verificationStanding(v: Pick<TakeVerification, "takeId" | "masterSet" | "rubric">, parts: VerifyParts): VerifyStanding {
  if (v.takeId !== parts.takeId) return "older-take";
  if (v.masterSet !== parts.masterSet) return "older-master";
  if (v.rubric !== parts.rubric) return "older-rubric";
  return "current";
}

/**
 * The check a card shows: the stored one for exactly what it checks now (from
 * whichever card asked, as the same key is the same check), else the newest
 * this card asked for, with how it stands.
 */
export function verificationFor(list: readonly TakeVerification[], nodeId: string, subject: VerifySubject): { verification: TakeVerification; standing: VerifyStanding } | null {
  const key = verifyKeyOf(subject);
  const exact = key ? list.find((v) => sameVerifyKey(key, v)) : undefined;
  if (exact) return { verification: exact, standing: "current" };
  const own = list.filter((v) => v.verifyNodeId === nodeId).sort((a, b) => b.createdAt - a.createdAt)[0];
  return own ? { verification: own, standing: verificationStanding(own, verifyParts(subject)) } : null;
}

/* ── Making the card ───────────────────────────────────────────────────── */

const VERIFY_BLOCK = { rubric: VERIFY_RUBRIC, frames: { videoAt: [...VERIFY_FRAMES.videoAt], max: VERIFY_FRAMES.max } };
/** The shot's own Cast, Environment and Element inputs: the masters its check starts with. */
function shotMasters(project: Project, shot: CanvasNode): string[] {
  return shot.linked.filter((id) => {
    const card = project.nodes.find((n) => n.id === id);
    const kind = card && !isShot(card) ? refKindOf(card, project) : null;
    return !!kind && kind !== "ref";
  });
}

/**
 * The shot's Verify card: the one already wired to it (with any of the shot's
 * masters it lacks wired in), or a new one beside the shot, wired to the shot
 * and its masters. Free: a canvas edit like any other.
 */
export function verifyCardFor(project: Project, shotId: string, id = uid("node")): { project: Project; id: string } {
  const shot = project.nodes.find((n) => n.id === shotId);
  if (!shot || !isShot(shot)) throw new RigBuildError("Choose a shot first.");
  const masters = shotMasters(project, shot);
  const existing = project.nodes.find((n) => isVerifyCard(n) && n.linked.includes(shotId));
  if (existing) {
    const missing = existing.locked ? [] : masters.filter((m) => !existing.linked.includes(m)).slice(0, Math.max(0, 100 - existing.linked.length));
    if (!missing.length) return { project, id: existing.id };
    return { project: { ...project, nodes: project.nodes.map((n) => (n.id === existing.id ? { ...n, linked: [...n.linked, ...missing] } : n)) }, id: existing.id };
  }
  if (project.nodes.length >= PROJECT_LIMITS.nodes) throw new RigBuildError(`This rig holds ${PROJECT_LIMITS.nodes} nodes; remove one to add a Verify card.`);
  const x = Math.min(19_000, Math.round(shot.x + (shot.width || 238) + 80)), y = Math.max(-10_000, Math.min(19_000, Math.round(shot.y)));
  const card: CanvasNode = {
    ...createNode("review", project.nodes.length, { x, y }), id,
    title: `Verify · ${shot.title || "shot"}`.slice(0, 300), text: "",
    linked: [shotId, ...masters].slice(0, 100), verify: { ...VERIFY_BLOCK, frames: { ...VERIFY_BLOCK.frames } },
  };
  return { project: { ...project, nodes: [...project.nodes, card] }, id };
}

/** The card's last verdict, for everyone on the canvas (the scorecard itself is read from the stored check). */
export function withVerifyLast(project: Project, nodeId: string, last: { id: string; takeId: string; verdict: Verdict; at: number }): Project {
  const node = project.nodes.find((n) => n.id === nodeId);
  if (!node || !isVerifyCard(node) || node.locked || node.verify?.last?.id === last.id) return project;
  return { ...project, nodes: project.nodes.map((n) => (n.id === nodeId ? { ...n, verify: { ...n.verify, rubric: n.verify?.rubric ?? VERIFY_RUBRIC, last } } : n)) };
}

/* ── Words ─────────────────────────────────────────────────────────────── */

export const VERDICT_WORDS: Record<Verdict, string> = { pass: "Passed", fail: "Failed", needs_you: "Needs you" };
export const CHECK_VERDICT_WORDS: Record<CheckVerdict, string> = { pass: "Pass", fail: "Fail", unsure: "Unsure" };
export const STANDING_WORDS: Record<Exclude<VerifyStanding, "current">, string> = {
  "older-master": "Checked against an older master",
  "older-take": "Checked an earlier take",
  "older-rubric": "Checked with an older rubric",
};
/** The card's one-line summary: which checks failed or were unsure, or that all passed. */
export function verdictLine(checks: readonly VerifyCheckResult[]): string {
  const failed = checks.filter((c) => c.verdict === "fail").map((c) => VERIFY_CHECK_LABELS[c.check]);
  const unsure = checks.filter((c) => c.verdict === "unsure").map((c) => VERIFY_CHECK_LABELS[c.check]);
  if (failed.length) return `${failed.join(", ")} failed${unsure.length ? ` · ${unsure.join(", ")} unsure` : ""}`;
  if (unsure.length) return `${unsure.join(", ")} unsure`;
  return `${checks.length} ${checks.length === 1 ? "check" : "checks"} passed`;
}
/** A still for a stored frame or take: its 640px preview, or the sample itself. */
export function verifyFrameUrl(frame: VerifyFrame | null | undefined, takeId: string): string | null {
  if (frame?.uploadId) return `/api/workbench/preview/upload/${encodeURIComponent(frame.uploadId)}`;
  const [kind, ...rest] = takeId.split(":"), id = rest.join(":");
  if (kind === "generation") return `/api/workbench/preview/generation/${encodeURIComponent(id)}`;
  if (kind === "upload") return `/api/workbench/preview/upload/${encodeURIComponent(id)}`;
  return kind === "sample" && SAMPLE.test(id) ? id : null;
}
