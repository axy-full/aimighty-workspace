/**
 * Browser-safe reading of a saved connected job, shared by every workflow page.
 *
 * A job still sending, or sent with no confirmed answer, gates new spend in its
 * workflow: it may be running on the account, and it is never sent again. Once
 * its owner sets it aside in Workspace › Engines, or it outlives the capacity
 * window, the service marks it `setAside` (lib/higgsfield-consumer/jobs.ts,
 * consumerJobSetAside). It stays listed, and a saved receipt can still be
 * checked, but it no longer blocks the workflow.
 */
type SavedJob = { status: string; setAside?: boolean };
const unconfirmed = (job: SavedJob) => job.status === "dispatching" || job.status === "uncertain";

/** Sending or unconfirmed, and still gating new spend in its workflow. */
export const awaitingReconciliation = (job: SavedJob) => unconfirmed(job) && job.setAside !== true;
/** Sending or unconfirmed, but set aside: shown as such, never gating spend. */
export const setAsideUnconfirmed = (job: SavedJob) => unconfirmed(job) && job.setAside === true;
export const SET_ASIDE_LABEL = "Set aside · never sent again";
