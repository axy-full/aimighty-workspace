import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CONSUMER_MCP_URL,
  getConsumerShortsQuote,
  readConsumerShortsClips,
  readConsumerShortsSession,
  submitConsumerShorts,
} from "../../lib/higgsfield-consumer/mcp";
import { resetConnectedToolsetCache } from "../../lib/higgsfield-consumer/toolset";
import {
  SHORTS_TOOLS,
  consumerShortsParams,
  parseShortsSessionStatus,
  type ConsumerShortsInput,
} from "../../lib/higgsfield-consumer/shorts-studio";
import { consumerVoiceToolFailureResult, consumerVoiceToolOriginalResult } from "../../lib/higgsfield-consumer/voice-tools";

/**
 * Shorts polling goes through the connected-toolset guard (#226), like every
 * other product. Before this it called `job_status` directly, so on a connection
 * that does not advertise `job_status` — the 91-tool surface — every Shorts poll
 * failed closed after the money was already spent, with no fall back to
 * `job_display` or `jobs_wait`.
 */
type Tool = { name: string; inputSchema: Record<string, unknown> };
const ninetyEight = JSON.parse(readFileSync("tests/fixtures/connected-tools-98.json", "utf8")) as { tools: Tool[] };
const ninetyOne = JSON.parse(readFileSync("tests/fixtures/connected-tools-91.json", "utf8")) as { tools: Tool[] };
const shortsStudio = JSON.parse(readFileSync("tests/fixtures/connected-shorts-studio.json", "utf8")) as { tools: Tool[] };

/** Both tool captures record the Shorts tools by name with a stub schema — they
 *  were captured before Shorts shipped. Here they carry their advertised
 *  schemas, from the Shorts Studio capture of the same account and day. */
const withShorts = (tools: Tool[]): Tool[] =>
  tools.map((tool) => shortsStudio.tools.find((shorts) => shorts.name === tool.name) ?? tool);
const without = (tools: Tool[], ...names: string[]) => tools.filter((tool) => !names.includes(tool.name));
const OURS = withShorts(ninetyEight.tools);
const THEIRS = withShorts(ninetyOne.tools);

const wallet = randomUUID(), sessionId = randomUUID(), media = randomUUID();
const clips: string[] = [randomUUID(), randomUUID()];
const rawUrl = (index: number) => `https://fixtures.particl.invalid/outputs/short-${index}.mp4`;
const input: ConsumerShortsInput = { source: { uploadId: "source-video" }, preset: { id: randomUUID(), source: "cms", name: "Neon cut" }, aspectRatio: "9:16" };
const params = consumerShortsParams(input, media, 12);

type Packet = { id: string; method: string; params: { name: string; arguments: Record<string, unknown> } };
function session(options: { tools: Tool[]; reply?: (p: Packet) => unknown }) {
  const calls: Packet[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(CONSUMER_MCP_URL);
    const p = JSON.parse(String(init?.body)) as Packet;
    calls.push(p);
    if (p.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    if (p.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (p.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: p.id, result: { tools: options.tools } });
    if (!options.tools.some((tool) => tool.name === p.params.name))
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { isError: true, content: [{ type: "text", text: `Tool ${p.params.name} not found` }] } });
    const args = p.params.arguments;
    const clipOf = (id: unknown) => clips.indexOf(String(id));
    const value = options.reply?.(p) ?? (
      p.params.name === "list_workspaces" ? { workspaces: [{ id: wallet, is_selected: true, credits: 500, name: "Fixture wallet" }] }
      : p.params.name === "media_import_url" ? { media_id: media }
      : p.params.name === SHORTS_TOOLS.status ? { id: sessionId, status: "completed", job_ids: clips }
      : p.params.name === SHORTS_TOOLS.create ? (args.get_cost === true ? { cost: { credits: 42, credits_exact: 42 } } : { id: sessionId, job_ids: [] })
      : p.params.name === "job_status" ? { generation: { id: args.jobId, type: "video", status: "completed", results: { rawUrl: rawUrl(clipOf(args.jobId)) } } }
      : p.params.name === "job_display" ? { id: args.id, status: "completed", type: "video", results: { rawUrl: rawUrl(clipOf(args.id)) } }
      : p.params.name === "jobs_wait" ? { all_terminal: true, jobs: (args.jobs as { job_id: string }[]).map((job, index) => ({ index, job_id: job.job_id, status: "completed", result_url: rawUrl(clipOf(job.job_id)) })) }
      : {});
    return Response.json({ jsonrpc: "2.0", id: p.id, result: { structuredContent: value } });
  };
  const toolCalls = () => calls.filter((p) => p.method === "tools/call");
  return { fetch: fetcher, toolCalls, names: () => toolCalls().map((p) => p.params.name) };
}

const readClips = (f: ReturnType<typeof session>) => readConsumerShortsClips("fixture-private-access", clips, wallet, { fetch: f.fetch });
const readSession = (f: ReturnType<typeof session>) => readConsumerShortsSession("fixture-private-access", sessionId, wallet, { fetch: f.fetch });

test.beforeEach(() => resetConnectedToolsetCache());

test("the Shorts tools advertise their arguments on both captured surfaces; only ours has job_status", () => {
  for (const tools of [OURS, THEIRS])
    for (const name of Object.values(SHORTS_TOOLS)) expect(tools.some((tool) => tool.name === name)).toBe(true);
  expect(OURS.some((tool) => tool.name === "job_status")).toBe(true);
  expect(THEIRS.some((tool) => tool.name === "job_status")).toBe(false);
  for (const name of ["job_display", "jobs_wait"]) expect(THEIRS.some((tool) => tool.name === name)).toBe(true);
});

test("on our 98-tool surface Shorts polls the session and every clip through job_status", async () => {
  const f = session({ tools: OURS });
  const status = parseShortsSessionStatus(await readSession(f), sessionId);
  expect(status).toMatchObject({ terminal: true, jobIds: clips });
  const read = await readClips(f);
  expect(read.map((clip) => clip.jobId)).toEqual(clips);
  read.forEach((clip, index) => expect(consumerVoiceToolOriginalResult(clip.raw, clip.jobId)).toEqual({ url: rawUrl(index) }));
  expect(f.names().filter((name) => name === "job_status")).toHaveLength(2);
  expect(f.names()).not.toContain("job_display");
});

test("on the 91-tool surface, with no job_status, Shorts falls back to job_display and the collector still qualifies each clip", async () => {
  const f = session({ tools: THEIRS });
  expect(parseShortsSessionStatus(await readSession(f), sessionId).jobIds).toEqual(clips);
  const read = await readClips(f);
  expect(f.names()).not.toContain("job_status");
  expect(f.names().filter((name) => name === "job_display")).toHaveLength(2);
  read.forEach((clip, index) => {
    expect(clip.raw).toMatchObject({ status_source: "job_display", generation: { id: clip.jobId, status: "completed", type: "video" } });
    expect(consumerVoiceToolOriginalResult(clip.raw, clip.jobId)).toEqual({ url: rawUrl(index) });
  });
});

test("with only jobs_wait advertised, Shorts reads an immediate snapshot per clip", async () => {
  const f = session({ tools: without(THEIRS, "job_display") });
  const read = await readClips(f);
  expect(f.names().filter((name) => name === "jobs_wait")).toHaveLength(2);
  read.forEach((clip, index) => expect(consumerVoiceToolOriginalResult(clip.raw, clip.jobId)).toEqual({ url: rawUrl(index) }));
});

test("a failed clip is still a failure through the fallback, and never a collected original", async () => {
  const f = session({
    tools: THEIRS,
    reply: (p) => (p.params.name === "job_display" ? { id: p.params.arguments.id, status: "failed", type: "video" } : undefined),
  });
  const read = await readClips(f);
  read.forEach((clip) => {
    expect(consumerVoiceToolFailureResult(clip.raw, clip.jobId)).toBe("failed");
    expect(consumerVoiceToolOriginalResult(clip.raw, clip.jobId)).toBeNull();
  });
});

test("with no status tool at all the Shorts poll refuses and calls none", async () => {
  const f = session({ tools: without(THEIRS, "job_display", "jobs_wait") });
  await expect(readClips(f)).rejects.toMatchObject({ code: "status_unavailable", status: 503 });
  expect(f.names()).toEqual(["list_workspaces"]);
});

test("a Shorts tool this connection does not advertise refuses before it is called", async () => {
  const noStatus = session({ tools: without(THEIRS, SHORTS_TOOLS.status) });
  const refused = await readSession(noStatus).catch((error) => error);
  expect(refused).toMatchObject({ code: "tool_unavailable", status: 409 });
  expect(refused.message).not.toMatch(/higgsfield|shorts studio/i);
  expect(noStatus.names()).toEqual(["list_workspaces"]);
});

test("a missing create tool refuses before any import, price or spend", async () => {
  const quote = session({ tools: without(THEIRS, SHORTS_TOOLS.create) });
  let imported = false;
  await expect(
    getConsumerShortsQuote("fixture-private-access", input, { url: "https://fixtures.particl.invalid/uploads/source.mp4", type: "video", durationSeconds: 12 }, {
      fetch: quote.fetch,
      resolveMedia: async (_workspace, perform) => { imported = true; return perform(); },
    }),
  ).rejects.toMatchObject({ code: "tool_unavailable" });
  expect(imported).toBe(false);
  expect(quote.names()).toEqual(["list_workspaces"]);

  resetConnectedToolsetCache();
  const submit = session({ tools: without(THEIRS, SHORTS_TOOLS.create) });
  let admitted = false;
  await expect(
    submitConsumerShorts("fixture-private-access", input, params, wallet, 42, { fetch: submit.fetch, admit: async () => { admitted = true; } }),
  ).rejects.toMatchObject({ code: "tool_unavailable" });
  expect(admitted).toBe(false);
  expect(submit.names()).toEqual(["list_workspaces"]);
});

test("Shorts quotes, submits and then polls end to end on the 91-tool surface", async () => {
  const f = session({ tools: THEIRS });
  const quoted = await getConsumerShortsQuote("fixture-private-access", input, { url: "https://fixtures.particl.invalid/uploads/source.mp4", type: "video", durationSeconds: 12 }, {
    fetch: f.fetch,
    resolveMedia: async (_workspace, perform) => perform(),
  });
  expect(quoted.credits).toBe(42);
  const submitted = await submitConsumerShorts("fixture-private-access", input, quoted.params, wallet, 42, { fetch: f.fetch, admit: async () => {} });
  expect(submitted).toMatchObject({ state: "accepted", providerJobId: sessionId });
  expect(parseShortsSessionStatus(await readSession(f), sessionId).terminal).toBe(true);
  const read = await readClips(f);
  expect(read).toHaveLength(2);
  expect(f.names()).not.toContain("job_status");
  expect(f.names().filter((name) => name === "job_display")).toHaveLength(2);
});
