import { NextResponse, after } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { withGenerationRequest } from "@/lib/generationRequests";
import { executeAudioAdmission } from "@/lib/audioAdmission";
import { admissionResponse } from "@/lib/admissionSupport";
import { creditsApply } from "@/lib/credits";
import { requireTenant } from "@/lib/tenant";
import {
  elevenConfigured,
  subscription,
  listVoices,
  SPEECH_MODELS,
  DEFAULT_SPEECH_MODEL,
  SFX_CREDITS,
  MUSIC_CREDITS_PER_MINUTE,
} from "@/lib/elevenlabs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const body = await req
    .clone()
    .json()
    .catch(() => ({}));
  const perform = async (
    requestClaim?: import("@/lib/generationRequests").GenerationRequest,
  ) =>
    admissionResponse(
      await executeAudioAdmission(body, got, {
        requestClaim,
        defer: (work) =>
          after(async () => {
            await work();
          }),
      }),
    );
  return body.quoteOnly === true
    ? perform()
    : withGenerationRequest(req, got.user.id, perform);
});

/** What the Audio screen needs to draw itself: engines, terms, and — when
 *  connected — the voices and the account's credit position. */
export const GET = withTenant(async function GET() {
  const got = await requireRender();
  if (got.response) return got.response;
  const configured = elevenConfigured();
  const [voices, account] = configured
    ? await Promise.all([
        listVoices().catch((e: Error) => ({ error: e.message })),
        creditsApply(requireTenant())
          ? Promise.resolve(null)
          : subscription().catch((e: Error) => ({ error: e.message })),
      ])
    : [[], null];
  return NextResponse.json({
    configured,
    envKey: "ELEVENLABS_API_KEY",
    speechModels: SPEECH_MODELS,
    defaultSpeechModel: DEFAULT_SPEECH_MODEL,
    voices: Array.isArray(voices) ? voices : [],
    voicesError: Array.isArray(voices)
      ? null
      : (voices as { error: string }).error,
    account:
      !creditsApply(requireTenant()) && account && !("error" in account)
        ? account
        : null,
    accountError:
      !creditsApply(requireTenant()) && account && "error" in account
        ? account.error
        : null,
    terms: {
      sfxCredits: SFX_CREDITS,
      musicCreditsPerMinute: MUSIC_CREDITS_PER_MINUTE,
    },
  });
});
