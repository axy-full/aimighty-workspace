import type {
  AdmissionActor,
  AdmissionCheckpoint,
  AdmissionExecution,
  AdmissionExecutor,
  AdmissionReply,
  PreparedAdmission,
  PrepareAdmissionResult,
} from "./admissionTypes";
import { currentTenant, requireTenant } from "./tenant";
import { db } from "./db";
import { creditsApply } from "./credits";
import { billCredits } from "./creditTerms";
import { billedTo } from "./providers";
import { paidByPlatform, vendorKeyNameFor } from "./platformSpend";
import {
  generationFingerprint,
  withGenerationRequestData,
} from "./generationRequests";

export function admissionReply(
  body: Record<string, unknown>,
  init: { status?: number } = {},
): AdmissionReply {
  return { body, status: init.status ?? 200 };
}
export function admissionResponse(reply: AdmissionReply): Response {
  return Response.json(reply.body, {
    status: reply.status,
    headers: reply.headers,
  });
}

/** The executor must restore a freshly authorized actor into tenant scope, never a snapshot role. */
export function assertAdmissionActor(
  actor: AdmissionActor,
): AdmissionReply | undefined {
  const scope = currentTenant();
  if (
    !scope?.workspace ||
    !scope.user ||
    scope.user.id !== actor.user.id ||
    scope.user.disabled ||
    actor.user.disabled
  )
    return admissionReply(
      { error: "A current workspace member must approve this generation." },
      { status: 403 },
    );
  if (
    scope.user.role !== actor.user.role ||
    scope.token?.id !== actor.token?.id ||
    (scope.token && scope.token.scope !== "render") ||
    (actor.token && actor.token.scope !== "render")
  )
    return admissionReply(
      { error: "This actor is not authorized to render in this workspace." },
      { status: 403 },
    );
  if (scope.workspace.deletedAt)
    return admissionReply(
      { error: "This workspace has been deleted." },
      { status: 410 },
    );
  if (scope.workspace.suspendedAt)
    return admissionReply(
      { error: "This workspace is suspended. Rendering is paused." },
      { status: 423 },
    );
}

/** The existing admission price is the only source of quote arithmetic. */
export function admissionCheckpoint(
  options: AdmissionExecution,
  request: Record<string, unknown>,
  actor: AdmissionActor,
  kind: PreparedAdmission["kind"],
  usd: number,
  margin: string,
  compiled: Record<string, unknown>,
): AdmissionReply | undefined {
  if (!options.checkpoint) return;
  // Explicit source identities also let deletion guards protect quoted implicit cast references.
  const resolved = structuredClone(compiled);
  const engine =
    kind === "audio"
      ? "elevenlabs"
      : billedTo(
          String(
            (compiled.model as { provider?: string } | undefined)?.provider ??
              "byteplus",
          ),
        );
  resolved.funding = {
    engine,
    paidByPlatform: paidByPlatform(vendorKeyNameFor(engine)),
  };
  if (Array.isArray(resolved.references))
    resolved.references = resolved.references.map((reference) => ({
      ...reference,
      ...(reference.fromGeneration
        ? { genId: reference.id }
        : { uploadId: reference.id }),
    }));
  const estimatedCredits = billCredits(usd, margin);
  const unit = creditsApply(requireTenant()) ? "cr" : "usd";
  const quote = {
    estimatedCredits,
    price: unit === "cr" ? estimatedCredits : usd,
    unit,
  } as const;
  return options.checkpoint({
    kind,
    request,
    compiled: resolved,
    quote: {
      ...quote,
      fingerprint: generationFingerprint({
        version: 1,
        workspaceId: requireTenant().id,
        actorId: actor.user.id,
        kind,
        compiled: resolved,
        quote,
      }),
    },
  });
}

export async function prepareAdmission(
  input: Record<string, unknown>,
  actor: AdmissionActor,
  execute: AdmissionExecutor,
): Promise<PrepareAdmissionResult> {
  let captured: AdmissionCheckpoint | undefined;
  const request = structuredClone(input);
  delete request.maxCredits; // A fresh quote replaces a previous ceiling; admission restores the quoted ceiling.
  const reply = await execute(request, actor, {
    defer: () => {
      throw new Error("Preparation cannot dispatch paid work.");
    },
    checkpoint: (value) => {
      captured = value;
      return admissionReply({});
    },
  });
  if (!captured) return { ok: false, status: reply.status, body: reply.body };
  return {
    ok: true,
    value: {
      version: 1,
      kind: captured.kind,
      workspaceId: requireTenant().id,
      actorId: actor.user.id,
      request: {
        ...structuredClone(captured.request),
        maxCredits: captured.quote.estimatedCredits,
      },
      compiled: captured.compiled,
      quote: captured.quote,
    },
  };
}

export async function admitPrepared(
  prepared: PreparedAdmission,
  actor: AdmissionActor,
  options: { requestKey: string; defer: AdmissionExecution["defer"] },
  namespace: "generation" | "audio",
  execute: AdmissionExecutor,
): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(actor);
  if (refusal) return refusal;
  if (
    prepared.version !== 1 ||
    prepared.workspaceId !== requireTenant().id ||
    prepared.actorId !== actor.user.id ||
    (namespace === "audio") !== (prepared.kind === "audio")
  )
    return admissionReply(
      { error: "This approval belongs to another actor or workspace." },
      { status: 409 },
    );
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(options.requestKey))
    return admissionReply(
      { error: "The request key is invalid." },
      { status: 400 },
    );
  const response = await withGenerationRequestData(
    {
      userId: actor.user.id,
      key: options.requestKey,
      fingerprint: generationFingerprint({
        namespace: `pipeline-${namespace}-v1`,
        prepared,
      }),
    },
    async (requestClaim) =>
      admissionResponse(
        await execute(prepared.request, actor, {
          requestClaim,
          defer: options.defer,
          checkpoint: (current) =>
            current.kind !== prepared.kind ||
            current.quote.fingerprint !== prepared.quote.fingerprint
              ? admissionReply(
                  {
                    error:
                      "The compiled generation or price changed. Review and approve a fresh quote.",
                    quoteChanged: true,
                  },
                  { status: 409 },
                )
              : undefined,
        }),
      ),
    // Generation and audio admission bind the claim in the same write as the job row.
    { atomicBinding: true },
  );
  const body = await response.json();
  // A historical route failure may omit its already-created ID. The domain
  // caller must still reconcile that exact job, never buy a replacement blindly.
  if (!body.id) {
    const existing = (
      await db().execute({
        sql: `SELECT g.id,g.status FROM generation_requests r JOIN generations g ON g.id=r.generation_id
        WHERE r.user_id=? AND r.request_key=?`,
        args: [actor.user.id, options.requestKey],
      })
    ).rows[0];
    if (existing) {
      body.id = existing.id;
      body.status = existing.status;
    }
  }
  return {
    status: response.status,
    body,
    headers: Object.fromEntries(response.headers),
  };
}
