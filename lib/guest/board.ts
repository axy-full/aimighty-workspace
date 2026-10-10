import type { SampleBoard } from "../demo/board";
import { clock } from "../demo/content";

/**
 * The sample production as a signed-out visitor reads it (design README § 3.7, frames 2 and P2), shaped from what stream
 * 12's reader returns for the "Particl sample" workspace (lib/demo/board.server.ts › readSampleBoard) plus the finished
 * draft's brief and frame. Pure: the server fills it, the browser draws it. Nothing is invented. A step with no recorded
 * price is left off the plan, a shot is named by the cut's own name, and no id of any kind reaches the page: only words,
 * credits and seconds, never a vendor figure, a balance, a person or a consent record.
 */
export type GuestStep = { title: string; meta: string; credits: number };
export type GuestPlan = {
  /** "Make 3 shots · 93 cr": N shots and the sum of their recorded prices. */
  heading: string;
  steps: GuestStep[];
  total: number;
  /** Up to two fixes per shot: twice the plan (lead decision 28), "at most 186 cr". */
  fixesMost: number;
  /** Shots the ledger holds no price for: said, never guessed. */
  unpriced: string[];
};
export type GuestShot = { index: number; name: string; start: string; seconds: number; approved: boolean };
export type GuestBoard = {
  brief: string;
  /** "16:9 · 24 fps · 15 s". */
  frame: string;
  plan: GuestPlan | null;
  shots: GuestShot[];
  /** "Lead · ivory suit, short dark bob": the cast in the owner's words, never a consent record. */
  cast: string[];
  cut: { approved: number; waiting: number; seconds: string; line: string };
  /** The first shot still waiting for review, with the engine line of its plan step; null when none waits. */
  review: { name: string; meta: string | null } | null;
  /** The delivery checks: pending until every shot of the cut is approved. */
  deliver: { label: string; value: string; pending: boolean }[];
};

const BRIEF_MAX = 600;
const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const tenth = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

export const planHeading = (shots: number, total: number) => `Make ${shots} ${shots === 1 ? "shot" : "shots"} · ${total.toLocaleString("en-US")} cr`;

export function guestBoard(input: { brief?: unknown; aspect?: unknown; fps?: unknown; board: Pick<SampleBoard, "plan" | "cast" | "cut"> }): GuestBoard {
  const { plan, cast, cut } = input.board;
  const steps: GuestStep[] = plan.steps.filter((s) => Number.isFinite(s.credits) && s.credits >= 0).map((s) => ({ title: s.title, meta: s.meta, credits: s.credits }));
  const total = steps.reduce((n, s) => n + s.credits, 0);
  const shots: GuestShot[] = [];
  let at = 0;
  for (const s of cut.shots) {
    shots.push({ index: s.index, name: text(s.name, 80) || `Shot ${s.index}`, start: clock(at), seconds: s.seconds, approved: s.approved });
    at += s.seconds;
  }
  const waiting = shots.find((s) => !s.approved) ?? null;
  const aspect = text(input.aspect, 12), fps = Number(input.fps);
  const frame = [aspect, Number.isFinite(fps) && fps > 0 ? `${tenth(fps)} fps` : "", cut.seconds > 0 ? `${tenth(cut.seconds)} s` : ""].filter(Boolean).join(" · ");
  const take = (n: number) => `${n} approved ${n === 1 ? "take" : "takes"}`;
  const line = cut.approved || cut.waiting
    ? [take(cut.approved), clock(cut.approvedSeconds), waiting ? `${waiting.name} waits for review` : ""].filter(Boolean).join(" · ")
    : "";
  const pending = cut.waiting > 0 || !shots.length;
  const stepOf = waiting ? steps.find((s) => s.title === `Shot ${waiting.index}`) : null;
  return {
    brief: text(input.brief, BRIEF_MAX),
    frame,
    plan: steps.length ? { heading: planHeading(steps.length, total), steps, total, fixesMost: total * 2, unpriced: plan.unpriced.filter((u) => typeof u === "string").slice(0, 12) } : null,
    shots,
    cast: cast.map((c) => text(c.line, 200)).filter(Boolean).slice(0, 12),
    cut: { approved: cut.approved, waiting: cut.waiting, seconds: clock(cut.seconds), line },
    review: waiting ? { name: waiting.name, meta: stepOf?.meta ?? null } : null,
    deliver: [
      { label: "Aspect", value: aspect, pending },
      { label: "Frame rate", value: Number.isFinite(fps) && fps > 0 ? `${tenth(fps)} fps` : "", pending },
      { label: "Duration", value: clock(cut.seconds), pending },
    ].filter((d) => d.value),
  };
}
