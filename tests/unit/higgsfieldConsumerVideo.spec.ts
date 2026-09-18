import { test, expect } from "@playwright/test";
import {
  getConsumerVideoQuote,
  submitConsumerVideo,
  readConsumerVideoJob,
  CONSUMER_MCP_URL,
} from "../../lib/higgsfield-consumer/mcp";
import {
  consumerVideoAcknowledgement,
  ConsumerVideoError,
  parseConsumerVideoInput,
  type ConsumerVideoInput,
} from "../../lib/higgsfield-consumer/video-contract";

const token = "private-video-fixture-token",
  session = "private-video-fixture-session";
const workspaceId = "11111111-1111-4111-8111-111111111111",
  otherId = "22222222-2222-4222-8222-222222222222",
  jobId = "33333333-3333-4333-8333-333333333333";
const input: ConsumerVideoInput = {
  prompt: "A reusable bottle on a clean background.",
  duration: 15,
  resolution: "720p",
  aspectRatio: "16:9",
  generateAudio: true,
};

test("qualified single-result receipt accepts only this video model and one consistent UUID", () => {
  const result = { id: jobId, model: "marketing_studio_video", type: "video", status: "pending" };
  expect(consumerVideoAcknowledgement({ results: [result] })).toBe(jobId);
  expect(consumerVideoAcknowledgement({ results: [result, result] })).toBeNull();
  expect(consumerVideoAcknowledgement({ results: [{ ...result, type: "image" }] })).toBeNull();
  expect(consumerVideoAcknowledgement({ results: [{ ...result, model: "other" }] })).toBeNull();
  expect(consumerVideoAcknowledgement({ results: [result], id: otherId })).toBeNull();
  expect(consumerVideoAcknowledgement({ results: [{ ...result, id: "not-a-job" }] })).toBeNull();
});
type Packet = {
  id: string;
  method: string;
  params: { name: string; arguments: Record<string, unknown> };
};
function fixture(
  change?: (
    packet: Packet,
    state: { paid: boolean; reads: number },
  ) => unknown | Response | Promise<unknown | Response>,
) {
  const calls: Packet[] = [];
  let reads = 0;
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(CONSUMER_MCP_URL);
    expect(init?.redirect).toBe("error");
    const p: Packet = JSON.parse(String(init?.body));
    calls.push(p);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
    if (p.method === "initialize")
      return Response.json(
        {
          jsonrpc: "2.0",
          id: p.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
        },
        { headers: { "Mcp-Session-Id": session } },
      );
    expect(headers.get("Mcp-Session-Id")).toBe(session);
    if (p.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    expect(p.method).toBe("tools/call");
    const params = p.params.arguments.params as
      Record<string, unknown> | undefined;
    const paid =
      p.params.name === "generate_video" && params?.get_cost === false;
    if (p.params.name === "list_workspaces") reads++;
    const result = await change?.(p, { paid, reads });
    if (result instanceof Response) return result;
    const data =
      result ??
      (p.params.name === "list_workspaces"
        ? {
            workspaces: [
              {
                id: workspaceId,
                name: "Selected wallet",
                is_selected: true,
                credits: 500,
              },
            ],
          }
        : paid
          ? { job_id: jobId }
          : p.params.name === "job_status"
            ? { job_id: jobId, status: "in_progress", poll_after_seconds: 10 }
            : { cost: { credits: 75, credits_exact: 75 } });
    return Response.json({
      jsonrpc: "2.0",
      id: p.id,
      result: { structuredContent: data },
    });
  };
  return {
    fetch: fetcher,
    calls,
    paidCalls: () =>
      calls.filter(
        (p) =>
          p.params?.name === "generate_video" &&
          (p.params.arguments.params as Record<string, unknown>).get_cost ===
            false,
      ),
  };
}

test("typed input rejects injected model, references, blank prompts and unsupported values before network access", async () => {
  const f = fixture();
  for (const bad of [
    { ...input, prompt: " " },
    { ...input, prompt: "x".repeat(5001) },
    { ...input, model: "other" },
    { ...input, image: jobId },
    { ...input, duration: 11 },
    { ...input, duration: 15.5 },
    { ...input, resolution: "4k" },
    { ...input, aspectRatio: "2:3" },
    { ...input, generateAudio: undefined },
    { ...input, get_cost: false },
  ]) {
    await expect(
      getConsumerVideoQuote(token, bad as ConsumerVideoInput, {
        fetch: f.fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_input", paidAttempted: false });
  }
  expect(f.calls).toHaveLength(0);
  expect(Object.isFrozen(parseConsumerVideoInput(input))).toBe(true);
});

test("cost-only quote reads workspace before and after and sends exact immutable explicit settings", async () => {
  const f = fixture();
  expect(await getConsumerVideoQuote(token, input, { fetch: f.fetch })).toEqual(
    {
      input,
      workspace: { id: workspaceId, name: "Selected wallet", credits: 500 },
      credits: 75,
    },
  );
  const calls = f.calls.slice(2);
  expect(calls.map((p) => p.params.name)).toEqual([
    "list_workspaces",
    "generate_video",
    "list_workspaces",
  ]);
  expect(calls[1].params.arguments).toEqual({
    params: {
      model: "marketing_studio_video",
      prompt: input.prompt,
      duration: 15,
      resolution: "720p",
      aspect_ratio: "16:9",
      generate_audio: true,
      count: 1,
      get_cost: true,
      use_unlim: false,
    },
  });
  expect(f.paidCalls()).toHaveLength(0);
  expect(f.calls.some((p) => p.params?.name === "select_workspace")).toBe(
    false,
  );
});

test("submission persists admission after fresh quote and workspace checks, before exactly one matching paid request", async () => {
  let admitted = false;
  const original = { ...input };
  const f = fixture((_p, state) => {
    if (state.paid) expect(admitted).toBe(true);
  });
  const result = await submitConsumerVideo(token, original, workspaceId, 75, {
    fetch: f.fetch,
    admit: async () => {
      expect(f.calls.slice(2).map((p) => p.params.name)).toEqual([
        "list_workspaces",
        "generate_video",
        "list_workspaces",
      ]);
      expect(f.paidCalls()).toHaveLength(0);
      original.prompt = "changed after admission";
      admitted = true;
    },
  });
  expect(result).toEqual({
    state: "accepted",
    providerJobId: jobId,
    raw: { job_id: jobId },
  });
  const quote = f.calls.find((p) => p.params?.name === "generate_video")!;
  expect(f.paidCalls()).toHaveLength(1);
  expect(f.paidCalls()[0].params.arguments).toEqual({
    params: { ...(quote.params.arguments.params as object), get_cost: false },
  });
  expect(
    (f.paidCalls()[0].params.arguments.params as Record<string, unknown>)
      .prompt,
  ).toBe(input.prompt);
});

test("workspace drift, price drift, changed settings, and insufficient funds refuse admission and paid requests", async () => {
  const cases: { code: string; change: Parameters<typeof fixture>[0] }[] = [
    {
      code: "workspace_changed",
      change: (p) =>
        p.params.name === "list_workspaces"
          ? { workspaces: [{ id: otherId, is_selected: true, credits: 500 }] }
          : undefined,
    },
    {
      code: "workspace_changed",
      change: (p, s) =>
        p.params.name === "list_workspaces" && s.reads === 2
          ? { workspaces: [{ id: otherId, is_selected: true, credits: 500 }] }
          : undefined,
    },
    {
      code: "quote_changed",
      change: (p) =>
        p.params.name === "generate_video"
          ? { cost: { credits: 76, credits_exact: 76 } }
          : undefined,
    },
    {
      code: "invalid_quote",
      change: (p) =>
        p.params.name === "generate_video"
          ? { cost: { credits: 75, credits_exact: 74.5 } }
          : undefined,
    },
    {
      code: "unapproved_adjustment",
      change: (p) =>
        p.params.name === "generate_video"
          ? {
              cost: { credits: 75, credits_exact: 75 },
              adjustments: {
                "params.generate_audio": { requested: "(unset)", used: true },
              },
            }
          : undefined,
    },
    {
      code: "unapproved_adjustment",
      change: (p) =>
        p.params.name === "generate_video"
          ? {
              cost: { credits: 75, credits_exact: 75 },
              adjustments: {
                "params.prompt": {
                  requested: input.prompt,
                  used: "other prompt",
                },
              },
            }
          : undefined,
    },
    {
      code: "insufficient_credits",
      change: (p) =>
        p.params.name === "list_workspaces"
          ? {
              workspaces: [{ id: workspaceId, is_selected: true, credits: 74 }],
            }
          : undefined,
    },
    {
      code: "invalid_workspace",
      change: (p) =>
        p.params.name === "list_workspaces"
          ? {
              workspaces: [
                { id: workspaceId, is_selected: true, credits: 500 },
                { id: otherId, is_selected: true, credits: 500 },
              ],
            }
          : undefined,
    },
  ];
  for (const c of cases) {
    const f = fixture(c.change);
    let admitted = 0;
    await expect(
      submitConsumerVideo(token, input, workspaceId, 75, {
        fetch: f.fetch,
        admit: async () => {
          admitted++;
        },
      }),
    ).rejects.toMatchObject({ code: c.code, paidAttempted: false });
    expect(admitted).toBe(0);
    expect(f.paidCalls()).toHaveLength(0);
  }
});

test("an unchanged explicit adjustment is allowed but an unknown adjustment is rejected", async () => {
  const f = fixture((p) =>
    p.params.name === "generate_video"
      ? {
          cost: { credits: 75, credits_exact: 75 },
          adjustments: {
            "params.generate_audio": { requested: true, used: true },
          },
        }
      : undefined,
  );
  expect(
    (await getConsumerVideoQuote(token, input, { fetch: f.fetch })).credits,
  ).toBe(75);
  const unknown = fixture((p) =>
    p.params.name === "generate_video"
      ? {
          cost: { credits: 75, credits_exact: 75 },
          adjustments: { "params.extra": { requested: 1, used: 1 } },
        }
      : undefined,
  );
  await expect(
    getConsumerVideoQuote(token, input, { fetch: unknown.fetch }),
  ).rejects.toMatchObject({ code: "unapproved_adjustment" });
});

test("durable claim refusal escapes unchanged and never becomes submission uncertainty", async () => {
  const f = fixture(),
    refusal = new Error("fixture admission conflict");
  await expect(
    submitConsumerVideo(token, input, workspaceId, 75, {
      fetch: f.fetch,
      admit: async () => {
        throw refusal;
      },
    }),
  ).rejects.toBe(refusal);
  expect(f.paidCalls()).toHaveLength(0);
});

test("expired admission deadline prevents a paid POST even after the durable callback completes", async () => {
  const f = fixture();
  await expect(
    submitConsumerVideo(token, input, workspaceId, 75, {
      fetch: f.fetch,
      timeoutMs: 100,
      admit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
      },
    }),
  ).rejects.toMatchObject({
    code: "preflight_unavailable",
    paidAttempted: false,
  });
  expect(f.paidCalls()).toHaveLength(0);
});

test("paid transport failures, redirects, malformed replies and explicit tool errors remain uncertain without retry", async () => {
  const failures: Parameters<typeof fixture>[0][] = [
    (_p, s) => {
      if (s.paid) throw new Error(`secret ${token}`);
    },
    (_p, s) =>
      s.paid
        ? new Response(null, {
            status: 307,
            headers: { Location: "https://elsewhere.invalid" },
          })
        : undefined,
    (_p, s) =>
      s.paid
        ? new Response("invalid JSON", {
            headers: { "Content-Type": "application/json" },
          })
        : undefined,
    (p, s) =>
      s.paid
        ? Response.json({
            jsonrpc: "2.0",
            id: p.id,
            result: {
              isError: true,
              content: [
                { type: "text", text: `Try generating again. ${token}` },
              ],
            },
          })
        : undefined,
    (p, s) =>
      s.paid
        ? Response.json({
            jsonrpc: "2.0",
            id: p.id,
            error: { code: -1, message: `private ${token}` },
          })
        : undefined,
    (_p, s) =>
      s.paid ? { text: `Accepted job ${jobId}; use this ID` } : undefined,
  ];
  for (const fail of failures) {
    const f = fixture(fail);
    const result = await submitConsumerVideo(token, input, workspaceId, 75, {
      fetch: f.fetch,
      admit: async () => {},
    });
    expect(result.state).toBe("uncertain");
    expect(f.paidCalls()).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result).not.toHaveProperty("providerJobId");
  }
});

test("acknowledgements accept only one consistent explicit UUID and preserve safe raw evidence", async () => {
  for (const value of [
    { job_id: jobId },
    { id: jobId },
    { jobs: [{ id: jobId }] },
    { job_ids: [jobId] },
    { id: jobId, job_ids: [jobId] },
  ])
    expect(consumerVideoAcknowledgement(value)).toBe(jobId);
  for (const value of [
    { message: jobId },
    { nested: { job_id: jobId } },
    { id: jobId, job_id: otherId },
    { jobs: [jobId, otherId] },
    { job_ids: [jobId, jobId] },
    { job_id: "bad" },
    { id: jobId, jobs: [] },
  ])
    expect(consumerVideoAcknowledgement(value)).toBeNull();
  const f = fixture((p, s) =>
    s.paid
      ? new Response(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: p.id, result: { isError: true, structuredContent: { jobs: [{ job_id: jobId }], access_token: "other-private-token", note: session } } })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        )
      : undefined,
  );
  expect(
    await submitConsumerVideo(token, input, workspaceId, 75, {
      fetch: f.fetch,
      admit: async () => {},
    }),
  ).toEqual({
    state: "accepted",
    providerJobId: jobId,
    raw: {
      jobs: [{ job_id: jobId }],
      access_token: "[redacted]",
      note: "[redacted]",
    },
  });
});

test("a lost paid acknowledgement times out once and remains uncertain even if fetch ignores abort", async () => {
  const f = fixture((_packet, state) =>
    state.paid ? new Promise(() => {}) : undefined,
  );
  const result = await submitConsumerVideo(token, input, workspaceId, 75, {
    fetch: f.fetch,
    callTimeoutMs: 10,
    admit: async () => {},
  });
  expect(result.state).toBe("uncertain");
  expect(f.paidCalls()).toHaveLength(1);
});

test("job polling is read-only and validates workspace, known UUID and bounded poll delay", async () => {
  const f = fixture();
  expect(
    await readConsumerVideoJob(token, jobId, workspaceId, { fetch: f.fetch }),
  ).toEqual({
    jobId,
    raw: { job_id: jobId, status: "in_progress", poll_after_seconds: 10 },
    pollAfterSeconds: 10,
  });
  expect(f.calls.slice(2).map((p) => p.params)).toEqual([
    { name: "list_workspaces", arguments: {} },
    { name: "job_status", arguments: { jobId, sync: false, raw_data: true } },
  ]);
  for (const data of [
    { job_id: otherId },
    { job_id: "not-uuid" },
    { job_id: jobId, poll_after_seconds: -1 },
    { job_id: jobId, poll_after_seconds: 3601 },
  ]) {
    const invalid = fixture((p) =>
      p.params.name === "job_status" ? data : undefined,
    );
    await expect(
      readConsumerVideoJob(token, jobId, workspaceId, { fetch: invalid.fetch }),
    ).rejects.toMatchObject({ code: "invalid_job" });
    expect(invalid.paidCalls()).toHaveLength(0);
  }
  const drift = fixture((p) =>
    p.params.name === "list_workspaces"
      ? { workspaces: [{ id: otherId, is_selected: true, credits: 500 }] }
      : undefined,
  );
  await expect(
    readConsumerVideoJob(token, jobId, workspaceId, { fetch: drift.fetch }),
  ).rejects.toMatchObject({ code: "workspace_changed" });
  expect(drift.calls.some((p) => p.params?.name === "job_status")).toBe(false);
  await expect(
    readConsumerVideoJob(token, "bad", workspaceId, { fetch: f.fetch }),
  ).rejects.toBeInstanceOf(ConsumerVideoError);
});
