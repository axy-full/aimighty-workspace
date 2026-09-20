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
  parseConnectedCatalogue,
  findCatalogueModel,
  mediaKindForRole,
  validateGenerationRequest,
} from "../../lib/higgsfield-consumer/catalogue";
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
  { value: media, role: "video_references" },
  { value: other, role: "image_references" },
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
  // The roles we SEND are the model's declared slots (image_references /
  // video_references), the only roles validateGenerationRequest admits.
  expect(quote.params.medias).toEqual([
    { value: media, role: "video_references" },
    { value: media, role: "image_references" },
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
test("the roles the transform path SENDS are the model's declared slots, so they pass the catalogue validator", () => {
  // The catalogue rejects any role that is not a declared slot name, and the
  // transform submit path does not run through it — so the roles it sends had
  // never been checked against a declaration. `hf_mult_motion_control` and
  // `hf_mult_replace_object` each declare exactly image_references and
  // video_references (read free from models_explore on 20 September 2026, and
  // recorded in tests/fixtures/connected-models.json). Against origin/main
  // this test fails: the path sent `video` / `image`, which neither declares.
  const catalogue = parseConnectedCatalogue(JSON.parse(readToolsFixture("tests/fixtures/connected-models.json", "utf8")));
  for (const id of ["hf_mult_motion_control", "hf_mult_replace_object"]) {
    const model = findCatalogueModel(catalogue, id)!;
    expect(model.medias.flatMap((slot) => slot.roles).sort()).toEqual(["image_references", "video_references"]);
    const sent = params.medias.map((m) => ({ role: m.role, kind: mediaKindForRole(m.role) }));
    expect(sent).toEqual([
      { role: "video_references", kind: "video" },
      { role: "image_references", kind: "image" },
    ]);
    expect(() => validateGenerationRequest(model, { type: "video", model: id, prompt: input.prompt, parameters: { resolution: input.resolution }, medias: sent })).not.toThrow();
    // The old vocabulary, had it ever reached the validator:
    expect(() => validateGenerationRequest(model, { type: "video", model: id, prompt: input.prompt, parameters: { resolution: input.resolution }, medias: [{ role: "video", kind: "video" }, { role: "image", kind: "image" }] })).toThrow(/video/);
  }
  // And the kinds those declared roles resolve to are exactly the labels the
  // provider echoes back, which is what the collector now compares.
  expect(params.medias.map((m) => mediaKindForRole(m.role))).toEqual(["video", "image"]);
});
test("the live `video_input` data.type on a VIDEO reference still collects the paid transform job", () => {
  // RECORDED FROM PRODUCTION, 20 September 2026, free read-only
  // `show_generations(type=video)`. Reframe job aa426b31-437c-439f-aca2-93d6bd23a6c9
  // echoed its source media as
  //   { "role": "video",
  //     "data": { "id": "851d883d-…", "type": "video_input", "url": "…mp4" } }
  // `jq '[.items[].params.medias[]?.data.type] | unique'` over that history
  // returns ["media_input","video_input"], and the audio history adds
  // "audio_input". Against origin/main this test fails: ECHOED_MEDIA_TYPES was
  // the fixed list ["media_input","image","video","audio"], so any generation
  // or transform carrying a VIDEO reference was paid for and then discarded.
  const echo = (type: string | undefined, id?: string) => ({
    generation: {
      id: jobId,
      status: "completed",
      model: params.model,
      type: "video",
      results: { rawUrl: "https://media.example/original.mp4" },
      params: {
        ...params,
        medias: params.medias.map((m, i) => ({
          role: m.role === "video_references" ? "video" : "image",
          data: {
            id: i === 0 && id !== undefined ? id : m.value,
            ...(type === undefined ? {} : { type }),
            url: "https://media.example/input",
          },
        })),
      },
    },
  });
  // Every spelling recorded live, the bare kinds the contract used to demand,
  // and an entry with no type at all: all qualify.
  for (const type of ["video_input", "media_input", "audio_input", "image_input", "video", "image", "audio", undefined])
    expect(consumerGenjutsuOriginalResult(echo(type), jobId, params), String(type)).toEqual({
      url: "https://media.example/original.mp4",
    });
  // The rule is bounded: a label outside the `<word>_input` family and outside
  // the bare kinds still refuses, so the envelope cannot carry arbitrary junk.
  for (const type of ["instruction", "input", "_input", "video input", "VIDEO_INPUT", "video-input", "media_input ", `${"a".repeat(64)}_input`])
    expect(consumerGenjutsuOriginalResult(echo(type), jobId, params), JSON.stringify(type)).toBeNull();
  // The binding that carries the guarantee is untouched: the media uuid we
  // uploaded, at the index we sent it, and the job id we acknowledged.
  expect(consumerGenjutsuOriginalResult(echo("video_input", other), jobId, params)).toBeNull();
  expect(consumerGenjutsuOriginalResult(echo("video_input"), other, params)).toBeNull();
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
      // The echo as the live account really sends it: the media KIND under
      // `role` and `media_input` under `data.type` — never the slot role we
      // sent. Against origin/main this fixture alone sinks the whole test:
      // generationEvidence demanded role === "video_references" and
      // data.type === "video"/"image", so a COMPLETED, PAID transform job was
      // refused by our own collector.
      medias: params.medias.map((m) => ({
        role: m.role === "video_references" ? "video" : "image",
        data: { id: m.value, type: "media_input", url: "https://media.example/input" },
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
        medias: [{ role: "video", data: { id: other, type: "media_input" } }],
      },
    },
    // One reference too few: the count and the per-index id binding both hold.
    {
      params: {
        ...accepted.params,
        medias: [accepted.params.medias[0]],
      },
    },
    // `data` is still required on this path, and an unknown type still refuses.
    {
      params: {
        ...accepted.params,
        medias: accepted.params.medias.map((m) => ({ role: m.role, value: m.data.id })),
      },
    },
    {
      params: {
        ...accepted.params,
        medias: accepted.params.medias.map((m) => ({ ...m, data: { ...m.data, type: "instruction" } })),
      },
    },
    { params: { ...accepted.params, resolution: "480p" } },
    // A different REAL model id under params.model is still a mismatch.
    { params: { ...accepted.params, model: "seedance_2_5" } },
    { params: { ...accepted.params, model: 5 } },
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
  // The provider echoes a per-family VARIANT under params.model, not a model
  // id (live: `params.model: "default"` beside `model: "seedance_2_5"`).
  // Against the previous code each of these returns null and the job — already
  // paid for — never qualifies.
  for (const variant of ["default", "standard", "pro", "fast", "turbo", "lite", "quality", "std"])
    expect(
      consumerGenjutsuOriginalResult(
        { generation: { ...accepted, params: { ...accepted.params, model: variant } } },
        jobId,
        params,
      ),
      variant,
    ).toEqual({ url: "https://media.example/original.mp4" });
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
