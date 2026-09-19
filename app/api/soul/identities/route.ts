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
    return withGenerationRequest(request, got.user.id, async (claim) => {
      try {
        const body = (await request.json()) as CreateSoulIdentityInput;
        const identity = await createSoulIdentity(body, claim);
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
