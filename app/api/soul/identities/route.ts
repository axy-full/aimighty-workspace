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
    /* Training on a likeness records that the person consented (consent_at), and recording consent is people-only:
       an API or MCP token, of any scope, and Atomik's agent identities are refused (lib/security/people-only.ts). */
    if (!isPerson({ user: got.user, token: got.token }))
      return Response.json({ error: PEOPLE_ONLY }, { status: 403, headers });
    return withGenerationRequest(request, got.user.id, async (claim) => {
      try {
        const body = (await request.json()) as CreateSoulIdentityInput & { consentId?: unknown };
        /* The Cast card's consent step: a training request may cite a recorded consent, which must be live, this
           workspace's, for this production and cover the face. It is checked before anything paid is sent. */
        const consent = body.consentId === undefined ? null
          : await consentForTraining(body.consentId, await projectKeysFor(body.projectId, got.user.id));
        const identity = await createSoulIdentity(body, claim);
        if (consent) await linkConsentIdentity(consent.id, identity.id);
        return Response.json({ identity }, { status: 202, headers });
      } catch (error) {
        if (
          error instanceof SoulIdentityError ||
          error instanceof SpendReservationError ||
          error instanceof ConsentError
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
