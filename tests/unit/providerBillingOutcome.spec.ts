import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  accountBilling, arkRefusalOutcome, arkTaskOutcome, elevenLabsErrorOutcome, falErrorOutcome, gatewayErrorOutcome, gatewayRefusalOutcome,
  googleErrorOutcome, googleRefusalOutcome, higgsfieldAccountOutcome, higgsfieldRefusalOutcome, higgsfieldRequestOutcome, noAnswerOutcome,
  openaiErrorOutcome, outcomeCode, parseOutcome, parseTakeFailure, providerText, serializeOutcome, silentOutcome, takeFailure, accountFailure,
  xaiErrorOutcome, xaiVideoOutcome, type ProviderOutcome, type TakeFailure,
} from "../../lib/providerOutcome";
import { billingSentence, failedChip, failureChargeWord, failureCopy, failureLine, failureUncharged } from "../../lib/errors";

/*
 * What a provider did with a take it rejected or failed, read from its own
 * reply or its own documentation — never guessed. Every fixture below has the
 * shape the provider documents (or its SDK types declare); none was taken from
 * a live call. Four states only: billed (with its amount, in its own unit),
 * refunded, not charged, and "didn't say".
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-provider-outcome-"));
process.env.PLATFORM_DATABASE_URL ??= `file:${path.join(dir, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-provider-outcome";
process.env.ENGINE_MOCK = "1";

const JOB = "3f0e7b1c-5a44-4d2e-9d1a-7c2b8e6f4a10";

test("Higgsfield's API: NSFW and failed are refunded (its FAQ), canceled and refused are not charged, a completion is no failure", () => {
  const nsfw = higgsfieldRequestOutcome({ request_id: JOB, status: "nsfw" })!;
  expect(nsfw).toMatchObject({ provider: "higgsfield", stage: "run", code: "nsfw", kind: "content_filter", billing: { state: "refunded", basis: "hf-refund" } });
  const failed = higgsfieldRequestOutcome({ request_id: JOB, status: "failed", error: "The generation ran out of memory." })!;
  expect(failed).toMatchObject({ code: "failed", kind: "provider_error", message: "The generation ran out of memory.", billing: { state: "refunded" } });
  expect(higgsfieldRequestOutcome({ request_id: JOB, status: "canceled" })).toMatchObject({ code: "canceled", kind: "canceled", billing: { state: "not_charged", basis: "hf-success-only" } });
  expect(higgsfieldRequestOutcome({ request_id: JOB, status: "completed", images: [] })).toBeNull();
  expect(higgsfieldRequestOutcome({ request_id: JOB, status: "in_progress" })).toBeNull();
  expect(higgsfieldRequestOutcome("not an object")).toBeNull();
  /* A FastAPI refusal: its field message, and no request exists to bill. */
  const refused = higgsfieldRefusalOutcome(422, JSON.stringify({ detail: [{ loc: ["body", "prompt"], msg: "field required", type: "missing" }] }));
  expect(refused).toMatchObject({ stage: "submit", code: "missing", kind: "invalid_request", message: "prompt: field required", billing: { state: "not_charged" } });
  expect(higgsfieldRefusalOutcome(429, "Too many concurrent requests")).toMatchObject({ code: "http_429", kind: "rate_limited", message: "Too many concurrent requests", billing: { state: "not_charged" } });
  /* A 5xx is not a refusal the FAQ covers: it did not say. */
  expect(higgsfieldRefusalOutcome(503, null)).toMatchObject({ code: "http_503", kind: "provider_error", billing: { state: "unknown" } });
});

test("the connected account: its status alone never settles the charge; its own ledger does", () => {
  const silent = higgsfieldAccountOutcome("nsfw");
  expect(silent).toMatchObject({ provider: "higgsfield_account", code: "nsfw", kind: "content_filter", billing: { state: "unknown", basis: "hf-account-silent" } });
  expect(higgsfieldAccountOutcome("ip_detected")).toMatchObject({ code: "ip_detected", kind: "rights" });
  expect(higgsfieldAccountOutcome("cancelled")).toMatchObject({ code: "canceled", kind: "canceled" });
  const refunded = higgsfieldAccountOutcome("nsfw", { ledger: { refund: true, spend: true, refunded: 12, spent: 12 } });
  expect(refunded.billing).toEqual({ state: "refunded", amount: 12, unit: "higgsfield_credits", basis: "hf-ledger" });
  /* Grok on the account is charged the moment it starts: a spend with no refund is billed. */
  expect(accountBilling({ refund: false, spend: true, refunded: null, spent: 30 })).toEqual({ state: "billed", amount: 30, unit: "higgsfield_credits", basis: "hf-ledger" });
  expect(accountBilling({ refund: true, spend: false, refunded: null, spent: null })).toEqual({ state: "refunded", basis: "hf-ledger" });
  expect(accountBilling(null)).toEqual({ state: "unknown", basis: "hf-account-silent" });
  /* An old row with no outcome reads as unknown; a finished job that could not be kept stays its own kind. */
  expect(accountFailure(null, "provider_failed")).toMatchObject({ code: "provider_failed", kind: "unknown", billing: { state: "unknown" }, payer: "account" });
  expect(accountFailure(null, "invalid_result")).toMatchObject({ kind: "not_kept" });
});

test("BytePlus ModelArk: a failed or refused Seedance task is not charged (only successfully generated videos are)", () => {
  const moderated = arkTaskOutcome({ id: "cgt-2026", model: "dreamina-seedance-2-5-260628", status: "failed",
    error: { code: "OutputVideoSensitiveContentDetected", message: "The generated video may contain sensitive information." } })!;
  expect(moderated).toMatchObject({ provider: "byteplus", stage: "run", code: "OutputVideoSensitiveContentDetected", kind: "content_filter",
    message: "The generated video may contain sensitive information.", billing: { state: "not_charged", basis: "ark-success-only" } });
  expect(arkTaskOutcome({ status: "failed", error: { code: "InputImageSensitiveContentDetected.PolicyViolation", message: "Input image may relate to copyright restrictions." } }))
    .toMatchObject({ kind: "rights", billing: { state: "not_charged" } });
  expect(arkTaskOutcome({ status: "cancelled" })).toMatchObject({ code: "canceled", kind: "canceled", billing: { state: "not_charged" } });
  expect(arkTaskOutcome({ status: "succeeded", usage: { completion_tokens: 246_840 } })).toBeNull();
  const refused = arkRefusalOutcome(400, JSON.stringify({ error: { code: "InputTextSensitiveContentDetected", message: "The input text may contain sensitive information.", type: "BadRequest" } }));
  expect(refused).toMatchObject({ stage: "submit", code: "InputTextSensitiveContentDetected", kind: "content_filter", billing: { state: "not_charged" } });
  expect(arkRefusalOutcome(429, JSON.stringify({ error: { code: "RateLimitExceeded.EndpointRPMExceeded", message: "RPM limit exceeded." } }))).toMatchObject({ kind: "rate_limited", billing: { state: "not_charged" } });
  expect(arkRefusalOutcome(401, JSON.stringify({ error: { code: "AuthenticationError", message: "API key is missing or invalid." } }))).toMatchObject({ kind: "auth" });
  expect(arkRefusalOutcome(502, "<html>Bad gateway</html>")).toMatchObject({ code: "http_502", billing: { state: "unknown" } });
});

test("Google: only documented HTTP refusals establish no charge; usage tokens alone do not establish billing", () => {
  expect(googleErrorOutcome(400, { error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } }))
    .toMatchObject({ provider: "google", code: "INVALID_ARGUMENT", kind: "invalid_request", billing: { state: "not_charged", basis: "google-errors" } });
  expect(googleErrorOutcome(503, { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } })).toMatchObject({ billing: { state: "unknown" } });
  const declined = googleRefusalOutcome({ input_tokens: 1030, output_tokens: 260 }, "I can't create images of that person.");
  expect(declined).toMatchObject({ stage: "run", code: "no_image", message: "I can't create images of that person.", billing: { state: "unknown", basis: "silent" } });
  expect(googleRefusalOutcome({ total_tokens: 0 }, null)).toMatchObject({ billing: { state: "unknown" } });
  expect(googleRefusalOutcome(undefined, "No.")).toMatchObject({ billing: { state: "unknown", basis: "silent" } });
  expect(googleRefusalOutcome({ total_tokens: 900 }, "Blocked.", "IMAGE_SAFETY")).toMatchObject({ code: "IMAGE_SAFETY", kind: "content_filter" });
});

test("the AI Gateway: a reply's usage.cost is its charge in dollars; a refused request did not say", () => {
  expect(gatewayRefusalOutcome(0.039, "Cannot draw that.")).toMatchObject({ provider: "gateway", billing: { state: "billed", amount: 0.039, unit: "usd", basis: "gateway-cost" } });
  expect(gatewayRefusalOutcome(0, null)).toMatchObject({ billing: { state: "not_charged" } });
  expect(gatewayRefusalOutcome(undefined, null)).toMatchObject({ billing: { state: "unknown" } });
  expect(gatewayErrorOutcome(402, JSON.stringify({ error: { message: "Insufficient funds", type: "insufficient_funds" } }))).toMatchObject({ code: "insufficient_funds", kind: "provider_quota", billing: { state: "unknown" } });
});

test("OpenAI: a moderation block carries no usage and its docs state no rule, so it did not say", () => {
  const blocked = openaiErrorOutcome(400, JSON.stringify({ error: { message: "Your request was rejected as a result of our safety system.", type: "image_generation_user_error", param: null, code: "moderation_blocked" } }));
  expect(blocked).toMatchObject({ provider: "openai", code: "moderation_blocked", kind: "content_filter", billing: { state: "unknown", basis: "silent" } });
  expect(openaiErrorOutcome(429, { error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } })).toMatchObject({ kind: "provider_quota" });
});

test("xAI: usage.cost_in_usd_ticks is the amount billed (ten billion to the dollar), charged or zero; without it, it did not say", () => {
  expect(xaiVideoOutcome({ status: "failed", error: { code: "content_moderated", message: "The request was moderated." }, usage: { cost_in_usd_ticks: 0 } }))
    .toMatchObject({ provider: "xai", code: "content_moderated", kind: "content_filter", billing: { state: "not_charged", amount: 0, unit: "usd", basis: "xai-ticks" } });
  expect(xaiVideoOutcome({ status: "done", video: { url: "https://vidgen.x.ai/v.mp4", respect_moderation: false }, usage: { cost_in_usd_ticks: 500_000_000 } }))
    .toMatchObject({ code: "respect_moderation_false", kind: "content_filter", billing: { state: "billed", amount: 0.05, unit: "usd" } });
  expect(xaiVideoOutcome({ status: "expired" })).toMatchObject({ code: "expired", kind: "timeout", billing: { state: "unknown" } });
  expect(xaiVideoOutcome({ status: "done", video: { url: "https://vidgen.x.ai/v.mp4", respect_moderation: true } })).toBeNull();
  expect(xaiVideoOutcome({ status: "pending" })).toBeNull();
  expect(xaiErrorOutcome(400, JSON.stringify({ code: "Client specified an invalid argument", error: "Duration must be at most 15 seconds." })))
    .toMatchObject({ stage: "submit", kind: "invalid_request", message: "Duration must be at most 15 seconds.", billing: { state: "unknown" } });
});

test("fal: a server error is never charged (its FAQ); a 422 content refusal may be, so it did not say", () => {
  const refused = falErrorOutcome(422, { detail: [{ loc: ["body", "prompt"], msg: "The prompt was flagged by the content checker.", type: "content_policy_violation" }] }, "run");
  expect(refused).toMatchObject({ provider: "fal", stage: "run", code: "content_policy_violation", kind: "content_filter", message: "prompt: The prompt was flagged by the content checker.", billing: { state: "unknown" } });
  expect(falErrorOutcome(500, { detail: "Internal Server Error" })).toMatchObject({ kind: "provider_error", billing: { state: "not_charged", basis: "fal-5xx" } });
  expect(falErrorOutcome(422, { detail: [{ loc: ["body", "image_url"], msg: "Image too large.", type: "image_too_large" }] })).toMatchObject({ code: "image_too_large", kind: "invalid_request" });
});

test("ElevenLabs: a refusal's detail names the code; its docs state no rule for a refused request", () => {
  expect(elevenLabsErrorOutcome(401, { detail: { type: "authentication_error", code: "invalid_api_key", message: "Invalid API key", request_id: "r1" } }))
    .toMatchObject({ provider: "elevenlabs", code: "invalid_api_key", kind: "auth", billing: { state: "unknown" } });
  expect(elevenLabsErrorOutcome(402, { detail: { status: "quota_exceeded", message: "This request exceeds your quota." } })).toMatchObject({ code: "quota_exceeded", kind: "provider_quota" });
  expect(elevenLabsErrorOutcome(422, { detail: [{ loc: ["body", "text"], msg: "Text too long", type: "value_error" }] })).toMatchObject({ code: "http_422", kind: "invalid_request" });
});

test("no answer, or an answer silent on the charge, is unknown — and says which", () => {
  expect(noAnswerOutcome("byteplus", "submit")).toMatchObject({ code: "no_answer", kind: "no_answer", billing: { state: "unknown", basis: "no-answer" } });
  expect(silentOutcome("fal", "run", "no_output", "Finished without a video.")).toMatchObject({ code: "no_output", billing: { state: "unknown", basis: "silent" } });
});

test("a provider's words are kept bounded and never carry a secret, a link, a token or an address", () => {
  const leak = "Denied for Bearer sk-live_abcdefghijklmnop1234 at https://api.example.com/v1/x?sig=AbC123 by ops@example.com; key id:0123456789abcdef0123456789abcdef0123456789abcdef; token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig";
  const kept = providerText(leak)!;
  for (const secret of ["sk-live", "api.example.com", "ops@example.com", "0123456789abcdef0123456789abcdef", "eyJhbGci", "AbC123"]) expect(kept).not.toContain(secret);
  expect(kept).toContain("[link]");
  expect(kept).toContain("[email]");
  /* Ordinary words, a job id and a model id stay. */
  expect(providerText(`Job ${JOB} on dreamina-seedance-2-5-260628 and hf_mult_motion_control: key reference missing`)).toBe(`Job ${JOB} on dreamina-seedance-2-5-260628 and hf_mult_motion_control: key reference missing`);
  const long = providerText("word ".repeat(200))!;
  expect(long.length).toBeLessThanOrEqual(280);
  expect(long.endsWith("…")).toBe(true);
  expect(providerText("\u0000\u0007  ")).toBeNull();
  expect(providerText(42)).toBeNull();
});

test("diagnostic codes cannot expose a credential disguised as a machine code", () => {
  expect(outcomeCode("sk-unitfixture1234567890secret")).toBeNull();
  expect(outcomeCode("xai-unitfixture1234567890secret")).toBeNull();
  expect(outcomeCode("token:unitfixture1234567890secret")).toBeNull();
  expect(outcomeCode("InputImageSensitiveContentDetected.PolicyViolation")).toBe("InputImageSensitiveContentDetected.PolicyViolation");
  expect(openaiErrorOutcome(400, { error: { code: "sk-unitfixture1234567890secret" } }).code).toBe("http_400");
});

test("an outcome survives storage exactly; anything unreadable reads as nothing (the take says 'didn't say')", () => {
  const outcome: ProviderOutcome = { ...higgsfieldAccountOutcome("nsfw", { ledger: { refund: true, spend: true, refunded: 12, spent: 12 }, at: 5 }) };
  expect(parseOutcome(serializeOutcome(outcome))).toEqual(outcome);
  const funded = { ...arkTaskOutcome({ status: "failed", error: { code: "X" } })!, funding: "platform" as const };
  expect(parseOutcome(serializeOutcome(funded))).toMatchObject({ funding: "platform" });
  for (const bad of [null, "", "{", JSON.stringify({ ...outcome, v: 2 }), JSON.stringify({ ...outcome, billing: { state: "maybe", basis: "silent" } }),
    JSON.stringify({ ...outcome, billing: { state: "refunded", basis: "made-up" } }), JSON.stringify({ ...outcome, provider: "someone" }), "x".repeat(5000)])
    expect(parseOutcome(bad)).toBeNull();
});

test("who may see the provider's charge: never on the platform's key for a credit workspace, never a dollar there at all", () => {
  const xai = { ...xaiVideoOutcome({ status: "failed", error: { code: "x" }, usage: { cost_in_usd_ticks: 400_000_000 } })!, funding: "platform" as const };
  /* Platform's key, credit workspace: the provider's side stays on the platform desk. */
  expect(takeFailure(xai, { credits: true })).toMatchObject({ billing: null, payer: "platform", code: "x" });
  /* The workspace's own key, in a credit workspace: the state, never the dollars. */
  expect(takeFailure({ ...xai, funding: "own" }, { credits: true }).billing).toEqual({ state: "billed", basis: "xai-ticks" });
  const google = { ...googleRefusalOutcome({ total_tokens: 1290 }, null), funding: "own" as const };
  expect(takeFailure(google, { credits: true }).billing).toMatchObject({ state: "unknown" });
  /* A workspace that pays its vendors: its own money, in the vendor's unit. */
  expect(takeFailure({ ...xai, funding: "own" }, { credits: false }).billing).toEqual({ state: "billed", amount: 0.04, unit: "usd", basis: "xai-ticks" });
  /* No outcome recorded (an older row): unknown where the viewer may see it, nothing where they may not. */
  expect(takeFailure(null, { credits: false })).toMatchObject({ code: "unknown", billing: { state: "unknown" } });
  expect(takeFailure(null, { credits: true }).billing).toBeNull();
  /* The browser's parser keeps only what it recognises. */
  const sent = { ...takeFailure(xai, { credits: true }), charge: { credits: 0, settled: true } };
  expect(parseTakeFailure(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
  expect(parseTakeFailure({ code: "x", kind: "nonsense" })).toBeNull();
});

test("one line per failure: what happened · what the provider did with the charge · the next step", () => {
  const account = (state: "refunded" | "billed" | "unknown", amount?: number): TakeFailure => accountFailure(
    higgsfieldAccountOutcome("nsfw", { ledger: state === "unknown" ? null : { refund: state === "refunded", spend: true, refunded: amount ?? null, spent: amount ?? null } }), "provider_failed");
  expect(failureLine(account("refunded", 12)).text).toBe("Refused by the content filter · Higgsfield refunded 12 credits · Change the prompt or reference");
  expect(failureLine(account("unknown")).text).toBe("Refused by the content filter · Higgsfield didn't say if it charged · Change the prompt or reference");
  expect(failureLine(account("billed", 30)).text).toBe("Refused by the content filter · Higgsfield charged 30 credits · Change the prompt or reference");
  const ark = takeFailure({ ...arkTaskOutcome({ status: "failed", error: { code: "OutputVideoSensitiveContentDetected" } })!, funding: "own" }, { credits: false });
  expect(failureLine(ark).text).toBe("Refused by the content filter · BytePlus didn't charge · Change the prompt or reference");
  /* Particl's own ledger, for a credit workspace: "Not billed" only at zero, settled. */
  const platform = { ...takeFailure({ ...arkTaskOutcome({ status: "failed", error: { code: "X" } })!, funding: "platform" }, { credits: true }) };
  expect(failureLine({ ...platform, charge: { credits: 0, settled: true } }).charge).toBe("Not billed");
  expect(failureLine({ ...platform, charge: { credits: 12, settled: true } }).charge).toBe("12 cr charged");
  expect(failureLine({ ...platform, charge: { credits: 12, settled: false } }).charge).toBe("12 cr held");
  expect(failureLine(platform).charge).toBeNull();
  /* The chip says only what is confirmed. */
  expect([failedChip(account("refunded", 12)), failedChip(account("billed", 30)), failedChip(account("unknown")), failedChip(ark), failedChip(null)])
    .toEqual(["Failed · refunded", "Failed · charged", "Failed", "Failed · not charged", "Failed"]);
  expect(failedChip({ ...platform, charge: { credits: 0, settled: true } }, true)).toBe("Cancelled · not billed");
  expect([failureUncharged(account("refunded", 12)), failureUncharged(account("unknown")), failureUncharged({ ...platform, charge: { credits: 0, settled: false } })]).toEqual([true, false, false]);
  expect([failureChargeWord(account("refunded")), failureChargeWord(account("unknown")), failureChargeWord({ ...platform, charge: { credits: 3, settled: true } })]).toEqual(["refunded", null, "3 cr"]);
  /* The next step fits whose key it was. */
  expect(failureCopy("auth", "platform").next).toBe("Try again later");
  expect(failureCopy("auth", "own").next).toBe("Reconnect in Workspace › Engines");
  expect(failureCopy("provider_quota", "account")).toEqual({ what: "The Higgsfield account is out of credits", next: "Top up the Higgsfield account" });
  expect(billingSentence({ state: "billed", amount: 0.0035, unit: "usd", basis: "xai-ticks" }, "xai")).toBe("xAI charged $0.0035");
  expect(billingSentence({ state: "unknown", basis: "silent" }, null)).toBe("The provider didn't say if it charged");
  /* A provider's own words ride along when they say more. */
  expect(failureLine(takeFailure({ ...higgsfieldRefusalOutcome(422, JSON.stringify({ detail: [{ loc: ["body", "prompt"], msg: "field required", type: "missing" }] })), funding: "own" }, { credits: false })).detail).toBe("prompt: field required");
});

test("a thrown adapter error becomes its provider's outcome; one that never left this server is none", async () => {
  const { outcomeOfError } = await import("../../lib/providerFailure");
  const { ArkHttpError } = await import("../../lib/ark");
  const { FalHttpError } = await import("../../lib/fal");
  const { XaiHttpError } = await import("../../lib/xaiErrors");
  const { ElevenLabsError } = await import("../../lib/elevenlabs");
  const { HiggsfieldHttpError } = await import("../../lib/higgsfield");
  const { PreflightError } = await import("../../lib/preflight");
  const { StillRefusalError, GoogleDoorError } = await import("../../lib/gemini");
  const { APICallError } = await import("ai");
  const ark = new ArkHttpError(400, "Ark submit failed (400): …", JSON.stringify({ error: { code: "InputTextSensitiveContentDetected", message: "Sensitive." } }));
  expect(outcomeOfError(ark, { provider: "byteplus" })).toMatchObject({ provider: "byteplus", code: "InputTextSensitiveContentDetected", billing: { state: "not_charged" } });
  expect(outcomeOfError(new FalHttpError(500, "The render service returned 500.", { detail: "boom" }), { provider: "fal" })).toMatchObject({ billing: { state: "not_charged" } });
  expect(outcomeOfError(new XaiHttpError(400, "refused", JSON.stringify({ error: "Too long" })), { provider: "xai" })).toMatchObject({ provider: "xai", message: "Too long" });
  expect(outcomeOfError(new ElevenLabsError(401, "rejected", { detail: { code: "invalid_api_key", message: "Invalid API key" } }), { provider: "elevenlabs" })).toMatchObject({ code: "invalid_api_key" });
  expect(outcomeOfError(new HiggsfieldHttpError(422, "returned 422", JSON.stringify({ detail: "Bad aspect ratio" })), { provider: "higgsfield" })).toMatchObject({ message: "Bad aspect ratio", billing: { state: "not_charged" } });
  expect(outcomeOfError(new StillRefusalError("declined", googleRefusalOutcome({ total_tokens: 12 }, null)), { provider: "google" })).toMatchObject({ billing: { state: "unknown" } });
  expect(outcomeOfError(new GoogleDoorError("Image engine request failed (400): bad", 400, { error: { status: "INVALID_ARGUMENT" } }), { provider: "google" })).toMatchObject({ billing: { state: "not_charged" } });
  /* The Google door shut before anything was sent (no key): no provider outcome. */
  expect(outcomeOfError(new GoogleDoorError("not connected", null), { provider: "google" })).toBeNull();
  const openai = new APICallError({ message: "Bad Request", url: "https://api.openai.com/v1/images/generations", requestBodyValues: {}, statusCode: 400,
    responseBody: JSON.stringify({ error: { message: "Your request was rejected as a result of our safety system.", code: "moderation_blocked" } }) });
  expect(outcomeOfError(openai, { provider: "openai" })).toMatchObject({ code: "moderation_blocked", billing: { state: "unknown" } });
  expect(outcomeOfError(new PreflightError("A reference is gone."), { provider: "byteplus" })).toBeNull();
  expect(outcomeOfError(new Error("The video engine did not answer within 120s."), { provider: "byteplus" })).toMatchObject({ code: "no_answer", billing: { state: "unknown", basis: "no-answer" } });
  expect(outcomeOfError(new Error("Workspace storage is full."), { provider: "byteplus" })).toBeNull();
});

test("provider diagnostics preserve reserved credits and immutable receipt terms", async () => {
  const { randomUUID } = await import("node:crypto");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { meter } = await import("../../lib/meter");
  const { fundingOf } = await import("../../lib/providerFailure");
  const workspaceId = randomUUID(), jobId = randomUUID();
  const ws = { id: workspaceId, legacy: false, usesPlatformKeys: true, keys: {}, dbUrl: `file:${path.join(dir, `${workspaceId}.db`)}` } as import("../../lib/tenant").TenantWorkspace;
  await platformReady();
  await platformDb().execute({ sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at,credit_usd,credit_margin) VALUES(?,?,'image','google','fixture','running',1,19,1,1,1,0.25,2)", args: [jobId, workspaceId] });
  await runInTenant(ws, async () => {
    await meter({ id: jobId, kind: "image", engine: "google", model: "fixture", status: "failed", engineCostUsd: null,
      providerOutcome: { ...googleRefusalOutcome({ total_tokens: 1234 }, "No image."), funding: "platform" } }, { critical: true });
    const row = (await platformDb().execute({ sql: "SELECT billed_credits,credit_usd,credit_margin,provider_outcome FROM meter_events WHERE id=? AND workspace_id=?", args: [jobId, workspaceId] })).rows[0];
    expect(row).toMatchObject({ billed_credits: 19, credit_usd: 0.25, credit_margin: 2 });
    expect(parseOutcome(row.provider_outcome)).toMatchObject({ billing: { state: "unknown" }, funding: "platform" });
    expect(await fundingOf(jobId)).toBe("platform");
    expect(await fundingOf(randomUUID())).toBe("platform");
  });
});


test("an unreadable recorded outcome cannot fall back to private provider diagnostics", async () => {
  const { rowToGeneration } = await import("../../lib/jobs");
  const failed = rowToGeneration({ id: "invalid-outcome", status: "failed", params: "{}", provider_outcome: "{invalid",
    error: "Private account details token=sk-unitfixture1234567890secret" });
  expect(failed.error).toBe("Did not render");
  expect(failed.failure).toMatchObject({ kind: "unknown", message: null });
});
