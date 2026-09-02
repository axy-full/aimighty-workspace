#!/usr/bin/env node
/**
 * Particl — local connector, and a small CLI.
 *
 * Most of this file is a bridge: it speaks MCP over stdio to a client such as
 * Claude Code or Claude Desktop, and forwards every call to the workspace's
 * own MCP endpoint over HTTPS. The tools themselves live in the workspace, so
 * this file never goes stale when they change, and there is nothing to
 * install — one file, no dependencies.
 *
 *   PARTICL_URL=https://www.particlstudio.com \
 *   PARTICL_TOKEN=aw_… \
 *   node particl-mcp.mjs
 *
 * It is also usable by hand:
 *
 *   node particl-mcp.mjs --check
 *   node particl-mcp.mjs projects
 *   node particl-mcp.mjs usage
 *   node particl-mcp.mjs ls [--project "Monsoon Film"] [--search rain]
 *   node particl-mcp.mjs render "a slow dolly through monsoon rain" [--project X] [--duration 5] [--res 1080p] [--wait]
 *   node particl-mcp.mjs get <id> [--save ./shot.mp4]
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

// PARTICL_* are the names now; AIMIGHTY_* are still read so a connector
// somebody already installed doesn't break the day the product is renamed.
const BASE = (process.env.PARTICL_URL ?? process.env.AIMIGHTY_URL ??
              "https://www.particlstudio.com").replace(/\/$/, "");
const TOKEN = process.env.PARTICL_TOKEN ?? process.env.AIMIGHTY_TOKEN ?? "";
const ENDPOINT = `${BASE}/api/mcp`;

function requireToken() {
  if (!TOKEN) {
    throw new Error(
      "PARTICL_TOKEN is not set. Make one in Particl under Settings → Connect."
    );
  }
}

/** Forward one JSON-RPC message to the workspace and return its reply. */
async function forward(payload) {
  requireToken();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload),
  });
  if (res.status === 202) return null;            // a notification
  const text = await res.text();
  if (res.status === 401) {
    throw new Error(
      "The token was refused. It may have been revoked, or PARTICL_URL may point at the wrong workspace."
    );
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`${res.status} from ${ENDPOINT}: ${text.slice(0, 200)}`); }
}

/** Call one tool and return its text, for the CLI verbs. */
async function tool(name, args = {}) {
  const reply = await forward({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
  });
  const text = reply?.result?.content?.[0]?.text ?? reply?.error?.message ?? "(no answer)";
  if (reply?.result?.isError) process.exitCode = 1;
  return text;
}

/** Download a render's media. Only the local side can write to your disk. */
async function saveMedia(id, dest) {
  requireToken();
  const res = await fetch(`${BASE}/api/media/${encodeURIComponent(id)}?download=1`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`${res.status} downloading ${id}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // The workspace decides the filename (PROJECT_SCENE_SHOT_MODEL_VERSION_USER
  // by default) and sends it in Content-Disposition. Saving into a directory
  // honours that rather than falling back to the render id.
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const served = m ? decodeURIComponent(m[1]).replace(/[/\\]/g, "-").trim() : "";
  const type = res.headers.get("content-type") ?? "";
  const fallback = `${id}.${type.includes("png") ? "png" : "mp4"}`;
  let target = path.resolve(dest);
  if (!path.extname(target)) target = path.join(target, served || fallback);
  await writeFile(target, buf);
  return { target, mb: (buf.length / 1048576).toFixed(1) };
}

/* ── MCP over stdio ────────────────────────────────────────────────────── */

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function handle(msg) {
  const { id, method, params } = msg;

  // save_to is the one thing the remote side cannot do: it writes to THIS
  // machine. Handle it here, then let the rest of the call go through.
  if (method === "tools/call" && params?.name === "get_render" && params?.arguments?.save_to) {
    const { save_to, ...rest } = params.arguments;
    const reply = await forward({ ...msg, params: { ...params, arguments: rest } });
    let text = reply?.result?.content?.[0]?.text ?? "";
    if (!reply?.result?.isError) {
      try {
        const { target, mb } = await saveMedia(String(rest.id), String(save_to));
        text += `\n\nSaved ${mb} MB to ${target}`;
      } catch (e) {
        text += `\n\nCould not save the file: ${e.message}`;
      }
    }
    send({ jsonrpc: "2.0", id, result: { ...reply.result, content: [{ type: "text", text }] } });
    return;
  }

  const reply = await forward(msg);
  if (reply) send(reply);
}

function serve() {
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
      try { msg = JSON.parse(line); } catch { continue; }
      handle(msg).catch((e) => {
        if (msg?.id !== undefined) {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e.message } });
        }
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

/* ── the CLI ───────────────────────────────────────────────────────────── */

function flag(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

async function cli(argv) {
  const [verb, ...rest] = argv;

  if (verb === "--check") {
    process.stderr.write(`Checking ${BASE} …\n`);
    const out = await tool("usage_summary");
    process.stderr.write(`OK — connected.\n${out.split("\n").map((l) => `  ${l}`).join("\n")}\n`);
    return;
  }

  if (verb === "projects") return console.log(await tool("list_projects"));
  if (verb === "usage") return console.log(await tool("usage_summary"));

  if (verb === "ls") {
    return console.log(await tool("list_renders", {
      project: flag(rest, "project"),
      search: flag(rest, "search"),
      status: flag(rest, "status"),
      limit: Number(flag(rest, "limit", 20)),
    }));
  }

  if (verb === "render") {
    const prompt = rest.find((a) => !a.startsWith("--") && rest[rest.indexOf(a) - 1]?.startsWith("--") !== true);
    if (!prompt) throw new Error(`Give me a prompt: particl-mcp.mjs render "a slow dolly …"`);
    const out = await tool("render_shot", {
      prompt,
      project: flag(rest, "project"),
      duration: Number(flag(rest, "duration", 5)),
      resolution: flag(rest, "res", "1080p"),
      ratio: flag(rest, "ratio", "16:9"),
      model: flag(rest, "model", "2.5"),
    });
    console.log(out);
    if (rest.includes("--wait")) {
      const id = out.match(/id: (\S+)/)?.[1];
      if (id) console.log("\n" + await tool("wait_for_render", { id, timeout_seconds: 480 }));
    }
    return;
  }

  if (verb === "get") {
    const id = rest[0];
    if (!id) throw new Error("Which render? particl-mcp.mjs get <id> [--save ./shot.mp4]");
    console.log(await tool("get_render", { id }));
    const save = flag(rest, "save");
    if (save) {
      const { target, mb } = await saveMedia(id, save);
      console.log(`\nSaved ${mb} MB to ${target}`);
    }
    return;
  }

  throw new Error(
    `Unknown command "${verb}". Try: --check | projects | usage | ls | render "…" | get <id>`
  );
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  serve();
} else {
  cli(argv).catch((e) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  });
}
