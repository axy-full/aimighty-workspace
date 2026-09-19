import { test, expect } from "@playwright/test";
import { readFileSync as readToolsFixture } from "node:fs";
import { resetConnectedToolsetCache } from "../../lib/higgsfield-consumer/toolset";

const connectedTools98 = JSON.parse(readToolsFixture("tests/fixtures/connected-tools-98.json", "utf8")) as { tools: { name: string; inputSchema: Record<string, unknown> }[] };
test.beforeEach(() => resetConnectedToolsetCache());
import { randomUUID } from "node:crypto";
import {
  getConsumerGenjutsuQuote,
  submitConsumerGenjutsu,
  readConsumerGenjutsuJob,
  CONSUMER_MCP_URL,
} from "../../lib/higgsfield-consumer/mcp";
import {
  consumerGenjutsuParams,
  consumerGenjutsuInputSchema,
  consumerGenjutsuOriginalResult,
  consumerGenjutsuFailureResult,
  type ConsumerGenjutsuInput,
} from "../../lib/higgsfield-consumer/genjutsu-contract";
const wallet = randomUUID(),
  other = randomUUID(),
  jobId = randomUUID(),
  media = randomUUID();
const input: ConsumerGenjutsuInput = {
  variant: "motion-transfer",
  resolution: "1080p",
  prompt: "",
  source: { uploadId: "source" },
  references: [{ genId: "still" }],
};
const params = consumerGenjutsuParams(input, [
  { value: media, role: "video" },
  { value: other, role: "image" },
]);
type Packet = {
  id: string;
  method: string;
  params: { name: string; arguments: Record<string, unknown> };
};
function fixture(change?: (p: Packet, calls: Packet[]) => unknown) {
  const calls: Packet[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(CONSUMER_MCP_URL);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer fixture-private-access",
    );
    const p = JSON.parse(String(init?.body)) as Packet;
    calls.push(p);
    if (p.method === "initialize")
      return Response.json({
        jsonrpc: "2.0",
        id: p.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        },
      });
    if (p.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    if (p.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: p.id, result: { tools: connectedTools98.tools } });
    const changed = change?.(p, calls);
    if (changed instanceof Error) throw changed;
    const value =
      changed ??
      (p.params.name === "list_workspaces"
        ? { workspaces: [{ id: wallet, is_selected: true, credits: 500 }] }
        : p.params.name === "media_import_url"
          ? { media_id: media }
          : p.params.name === "job_status"
            ? { job_id: jobId, status: "in_progress", poll_after_seconds: 20 }
            : (p.params.arguments.params as Record<string, unknown>)
                  .get_cost === true
              ? { cost: { credits: 75, credits_exact: 75 } }
              : {
                  results: [{ id: jobId, model: params.model, type: "video" }],
                });
    return Response.json({
      jsonrpc: "2.0",
      id: p.id,
      result: { structuredContent: value },
    });
  };
  return {
    calls,
    fetch: fetcher,
    paid: () =>
      calls.filter(
        (p) =>
          p.params?.name === "generate_video" &&
          (p.params.arguments.params as Record<string, unknown>).get_cost ===
            false,
      ),
  };
}
test("consumer Genjutsu validates website bounds and original identities without accepting URLs or developer limits", () => {
  expect(consumerGenjutsuInputSchema.safeParse(input).success).toBe(true);
  expect(
    consumerGenjutsuInputSchema.safeParse({
      ...input,
      references: Array.from({ length: 30 }, (_, i) => ({
        uploadId: `image${i}`,
      })),
    }).success,
  ).toBe(true);
  for (const patch of [
    { resolution: "4k" },
    {
      references: Array.from({ length: 31 }, (_, i) => ({
        uploadId: `image${i}`,
      })),
    },
    { source: { url: "https://x/video" } },
    { source: { uploadId: "a", genId: "b" } },
    { references: [{ uploadId: "source" }] },
  ])
    expect(
      consumerGenjutsuInputSchema.safeParse({ ...input, ...patch }).success,
    ).toBe(false);
});
test("quote imports exact originals as typed UUID media, costs only, with no paid generation", async () => {
  const f = fixture();
  const imported: number[] = [];
  const quote = await getConsumerGenjutsuQuote(
    "fixture-private-access",
    input,
    [
      {
        url: "https://private.example/source.mp4?token=private",
        type: "video",
      },
      { url: "https://private.example/image.png", type: "image" },
    ],
    {
      fetch: f.fetch,
      resolveMedia: async (i, w, perform) => {
        expect(w).toBe(wallet);
        imported.push(i);
        return perform();
      },
    },
  );
  expect(imported).toEqual([0, 1]);
  expect(quote.credits).toBe(75);
  expect(quote.params.medias).toEqual([
    { value: media, role: "video" },
    { value: media, role: "image" },
  ]);
  expect(
    f.calls
      .filter((p) => p.params?.name === "media_import_url")
      .map((p) => p.params.arguments.type),
  ).toEqual(["video", "image"]);
  expect(f.paid()).toHaveLength(0);
  const sent = f.calls.find((p) => p.params?.name === "generate_video")!.params
    .arguments.params;
  expect(sent).toMatchObject({
    model: "hf_mult_motion_control",
    resolution: "1080p",
    count: 1,
    use_unlim: false,
    get_cost: true,
  });
  expect(sent).not.toHaveProperty("duration");
  expect(JSON.stringify(quote)).not.toContain("private.example");
});
test("media import unknown acknowledgement fails closed without trying generation or parsing prose", async () => {
  const f = fixture((p) =>
    p.params.name === "media_import_url"
      ? { message: `Imported ${media}`, id: media }
      : undefined,
  );
  await expect(
    getConsumerGenjutsuQuote(
      "fixture-private-access",
      input,
      [
        { url: "https://private.example/v", type: "video" },
        { url: "https://private.example/i", type: "image" },
      ],
      { fetch: f.fetch, resolveMedia: async (_i, _w, fn) => fn() },
    ),
  ).rejects.toMatchObject({ code: "provider_error" });
  expect(
    f.calls.filter((p) => p.params?.name === "generate_video"),
  ).toHaveLength(0);
});
test("single paid call follows fresh identical quote and durable admission, regardless of stored key ordering", async () => {
  const f = fixture();
  let admitted = false;
  const stored = Object.fromEntries(
    Object.entries(params).sort(),
  ) as typeof params;
  const result = await submitConsumerGenjutsu(
    "fixture-private-access",
    input,
    stored,
    wallet,
    75,
    {
      fetch: f.fetch,
      admit: async () => {
        expect(f.paid()).toHaveLength(0);
        admitted = true;
      },
    },
  );
  expect(admitted).toBe(true);
  expect(result).toMatchObject({ state: "accepted", providerJobId: jobId });
  expect(f.paid()).toHaveLength(1);
  expect(f.paid()[0].params.arguments.params).toEqual({
    ...params,
    get_cost: false,
  });
});
test("wallet/price/adjustment drift and refused durable claim stop before paid POST", async () => {
  for (const mode of ["wallet", "price", "adjustment", "claim"]) {
    const f = fixture((p) =>
      mode === "wallet" && p.params.name === "list_workspaces"
        ? { workspaces: [{ id: other, is_selected: true, credits: 500 }] }
        : p.params.name === "generate_video" && mode === "price"
          ? { cost: { credits: 76, credits_exact: 76 } }
          : p.params.name === "generate_video" && mode === "adjustment"
            ? {
                cost: { credits: 75, credits_exact: 75 },
                adjustments: {
                  "params.resolution": { requested: "1080p", used: "720p" },
                },
              }
            : undefined,
    );
    await expect(
      submitConsumerGenjutsu(
        "fixture-private-access",
        input,
        params,
        wallet,
        75,
        {
          fetch: f.fetch,
          admit: async () => {
            if (mode === "claim") throw Error("claimed by another request");
          },
        },
      ),
    ).rejects.toThrow();
    expect(f.paid()).toHaveLength(0);
  }
});
test("lost paid response is uncertain once, and polling uses exact UUID without a resubmit", async () => {
  const f = fixture((p) =>
    p.params.name === "generate_video" &&
    (p.params.arguments.params as Record<string, unknown>).get_cost === false
      ? Error("private secret response")
      : undefined,
  );
  expect(
    await submitConsumerGenjutsu(
      "fixture-private-access",
      input,
      params,
      wallet,
      75,
      { fetch: f.fetch, admit: async () => {} },
    ),
  ).toMatchObject({ state: "uncertain" });
  expect(f.paid()).toHaveLength(1);
  const read = fixture();
  await readConsumerGenjutsuJob(
    "fixture-private-access",
    jobId,
    wallet,
    params.model,
    { fetch: read.fetch },
  );
  expect(
    read.calls.find((p) => p.params?.name === "job_status")?.params.arguments,
  ).toEqual({ jobId, sync: false, raw_data: false });
  expect(read.paid()).toHaveLength(0);
});
test("collection requires exact model/source settings and original HTTPS result, with unknown schema retained", () => {
  const accepted = {
    id: jobId,
    status: "completed",
    model: params.model,
    type: "video",
    results: { rawUrl: "https://media.example/original.mp4" },
    params: {
      ...params,
      medias: params.medias.map((m) => ({
        role: m.role,
        data: { id: m.value, type: m.role, url: "https://media.example/input" },
      })),
    },
  };
  const raw = { generation: accepted };
  expect(consumerGenjutsuOriginalResult(raw, jobId, params)).toEqual({
    url: "https://media.example/original.mp4",
  });
  for (const patch of [
    { id: other },
    { model: "marketing_studio_video" },
    { type: "image" },
    { status: "pending" },
    { results: { thumbnailUrl: "https://media.example/t.png" } },
    {
      params: {
        ...accepted.params,
        medias: [{ role: "video", data: { id: other, type: "video" } }],
      },
    },
    { params: { ...accepted.params, resolution: "480p" } },
  ])
    expect(
      consumerGenjutsuOriginalResult(
        { generation: { ...accepted, ...patch } },
        jobId,
        params,
      ),
    ).toBeNull();
  expect(
    consumerGenjutsuOriginalResult({ raw_data: accepted }, jobId, params),
  ).toBeNull();
  for (const status of ["failed", "canceled", "nsfw", "ip_detected"])
    expect(
      consumerGenjutsuFailureResult(
        { generation: { ...accepted, status, results: null } },
        jobId,
        params,
      ),
    ).toBe(status);
  expect(
    consumerGenjutsuFailureResult(
      { generation: { ...accepted, status: "cancelled", results: null } },
      jobId,
      params,
    ),
  ).toBeNull();
  expect(
    consumerGenjutsuFailureResult(
      {
        generation: { ...accepted, id: other, status: "failed", results: null },
      },
      jobId,
      params,
    ),
  ).toBeNull();
});

test("normalized status refuses conflicting generation identity before returning diagnostics", async () => {
  for (const patch of [
    { id: other },
    { model: "marketing_studio_video" },
    { type: "image" },
  ]) {
    const f = fixture((p) =>
      p.params.name === "job_status"
        ? {
            generation: {
              id: jobId,
              model: params.model,
              type: "video",
              status: "in_progress",
              ...patch,
            },
          }
        : undefined,
    );
    await expect(
      readConsumerGenjutsuJob(
        "fixture-private-access",
        jobId,
        wallet,
        params.model,
        { fetch: f.fetch },
      ),
    ).rejects.toMatchObject({ code: "invalid_job" });
    expect(f.paid()).toHaveLength(0);
  }
});
