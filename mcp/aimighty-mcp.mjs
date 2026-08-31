#!/usr/bin/env node
/**
 * aimighty workspace — MCP server
 *
 * Lets Claude drive the workspace: write a shot, wait for it, pull the file
 * down, check what it cost. It speaks MCP over stdio and talks to the
 * deployed workspace over its ordinary HTTP API using an API token, so it
 * needs no access to the database, the BytePlus key, or anything else.
 *
 * Zero dependencies on purpose — one file, run by node, nothing to install
 * and nothing to keep up to date.
 *
 *   AIMIGHTY_URL=https://workspace.aimighty.studio \
 *   AIMIGHTY_TOKEN=aw_… \
 *   node aimighty-mcp.mjs
 *
 * `--check` verifies the URL and token and exits, which is the fastest way
 * to tell a configuration problem from a protocol one.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = (process.env.AIMIGHTY_URL ?? "https://workspace.aimighty.studio").replace(/\/$/, "");
const TOKEN = process.env.AIMIGHTY_TOKEN ?? "";
const NAME = "aimighty-workspace";
const VERSION = "1.0.0";

/* ── the workspace API ─────────────────────────────────────────────────── */

async function api(pathname, { method = "GET", body, raw = false } = {}) {
  if (!TOKEN) {
    throw new Error(
      "AIMIGHTY_TOKEN is not set. Make a token in the workspace under Settings → API tokens."
    );
  }
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (raw) {
    if (!res.ok) throw new Error(`${res.status} fetching ${pathname}`);
    return Buffer.from(await res.arrayBuffer());
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`${res.status} from ${pathname}: ${text.slice(0, 200)}`); }

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("The token was refused. It may have been revoked, or AIMIGHTY_URL may point at the wrong workspace.");
    }
    throw new Error(json.error ?? `${res.status} from ${pathname}`);
  }
  return json;
}

const usd = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

/** Projects are addressed by name here — an agent shouldn't juggle ids. */
async function resolveProject(nameOrId) {
  if (!nameOrId) return null;
  const { projects } = await api("/api/projects");
  const want = String(nameOrId).trim().toLowerCase();
  const hit =
    projects.find((p) => p.id === nameOrId) ??
    projects.find((p) => p.name.toLowerCase() === want) ??
    projects.find((p) => p.name.toLowerCase().includes(want));
  if (!hit) {
    throw new Error(
      `No project called "${nameOrId}". Existing: ${projects.map((p) => p.name).join(", ") || "none yet"}.`
    );
  }
  return hit;
}

function describeRender(g) {
  const p = g.params ?? {};
  const spec = [p.resolution, p.ratio, p.duration ? `${p.duration}s` : null]
    .filter(Boolean).join(" · ");
  const cost = g.costUsd == null ? "" : ` · ${usd((g.costUsd ?? 0) + (g.refineCostUsd ?? 0))}`;
  return `${g.id} · ${g.status}${spec ? ` · ${spec}` : ""}${cost}\n  ${g.prompt}`;
}

/* ── the tools ─────────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: "render_shot",
    description:
      "Start a video (or still) render in the aimighty workspace. Returns immediately with an id — " +
      "renders take roughly one to three minutes — then use wait_for_render to collect it. " +
      "Every prompt is automatically rewritten with ByteDance's Seedance recipe before rendering; " +
      "prefix the prompt with 'raw:' to send your exact words instead. This spends real money.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The shot: subject, action, setting, camera, light, mood." },
        project: { type: "string", description: "Project name to file it under. Optional." },
        model: { type: "string", description: "'2.5' (default, up to 30s + audio) or '2.0' (cheaper)." },
        duration: { type: "number", description: "Seconds. Default 5." },
        resolution: { type: "string", description: "480p | 720p | 1080p. Default 1080p." },
        ratio: { type: "string", description: "16:9 (default), 9:16, 1:1, 4:3, 3:4, 21:9." },
        audio: { type: "boolean", description: "Native audio track. Seedance 2.5 only. Default false." },
        seed: { type: "number", description: "Fix the seed to make a shot reproducible." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "wait_for_render",
    description:
      "Wait for a render to finish and report what it cost. Polls the workspace; returns as soon as " +
      "the render succeeds or fails, or when the timeout is reached (it keeps rendering either way).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The render id from render_shot." },
        timeout_seconds: { type: "number", description: "How long to wait. Default 240, max 600." },
      },
      required: ["id"],
    },
  },
  {
    name: "list_renders",
    description: "List recent renders, newest first, optionally filtered by project, status or a prompt search.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name. Omit for everything." },
        status: { type: "string", description: "succeeded | running | queued | failed." },
        search: { type: "string", description: "Match against prompt text." },
        limit: { type: "number", description: "Default 20, max 60." },
      },
    },
  },
  {
    name: "get_render",
    description:
      "Details of one render, and optionally save the file to disk. Use save_to with an absolute " +
      "path to download the mp4 (or png for stills).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The render id." },
        save_to: { type: "string", description: "Absolute path to write the media to. Optional." },
      },
      required: ["id"],
    },
  },
  {
    name: "list_projects",
    description: "The workspace's projects, with how many renders each holds and what they cost.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_project",
    description: "Make a new project to file renders under.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Project name." } },
      required: ["name"],
    },
  },
  {
    name: "usage_summary",
    description: "What the workspace has spent, what credit remains, and how many renders are in flight.",
    inputSchema: { type: "object", properties: {} },
  },
];

const HANDLERS = {
  async render_shot(a) {
    const project = a.project ? await resolveProject(a.project) : null;
    const model = String(a.model ?? "2.5").includes("2.0")
      ? "dreamina-seedance-2-0-260128"
      : "dreamina-seedance-2-5-260628";

    const out = await api("/api/generate", {
      method: "POST",
      body: {
        prompt: a.prompt,
        model,
        ratio: a.ratio ?? "16:9",
        resolution: a.resolution ?? "1080p",
        duration: a.duration ?? 5,
        generateAudio: Boolean(a.audio),
        seed: a.seed ?? null,
        watermark: false,
        projectId: project?.id ?? null,
      },
    });

    return (
      `Rendering started.\n\nid: ${out.id}\n` +
      `project: ${project?.name ?? "Unfiled"}\n` +
      `model: ${model.includes("2-5") ? "Seedance 2.5" : "Seedance 2.0"} · ` +
      `${a.resolution ?? "1080p"} · ${a.ratio ?? "16:9"} · ${a.duration ?? 5}s\n\n` +
      `Call wait_for_render with this id to collect it (usually one to three minutes).`
    );
  },

  async wait_for_render(a) {
    const timeout = Math.min(Math.max(Number(a.timeout_seconds ?? 240), 5), 600) * 1000;
    const started = Date.now();
    let last = null;

    while (Date.now() - started < timeout) {
      const g = await api(`/api/jobs/${encodeURIComponent(a.id)}`);
      const gen = g.generation ?? g;
      last = gen;
      if (gen.status === "succeeded") {
        return (
          `Done in ${Math.round((Date.now() - started) / 1000)}s.\n\n` +
          `${describeRender(gen)}\n\n` +
          `Cost ${usd((gen.costUsd ?? 0) + (gen.refineCostUsd ?? 0))}. ` +
          `Use get_render with save_to to download it.`
        );
      }
      if (gen.status === "failed" || gen.status === "cancelled") {
        return `Render ${gen.status}.\n\n${gen.error ?? "No reason given."}`;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    return (
      `Still ${last?.status ?? "rendering"} after ${Math.round(timeout / 1000)}s — it hasn't failed, ` +
      `just taken longer than we waited. Call wait_for_render again with the same id.`
    );
  },

  async list_renders(a) {
    const project = a.project ? await resolveProject(a.project) : null;
    const q = new URLSearchParams({
      limit: String(Math.min(Number(a.limit ?? 20), 60)),
      sync: "0",
    });
    if (project) q.set("projectId", project.id);
    if (a.status) q.set("status", a.status);
    if (a.search) q.set("q", a.search);

    const { generations } = await api(`/api/jobs?${q}`);
    if (!generations.length) return "No renders match that.";
    return generations.map(describeRender).join("\n\n");
  },

  async get_render(a) {
    const g = await api(`/api/jobs/${encodeURIComponent(a.id)}`);
    const gen = g.generation ?? g;
    let saved = "";

    if (a.save_to) {
      if (gen.status !== "succeeded") {
        return `${describeRender(gen)}\n\nNothing to save yet — it is ${gen.status}.`;
      }
      const ext = gen.kind === "image" ? "png" : "mp4";
      let target = path.resolve(String(a.save_to));
      if (!path.extname(target)) target = path.join(target, `${gen.id}.${ext}`);
      const bytes = await api(`/api/media/${encodeURIComponent(gen.id)}?download=1`, { raw: true });
      await writeFile(target, bytes);
      saved = `\n\nSaved ${(bytes.length / 1048576).toFixed(1)} MB to ${target}`;
    }

    return `${describeRender(gen)}${gen.authorName ? `\n  by ${gen.authorName}` : ""}${saved}`;
  },

  async list_projects() {
    const { projects } = await api("/api/projects");
    if (!projects.length) return "No projects yet.";
    return projects
      .map((p) => `${p.name} — ${p.genCount} render${p.genCount === 1 ? "" : "s"} · ${usd(p.spend)}`)
      .join("\n");
  },

  async create_project(a) {
    const out = await api("/api/projects", { method: "POST", body: { name: a.name } });
    return `Created project "${out.name}".`;
  },

  async usage_summary() {
    const u = await api("/api/usage/summary");
    return (
      `Spent all time: ${usd(u.spentUsd)}\n` +
      `Credit recorded: ${usd(u.purchasedUsd)}\n` +
      `Remaining: ${usd(u.remainingUsd)}\n` +
      `Rendering now: ${u.pending}`
    );
  },
};

/* ── MCP over stdio ────────────────────────────────────────────────────── */

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    // Echo the client's protocol version when it names one — this server has
    // no version-specific behaviour, and refusing an unknown string would
    // break on every future revision for no reason.
    ok(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    });
    return;
  }

  // Notifications carry no id and expect no reply.
  if (id === undefined) return;

  if (method === "tools/list") { ok(id, { tools: TOOLS }); return; }

  if (method === "ping") { ok(id, {}); return; }

  if (method === "tools/call") {
    const fn = HANDLERS[params?.name];
    if (!fn) { fail(id, -32602, `Unknown tool: ${params?.name}`); return; }
    try {
      const text = await fn(params.arguments ?? {});
      ok(id, { content: [{ type: "text", text }] });
    } catch (e) {
      // Tool failures are results, not protocol errors: the model should read
      // the reason and decide what to do, rather than see the call vanish.
      ok(id, { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true });
    }
    return;
  }

  fail(id, -32601, `Method not found: ${method}`);
}

async function main() {
  if (process.argv.includes("--check")) {
    process.stderr.write(`Checking ${BASE} …\n`);
    try {
      const u = await api("/api/usage/summary");
      const { projects } = await api("/api/projects");
      process.stderr.write(
        `OK — connected.\n` +
        `  spent ${usd(u.spentUsd)} · remaining ${usd(u.remainingUsd)} · rendering ${u.pending}\n` +
        `  ${projects.length} project${projects.length === 1 ? "" : "s"}\n`
      );
      process.exit(0);
    } catch (e) {
      process.stderr.write(`FAILED — ${e.message}\n`);
      process.exit(1);
    }
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { continue; }
      handle(msg).catch((e) => {
        if (msg?.id !== undefined) fail(msg.id, -32603, e.message);
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

main();
