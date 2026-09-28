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

test("Soul create sends the documented production custom-reference contract with its render family and key header", async () => {
  const { createSoulReference } = await import("../../lib/higgsfield");
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    expect(String(url)).toBe(
      "https://api.higgsfield.ai/v1/custom-references",
    );
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Key fixture-id:fixture-secret",
    );
    expect(new Headers(init?.headers).has("hf-api-key")).toBe(false);
    expect(new Headers(init?.headers).has("hf-secret")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Character",
      model_version: "v1",
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
  await expect(getSoulReference(referenceId, "api-v1")).rejects.toThrow(
    /different/,
  );
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
  expect((await getSoulReference(submitted.id, "api-v1")).status).toBe(
    "completed",
  );
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

test("status reads and deletes go only to the host that accepted the reference, with that host's headers", async () => {
  const { getSoulReference, deleteSoulReference } = await import(
    "../../lib/higgsfield"
  );
  const calls: { url: string; method: string; headers: Headers }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    });
    expect(init?.redirect).toBe("error");
    return init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ id: referenceId, status: "in_progress" });
  };
  expect(await getSoulReference(referenceId, "api-v1")).toEqual({
    id: referenceId,
    status: "in_progress",
  });
  expect(await getSoulReference(referenceId, "dev-v1")).toEqual({
    id: referenceId,
    status: "in_progress",
  });
  await deleteSoulReference(referenceId, "api-v1");
  await deleteSoulReference(referenceId, "dev-v1");
  expect(calls.map(({ url, method }) => `${method} ${url}`)).toEqual([
    `GET https://api.higgsfield.ai/v1/custom-references/${referenceId}`,
    `GET https://dev-api.higgsfield.com/v1/custom-references/${referenceId}`,
    `DELETE https://api.higgsfield.ai/v1/custom-references/${referenceId}`,
    `DELETE https://dev-api.higgsfield.com/v1/custom-references/${referenceId}`,
  ]);
  for (const [index, call] of calls.entries()) {
    const production = index % 2 === 0;
    expect(call.headers.get("Authorization")).toBe(
      production ? "Key fixture-id:fixture-secret" : null,
    );
    expect(call.headers.get("hf-api-key")).toBe(
      production ? null : "fixture-id",
    );
    expect(call.headers.get("hf-secret")).toBe(
      production ? null : "fixture-secret",
    );
  }
});

test("an unrecognized stored host marker is refused before any request", async () => {
  const { getSoulReference, deleteSoulReference, soulReferenceOrigin } =
    await import("../../lib/higgsfield");
  globalThis.fetch = async () => {
    throw new Error("must not fetch");
  };
  expect(soulReferenceOrigin(null)).toBe("dev-v1");
  expect(soulReferenceOrigin(undefined)).toBe("dev-v1");
  expect(soulReferenceOrigin("api-v1")).toBe("api-v1");
  for (const marker of ["https://attacker.invalid", "toString", "API-V1", ""])
    expect(() => soulReferenceOrigin(marker)).toThrow(/not recognized/);
  await expect(
    getSoulReference(referenceId, "https://attacker.invalid" as never),
  ).rejects.toThrow(/not recognized/);
  await expect(
    deleteSoulReference(referenceId, "__proto__" as never),
  ).rejects.toThrow(/not recognized/);
});

test("a refused status read is an unknown outcome; transient failures stay retryable", async () => {
  const { getSoulReference, higgsfieldReferenceUnreachable } = await import(
    "../../lib/higgsfield"
  );
  for (const [status, unreachable] of [
    [401, true],
    [403, true],
    [404, true],
    [410, true],
    [429, false],
    [500, false],
    [503, false],
  ] as const) {
    globalThis.fetch = async () =>
      new Response("provider detail must not escape", { status });
    let failure: unknown;
    try {
      await getSoulReference(referenceId, "dev-v1");
    } catch (error) {
      failure = error;
    }
    expect(higgsfieldReferenceUnreachable(failure)).toBe(unreachable);
    expect(String(failure)).not.toContain("provider detail");
  }
  expect(higgsfieldReferenceUnreachable(new Error("network"))).toBe(false);
});
