import { NextResponse, after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireRender, withTenant } from "@/lib/auth";
import { withGenerationRequest } from "@/lib/generationRequests";
import { executeAudioAdmission } from "@/lib/audioAdmission";
import { admissionResponse } from "@/lib/admissionSupport";
import { creditsApply } from "@/lib/credits";
import { requireTenant } from "@/lib/tenant";
import { GROK_SPEECH_MODEL, GROK_TTS_MODEL, grokVoiceConfigured, listGrokVoices } from "@/lib/xaiVoice";
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
        defer: async (work) => {
          after(await reserveRecoveryContinuation("after-response", work));
        },
      }),
    );
  return body.quoteOnly === true
    ? perform()
    : withGenerationRequest(req, got.user.id, perform, { atomicBinding: true });
});

/** What the Audio screen needs to draw itself: engines, terms, and — when
 *  connected — the voices and the account's credit position.
 *
 *  Sound is ElevenLabs' (every task) and xAI's (Grok Voice lines only);
 *  either one connected is enough to speak. `voices` are the default speech
 *  model's, and Grok Voice's own list rides beside them in `grokVoices`, so a
 *  picker swaps lists with the model and never pairs a voice with the wrong
 *  vendor. */
export const GET = withTenant(async function GET() {
  const got = await requireRender();
  if (got.response) return got.response;
  const eleven = elevenConfigured();
  const grok = grokVoiceConfigured();
  const configured = eleven || grok;
  const [elevenVoices, grokVoices, account] = await Promise.all([
    eleven ? listVoices().catch((e: Error) => ({ error: e.message })) : Promise.resolve([]),
    grok
      ? listGrokVoices()
          .then((list) => list.map((v) => ({ id: v.id, name: v.name, category: "grok", labels: v.language ? { language: v.language } : {}, previewUrl: null, description: "" })))
          .catch((e: Error) => ({ error: e.message }))
      : Promise.resolve([]),
    eleven && !creditsApply(requireTenant())
      ? subscription().catch((e: Error) => ({ error: e.message }))
      : Promise.resolve(null),
  ]);
  const voices = eleven ? elevenVoices : grokVoices;
  return NextResponse.json({
    configured,
    vendors: { elevenlabs: eleven, xai: grok },
    envKey: "ELEVENLABS_API_KEY",
    speechModels: [...(eleven || !grok ? SPEECH_MODELS : []), ...(grok ? [GROK_SPEECH_MODEL] : [])],
    defaultSpeechModel: eleven || !grok ? DEFAULT_SPEECH_MODEL : GROK_TTS_MODEL,
    voices: Array.isArray(voices) ? voices : [],
    grokVoices: Array.isArray(grokVoices) ? grokVoices : [],
    voicesError: Array.isArray(voices)
      ? null
      : (voices as { error: string }).error,
    grokVoicesError: Array.isArray(grokVoices) ? null : grokVoices.error,
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
