import type {
  AdmissionActor,
  AdmissionReply,
  PreparedAdmission,
} from "../admissionTypes";
import { admitGeneration } from "../generationAdmission";
import { admitAudio } from "../audioAdmission";
import { requireTenant } from "../tenant";
import { PipelineError } from "./schema";
import { pipelineStore, type PipelineStore } from "./store";
import { withPipelineActor } from "./actor";

type Admit = (
  prepared: PreparedAdmission,
  actor: AdmissionActor,
  options: {
    requestKey: string;
    defer: (work: () => Promise<unknown>) => void | Promise<void>;
  },
) => Promise<AdmissionReply>;
type Dependencies = {
  actor: AdmissionActor;
  defer: (work: () => Promise<unknown>) => void | Promise<void>;
  image?: Admit;
  audio?: Admit;
  deadlineAt?: number;
};

/** Each tick is bounded. Provider work uses its existing permanent admission
 * claim/outbox; the pipeline lease only protects orchestration checkpoints. */
export async function advancePipelineRun(
  store: PipelineStore,
  runId: string,
  deps: Dependencies,
) {
  let lease = await store.claimRun(runId, Date.now(), 120_000);
  if (!lease) return { busy: true };
  try {
    let run = await store.getRun(deps.actor.user.id, runId);
    if (deps.actor.token)
      throw new PipelineError(
        "Pipeline workers require the approving account.",
        403,
      );
    const deadlineAt = deps.deadlineAt ?? Date.now() + 45_000;
    let handled = 0;
    for (const candidate of run.attempts) {
      if (Date.now() >= deadlineAt || handled >= 8) break;
      if (["succeeded", "failed", "refused"].includes(candidate.state))
        continue;
      lease = await store.renewRun(lease, Date.now(), 120_000);
      if (candidate.generationId) {
        run = await store.recordAdmission(lease, candidate.id, {
          status: 200,
          body: { id: candidate.generationId },
        });
        handled++;
        continue;
      }
      const attempt = await store.beginAttempt(lease, candidate.id);
      if (!attempt) continue;
      let reply: AdmissionReply;
      try {
        reply = await (
          attempt.prepared.kind === "audio"
            ? (deps.audio ?? admitAudio)
            : (deps.image ?? admitGeneration)
        )(attempt.prepared, deps.actor, {
          requestKey: attempt.requestKey,
          defer: deps.defer,
        });
      } catch {
        // Exceptions are ambiguous. Never replace the authorized request key.
        reply = {
          status: 503,
          body: {
            pending: true,
            error:
              "This submitted attempt needs recovery. Its original request is preserved.",
          },
        };
      }
      run = await store.recordAdmission(lease, attempt.id, reply);
      handled++;
    }
    run = await store.assemble(lease);
    const pending = run.attempts.some((a) =>
      ["queued", "submitting", "running", "uncertain"].includes(a.state),
    );
    if (pending && run.state !== "cancelled")
      await store.scheduleWake(
        runId,
        Date.now() + (run.state === "paused" ? 60_000 : 10_000),
      );
    return { busy: false, handled, pending, state: run.state };
  } finally {
    await store.releaseRun(lease);
  }
}

/** Called by a request's after() lifetime and the existing authenticated cron.
 * An acknowledged wake never erases a newer wake posted during its lease. */
export async function drainPipelineWakeups(options: {
  limit?: number;
  deadlineAt?: number;
  defer: Dependencies["defer"];
}) {
  const store = await pipelineStore(),
    workspaceId = requireTenant().id;
  let completed = 0,
    failed = 0;
  const deadlineAt = options.deadlineAt ?? Date.now() + 45_000;
  for (
    let i = 0;
    i < Math.min(options.limit ?? 4, 10) && Date.now() < deadlineAt;
    i++
  ) {
    const wake = await store.claimWake(Date.now(), 120_000);
    if (!wake) break;
    try {
      const run = await store.getWorkerRun(wake.runId);
      const result = await withPipelineActor(workspaceId, run.owner, (actor) =>
        advancePipelineRun(store, run.id, {
          actor,
          defer: options.defer,
          deadlineAt,
        }),
      );
      await store.acknowledgeWake(
        wake,
        result.busy ? Date.now() + 30_000 : undefined,
      );
      completed++;
    } catch {
      failed++;
      await store.acknowledgeWake(wake, Date.now() + 60_000);
    }
  }
  return { completed, failed };
}
