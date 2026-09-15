import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the actual HTTP adapter rather than replacing falStatus/falResult.
// A mock request ID would skip these URLs and conceal provider routing errors.
function client(transport: typeof fetch) {
  const dependencies: Record<string, unknown> = {
    "./recovery": { recoveryFetch: transport },
    "./providers": {
      getProvider: () => ({}),
      providerBaseUrl: () => "https://queue.fal.run",
    },
    "./vendorKeys": { vendorKey: () => "isolated-fal-test-key" },
    "./mock": { engineMock: () => false, isMockJob: () => false },
  };
  const code = ts.transpileModule(readFileSync("lib/fal.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const result = { exports: {} };
  new Function("require", "module", "exports", code)(
    (id: string) => {
      if (!(id in dependencies)) throw Error(`Unstubbed fal dependency: ${id}`);
      return dependencies[id];
    },
    result,
    result.exports,
  );
  return result.exports as typeof import("../../lib/fal");
}

for (const [endpoint, app] of [
  ["fal-ai/topaz/upscale/image", "fal-ai/topaz"],
  ["topaz/upscale/video/creative", "topaz/upscale"],
  ["fal-ai/kling-video/v3/pro/image-to-video", "fal-ai/kling-video"],
  ["fal-ai/bria/background/remove", "fal-ai/bria"],
  [
    "fal-ai/luma-dream-machine/ray-2-flash/reframe",
    "fal-ai/luma-dream-machine",
  ],
  ["fal-ai/flux-lora", "fal-ai/flux-lora"],
  ["workflows/studio/finishing/custom", "workflows/studio/finishing"],
  ["comfy/studio/finishing/custom", "comfy/studio/finishing"],
]) {
  test(`fal keeps the full submission endpoint and collects ${endpoint} at the app queue`, async () => {
    const calls: { url: string; method: string }[] = [];
    const fal = client(async (input, options) => {
      const url = String(input),
        method = options?.method ?? "GET";
      calls.push({ url, method });
      expect(options?.headers).toMatchObject({
        Authorization: "Key isolated-fal-test-key",
      });
      if (method === "POST") {
        expect(url).toBe(`https://queue.fal.run/${endpoint}`);
        return Response.json({ request_id: "existing-request" });
      }
      if (
        url === `https://queue.fal.run/${app}/requests/existing-request/status`
      ) {
        return Response.json({ status: "COMPLETED" });
      }
      if (url === `https://queue.fal.run/${app}/requests/existing-request`) {
        return Response.json({
          image: { url: "https://output.invalid/image.png" },
        });
      }
      return new Response(null, { status: 405 });
    });
    const receipt = await fal.falSubmit(endpoint, { image_url: "synthetic" });
    const output = await fal.falAwait(endpoint, receipt.request_id);
    expect(output).toEqual({
      image: { url: "https://output.invalid/image.png" },
    });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
  });
}

test("fal resumes an already accepted request after a failed status read without submitting again", async () => {
  const calls: { url: string; method: string }[] = [];
  let fail = true;
  const fal = client(async (input, options) => {
    const url = String(input),
      method = options?.method ?? "GET";
    calls.push({ url, method });
    expect(method).toBe("GET");
    if (fail) {
      fail = false;
      return new Response(null, { status: 503 });
    }
    if (url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
    return Response.json({
      image: { url: "https://output.invalid/existing.png" },
    });
  });
  await expect(
    fal.falAwait("fal-ai/topaz/upscale/image", "already-paid"),
  ).rejects.toThrow("503");
  await expect(
    fal.falAwait("fal-ai/topaz/upscale/image", "already-paid"),
  ).resolves.toHaveProperty("image.url");
  expect(calls).toHaveLength(3);
  expect(
    calls.every((c) => c.url.includes("/fal-ai/topaz/requests/already-paid")),
  ).toBe(true);
});

test("fal status logs and request IDs cannot alter queue routing", async () => {
  const calls: string[] = [];
  const fal = client(async (input) => {
    calls.push(String(input));
    return Response.json({ status: "IN_QUEUE" });
  });
  await fal.falStatus("fal-ai/topaz/upscale/image", "id/with?characters", true);
  expect(calls).toEqual([
    "https://queue.fal.run/fal-ai/topaz/requests/id%2Fwith%3Fcharacters/status?logs=1",
  ]);
  for (const endpoint of [
    "fal-ai",
    "workflows/studio",
    "fal-ai//topaz",
    "../topaz",
    "fal-ai/topaz/..",
    "fal-ai/topaz?other",
    "https://other.invalid/model",
  ]) {
    await expect(fal.falStatus(endpoint, "existing")).rejects.toThrow(
      "Invalid fal queue",
    );
    await expect(fal.falResult(endpoint, "existing")).rejects.toThrow(
      "Invalid fal queue",
    );
  }
  expect(calls).toHaveLength(1);
});
