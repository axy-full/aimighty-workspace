import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const directory = mkdtempSync(path.join(tmpdir(), "particl-hf-transport-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.HF_CREDENTIALS = "fixture-id:fixture-secret";
process.env.ENGINE_MOCK = "0";
const referenceId = "31a51537-0563-4bcf-bc5a-f99f2979759f";
const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.ENGINE_MOCK = "0";
});

test("Soul create uses the official flat custom-reference contract and fixed dev host, never generation credentials headers", async () => {
  const { createSoulReference } = await import("../../lib/higgsfield");
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    expect(String(url)).toBe(
      "https://dev-api.higgsfield.com/v1/custom-references",
    );
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("hf-api-key")).toBe("fixture-id");
    expect(new Headers(init?.headers).get("hf-secret")).toBe("fixture-secret");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Character",
      input_images: [
        { type: "image_url", image_url: "https://fixture.invalid/signed" },
      ],
    });
    return Response.json({
      id: referenceId,
      name: "Character",
      status: "not_ready",
      thumbnail_url: null,
    });
  };
  expect(
    await createSoulReference("Character", ["https://fixture.invalid/signed"]),
  ).toEqual({ id: referenceId, status: "not_ready" });
  expect(calls).toBe(1);
});

test("transport timeout, 5xx and malformed successful POST never retry or become definitive rejection", async () => {
  const { createSoulReference, higgsfieldSubmissionRejected } =
    await import("../../lib/higgsfield");
  for (const response of [
    () => {
      throw new Error("lost response");
    },
    () => new Response("failure", { status: 503 }),
    () => Response.json({ status: "queued" }),
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response();
    };
    let failure: unknown;
    try {
      await createSoulReference("Character", [
        "https://fixture.invalid/signed",
      ]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeTruthy();
    expect(higgsfieldSubmissionRejected(failure)).toBe(false);
    expect(calls).toBe(1);
  }
});

test("definitive rejection is based on status, never vendor prose; wrong GET handle is refused", async () => {
  const {
    createSoulReference,
    getSoulReference,
    higgsfieldSubmissionRejected,
  } = await import("../../lib/higgsfield");
  globalThis.fetch = async () =>
    new Response("secret fixture account details must not escape", {
      status: 422,
    });
  try {
    await createSoulReference("Character", ["https://fixture.invalid/signed"]);
    throw new Error("must reject");
  } catch (error) {
    expect(higgsfieldSubmissionRejected(error)).toBe(true);
    expect(String(error)).not.toContain("secret fixture");
  }
  globalThis.fetch = async () =>
    Response.json({
      id: "41a51537-0563-4bcf-bc5a-f99f2979759f",
      status: "completed",
    });
  await expect(getSoulReference(referenceId)).rejects.toThrow(/different/);
});

test("mock mode has a stable account fingerprint and makes no network calls", async () => {
  const {
    createSoulReference,
    getSoulReference,
    higgsfieldCredentialFingerprint,
  } = await import("../../lib/higgsfield");
  process.env.ENGINE_MOCK = "1";
  globalThis.fetch = async () => {
    throw new Error("mock must not fetch");
  };
  const fingerprint = higgsfieldCredentialFingerprint();
  const submitted = await createSoulReference("Character", [
    "https://fixture.invalid/signed",
  ]);
  expect((await getSoulReference(submitted.id)).status).toBe("completed");
  expect(higgsfieldCredentialFingerprint()).toBe(fingerprint);
});

test("a valid acknowledged UUID survives missing or newer status instead of becoming another training attempt", async () => {
  const { createSoulReference } = await import("../../lib/higgsfield");
  for (const status of [undefined, "new_provider_phase"]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({ id: referenceId, status });
    };
    expect(
      await createSoulReference("Character", [
        "https://fixture.invalid/signed",
      ]),
    ).toEqual({ id: referenceId, status: "not_ready" });
    expect(calls).toBe(1);
  }
});
