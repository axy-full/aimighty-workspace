"use client";
import { useCallback, useState } from "react";
import { reviewProjectTake } from "@/lib/workspace/library";
import type { ReviewState } from "@/lib/workspace/takes";
import { refreshTakeNotes } from "./use-take-notes";
import { REJECT_REASON_MAX, cleanRejectReason, rejectReasonProblem, reviewStateOf, type ShotTakes, type ShotVersion } from "./take-model";

export { REJECT_REASON_MAX };

/*
 * Approve and Reject on a take (README § 3.1 g, § 4: free, a person's call), shared by the take cards and review
 * mode (and stream 10's phone review). Both go through the review trail that exists today:
 *
 * - Approve: PATCH /api/jobs/:id `{ reviewState: "approved" }`, which records who and when. One approved version
 *   per take: any other approved version of the same shot is cleared in the same action. Undo writes every
 *   version back as it was.
 * - Reject: the trail's "changes" mark, and the reason (required: one line, 3 to 500 characters) as a note on that take
 *   (POST /api/notes), recorded with the person and the time. The version is kept; nothing more is spent.
 *   Undo clears the mark; the note stays as history.
 * - Take back an approval: the version goes back to Ready, as it was before it was approved when that is known (an
 *   artist's "picked" is restored if this page saw it approved from picked; otherwise "", Needs review). Undo
 *   approves it again. Only a person: the route refuses anyone else clearing a sign-off.
 *
 * Nothing here is paid and nothing is erased.
 */

export type Judge = {
  busy: string | null;
  approve: (row: Pick<ShotTakes, "index" | "versions">, version: ShotVersion) => Promise<boolean>;
  reject: (row: Pick<ShotTakes, "index" | "versions">, version: ShotVersion, reason: string) => Promise<boolean>;
  /** An approved version back to Ready (its earlier Ready state when known), with an Undo that approves it again. */
  unapprove: (row: Pick<ShotTakes, "index">, version: ShotVersion) => Promise<boolean>;
};

/*
 * The Ready state each version had when this page approved it, so that taking the approval back restores an artist's
 * "picked" instead of losing it. Per scope and take; only Ready states are kept ("changes" before an approval comes back
 * as Ready, since taking an approval back is "back to Ready"). Unknown (approved elsewhere, or before a reload): "".
 */
const readyBefore = new Map<string, ReviewState>();
const readyKey = (scope: string, genId: string) => `${scope}\n${genId}`;
/** What taking back an approval of `genId` writes: its Ready state before it was approved, when this page knows it. */
export function readyStateBeforeApproval(scope: string, genId: string): ReviewState {
  return readyBefore.get(readyKey(scope, genId)) === "picked" ? "picked" : "";
}


export async function postTakeNote(scope: string, genId: string, text: string): Promise<void> {
  const response = await fetch("/api/notes", {
    method: "POST", cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
    body: JSON.stringify({ genId, text: text.slice(0, REJECT_REASON_MAX) }),
  }).catch(() => null);
  if (!response?.ok) {
    const json = await response?.json().catch(() => null) as { error?: string } | null;
    throw new Error(json?.error || "The reason was not saved.");
  }
  refreshTakeNotes(scope, genId);
}

export type JudgeToast = (text: string, undo?: { label: string; run: () => void }) => void;

export function useJudge(scope: string, projectId: string, toast: JudgeToast): Judge {
  const [busy, setBusy] = useState<string | null>(null);
  const restore = useCallback(async (states: readonly { genId: string; state: ReviewState }[]) => {
    try {
      for (const s of states) await reviewProjectTake(scope, projectId, s.genId, s.state);
    } catch (error) {
      toast(error instanceof Error ? error.message : "The review was not saved.");
    }
  }, [scope, projectId, toast]);

  const approve = useCallback(async (row: Pick<ShotTakes, "index" | "versions">, version: ShotVersion) => {
    if (busy) return false;
    setBusy(version.genId);
    const others = row.versions.filter((v) => v.genId !== version.genId && v.status === "approved");
    const before = [{ genId: version.genId, state: reviewStateOf(version.status) }, ...others.map((v) => ({ genId: v.genId, state: "approved" as const }))];
    try {
      await reviewProjectTake(scope, projectId, version.genId, "approved");
      if (version.status !== "approved") readyBefore.set(readyKey(scope, version.genId), reviewStateOf(version.status) === "picked" ? "picked" : "");
      for (const v of others) await reviewProjectTake(scope, projectId, v.genId, "");
      toast(`Shot ${row.index} ${version.label} approved`, { label: `Shot ${row.index} ${version.label} approved`, run: () => { void restore(before); } });
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : "The review was not saved.");
      return false;
    } finally {
      setBusy(null);
    }
  }, [busy, scope, projectId, toast, restore]);

  const reject = useCallback(async (row: Pick<ShotTakes, "index" | "versions">, version: ShotVersion, reason: string) => {
    if (busy || rejectReasonProblem(reason)) return false;
    setBusy(version.genId);
    const before = [{ genId: version.genId, state: reviewStateOf(version.status) }];
    try {
      await reviewProjectTake(scope, projectId, version.genId, "changes");
      /* The mark stands whether or not the note lands; a note that did not land says so. */
      const noted = await postTakeNote(scope, version.genId, cleanRejectReason(reason)).then(() => true, () => false);
      const said = `Shot ${row.index} · ${version.label} rejected`;
      toast(noted ? said : `${said}. The reason was not saved.`, { label: said, run: () => { void restore(before); } });
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : "The review was not saved.");
      return false;
    } finally {
      setBusy(null);
    }
  }, [busy, scope, projectId, toast, restore]);

  const unapprove = useCallback(async (row: Pick<ShotTakes, "index">, version: ShotVersion) => {
    if (busy || version.status !== "approved") return false;
    setBusy(version.genId);
    const back = readyStateBeforeApproval(scope, version.genId);
    try {
      await reviewProjectTake(scope, projectId, version.genId, back);
      const said = `Shot ${row.index} ${version.label} is Ready again`;
      toast(said, { label: said, run: () => { void restore([{ genId: version.genId, state: "approved" }]); } });
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : "The review was not saved.");
      return false;
    } finally {
      setBusy(null);
    }
  }, [busy, scope, projectId, toast, restore]);

  return { busy, approve, reject, unapprove };
}
