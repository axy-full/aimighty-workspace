/**
 * The recovery drain's continuation of one platform-funded website job, known
 * by its meter id (the reservation's id). It only continues what was already
 * admitted before the fence, the way the job's own page would:
 * - ended (collected or failed) → settled from the job's own ledger;
 * - still a quote (a reservation whose claim never happened) → fenced, then
 *   released to zero: nothing was sent;
 * - accepted → one leased status read of that same provider job;
 * - dispatching or uncertain → left loud: whether it was sent is unknown, and
 *   it is never sent again.
 * Never quotes, dispatches or resubmits anything.
 */
import { requireTenant } from "@/lib/tenant";
import { consumerJobsById, fenceConsumerQuotes, type ConsumerJobScope, type ConsumerWorkflow } from "./jobs";
import { websiteJobPinByMeter } from "./platform-jobs";
import { releaseWebsiteJob, settleEndedWebsiteJob } from "./account-billing";
import { pollConsumerMarketingVideo } from "./video-service";

const POLLS: Partial<Record<ConsumerWorkflow, (scope: ConsumerJobScope) => Promise<unknown>>> = {
  "marketing-video": pollConsumerMarketingVideo,
};

export const isWebsiteMeterId = (id: string) => /^gen_hfc_[a-f0-9]{40}$/.test(id);

/** True when this intent is a platform website job this drain handled (settled, released or read). */
export async function drainWebsiteJob(meterId: string): Promise<boolean> {
  if (!isWebsiteMeterId(meterId)) return false;
  const pin = await websiteJobPinByMeter(requireTenant().id, meterId);
  if (!pin) return false;
  const [job] = await consumerJobsById([pin.jobId]);
  if (!job || job.meterId !== meterId) throw new Error("Recovery intent names a website job this workspace does not hold.");
  if (job.status === "completed" || job.status === "failed") {
    await settleEndedWebsiteJob(job, pin.tool);
    return true;
  }
  if (job.status === "quoted") {
    const [fenced] = await fenceConsumerQuotes([{ userId: job.userId, draftId: job.draftId, id: job.id }]);
    if (fenced.status !== "quoted") throw new Error("A website job was claimed while its intent drained; it stays for review.");
    await releaseWebsiteJob(fenced, pin.tool);
    return true;
  }
  if (job.status === "accepted") {
    const poll = POLLS[job.workflow];
    if (!poll) throw new Error("This website job's workflow has no continuation yet.");
    await poll({ userId: job.userId, draftId: job.draftId, id: job.id });
    return true;
  }
  throw new Error("A website job whose submission is unconfirmed stays for review; it is never sent again.");
}
