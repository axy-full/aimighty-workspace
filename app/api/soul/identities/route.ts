import { requireUser, requireRender, withTenant } from "@/lib/auth";
import {
  withGenerationRequest,
  SpendReservationError,
} from "@/lib/generationRequests";
import {
  createSoulIdentity,
  listSoulIdentities,
  syncSoulIdentity,
  soulIdentityTerms,
  SoulIdentityError,
  type CreateSoulIdentityInput,
} from "@/lib/soulIdentities";
import { soulCharacterGenerationEnabled } from "@/lib/vendorRates";
import { consentForTraining, linkConsentIdentity, projectKeysFor } from "@/lib/security/consent";
import { ConsentError } from "@/lib/security/consent-words";
import { PEOPLE_ONLY, isPerson } from "@/lib/security/people-only";
import { higgsfieldConfigured } from "@/lib/higgsfield";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const headers = { "Cache-Control": "private, no-store" };
export const GET = withTenant(async (request: Request) => {
  const got = await requireUser();
  if (got.response) return got.response;
  try {
    const projectId = new URL(request.url).searchParams.get("projectId");
    const identities = await listSoulIdentities(projectId);
    let refreshed = 0;
    for (let i = 0; i < identities.length && refreshed < 5; i++) {
      if (
        ["submitting", "training", "uncertain"].includes(identities[i].status)
      ) {
        identities[i] =
          (await syncSoulIdentity(identities[i].id)) ?? identities[i];
        refreshed++;
      }
    }
    return Response.json(
      {
        identities,
        configured: higgsfieldConfigured(),
        generationAvailable: soulCharacterGenerationEnabled(),
        terms: soulIdentityTerms(),
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof SoulIdentityError)
      return Response.json(
        { error: error.message },
        { status: error.status, headers },
      );
    throw error;
  }
});
export const POST = withTenant(
  async (request: Request) => {
    const got = await requireRender();
    if (got.response) return got.response;
    /* Training is a person's priced press, as it has always been here: an API or MCP token, of any scope, and Atomik's
       agent identities are refused (lib/security/people-only.ts). So the tick it may carry is only ever a person's. */
    if (!isPerson({ user: got.user, token: got.token }))
      return Response.json({ error: PEOPLE_ONLY }, { status: 403, headers });
    /* The sample workspace spends nothing: answered before the request is claimed. */
    { const off = await sampleWorkspaceOff(); if (off) return off; }
    /* A tick, not a gate (owner, 23 Oct 2026): a training that cites a live tick for the production it names and the same
       cast member is linked to it; one that cites none, or a withdrawn or ended one, trains all the same. Only a
       malformed citation is refused, in words, before anything is claimed or sent (review of #558, M1). */
    const peek = (await request.clone().json().catch(() => null)) as (CreateSoulIdentityInput & { consentId?: unknown; subjectKey?: unknown }) | null;
    if (!peek || typeof peek !== "object") return Response.json({ error: "Send a valid identity request." }, { status: 400, headers });
    let tick: Awaited<ReturnType<typeof consentForTraining>>;
    try {
      tick = await consentForTraining(peek.consentId, await projectKeysFor(peek.projectId, got.user.id), peek.subjectKey);
    } catch (error) {
      if (error instanceof ConsentError) return Response.json({ error: error.message }, { status: error.status, headers });
      throw error;
    }
    return withGenerationRequest(request, got.user.id, async (claim) => {
      try {
        const body = (await request.json()) as CreateSoulIdentityInput;
        /* A cited tick is never re-recorded as the presser's: it stays its ticker's, and the link below carries it. Only
           the presser's own `consent: true` records a tick on the identity, as theirs. */
        const identity = await createSoulIdentity(body, claim);
        /* A lost link never fails a training that has started: the tick and the run both stand. */
        if (tick) await linkConsentIdentity(tick.id, identity.id).catch(() => undefined);
        return Response.json({ identity }, { status: 202, headers });
      } catch (error) {
        if (
          error instanceof SoulIdentityError ||
          error instanceof SpendReservationError
        )
          return Response.json(
            { error: error.message },
            { status: error.status, headers },
          );
        if (error instanceof SyntaxError)
          return Response.json(
            { error: "Send a valid identity request." },
            { status: 400, headers },
          );
        throw error;
      }
    });
  },
  { requireRequestScope: true },
);
