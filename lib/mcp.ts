/**
 * The workspace's tools, described once.
 *
 * These back both connection routes: the remote endpoint at /api/mcp (which
 * Claude and ChatGPT can reach over a URL) and the little stdio bridge people
 * run on their own machine. The handlers deliberately go through the app's own
 * HTTP API carrying the caller's token, rather than reaching into the database
 * — so a tool can never do something the token itself isn't allowed to do, and
 * validation, pricing and the ledger stay in exactly one place.
 */

import { getModel } from "./models";

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const TOOLS: ToolDef[] = [
  {
    name: "render_shot",
    description:
      "Start a video render in Particl. Returns an id immediately — renders take " +
      "roughly one to three minutes — then use wait_for_render to collect it. Every prompt is " +
      "rewritten with ByteDance's Seedance recipe before rendering; prefix with 'raw:' to send " +
      "exact words. This spends real money from the workspace's credit.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The shot: subject, action, setting, camera, light, mood." },
        project: { type: "string", description: "Project name to file it under. Optional." },
        model: { type: "string", description: "'2.5' (default, up to 30s, can do audio) or '2.0' (cheaper)." },
        duration: { type: "number", description: "Seconds. Default 5." },
        resolution: { type: "string", description: "480p | 720p | 1080p. Default 1080p." },
        ratio: { type: "string", description: "16:9 (default), 9:16, 1:1, 4:3, 3:4, 21:9." },
        audio: { type: "boolean", description: "Native audio track. Seedance 2.5 only. Default false." },
        seed: { type: "number", description: "Fix the seed to make a shot reproducible." },
        look: { type: "string", description: "The name of a Look from the studio's library (e.g. 'Tungsten Night') — its style block and reference stills ride along." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "wait_for_render",
    description:
      "Wait for a render to finish and report what it cost. Returns as soon as it succeeds or " +
      "fails, or when the timeout is reached — it keeps rendering either way.",
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
      "Details of one render, including a link to watch or download it. (The stdio bridge can also " +
      "save the file straight to disk when given save_to.)",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The render id." } },
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

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

type Gen = {
  id: string; status: string; prompt: string; kind?: string;
  params?: Record<string, unknown>;
  costUsd?: number | null; refineCostUsd?: number | null;
  authorName?: string | null; error?: string | null;
};

function describe(g: Gen): string {
  const p = (g.params ?? {}) as { resolution?: string; ratio?: string; duration?: number };
  const spec = [p.resolution, p.ratio, p.duration ? `${p.duration}s` : null].filter(Boolean).join(" · ");
  const cost = g.costUsd == null ? "" : ` · ${usd((g.costUsd ?? 0) + (g.refineCostUsd ?? 0))}`;
  return `${g.id} · ${g.status}${spec ? ` · ${spec}` : ""}${cost}\n  ${g.prompt}`;
}

/** Calls the workspace's own API as the caller, so scopes and caps still apply. */
export function makeCaller(origin: string, authorization: string) {
  return async function call(pathname: string, init: { method?: string; body?: unknown } = {}) {
    const res = await fetch(`${origin}${pathname}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: authorization,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try { json = JSON.parse(text); }
    catch { throw new Error(`${res.status} from ${pathname}: ${text.slice(0, 200)}`); }
    if (!res.ok) throw new Error(String(json.error ?? `${res.status} from ${pathname}`));
    return json;
  };
}

type Call = ReturnType<typeof makeCaller>;
type Args = Record<string, string | number | boolean | undefined>;

/** Projects are addressed by name — an agent shouldn't have to juggle ids. */
async function resolveProject(call: Call, nameOrId?: string) {
  if (!nameOrId) return null;
  const { projects } = (await call("/api/projects")) as { projects: { id: string; name: string }[] };
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

export async function runTool(
  name: string, args: Args, call: Call, origin: string
): Promise<string> {
  switch (name) {
    case "render_shot": {
      const project = await resolveProject(call, args.project as string | undefined);
      const model = String(args.model ?? "2.5").includes("2.0")
        ? "dreamina-seedance-2-0-260128"
        : "dreamina-seedance-2-5-260628";
      // The server quietly substitutes a valid value for one it does not
      // offer; a tool must not then report the value it asked for as if it
      // had been used. Refuse up front, naming the options.
      const def = getModel(model);
      const duration = Number(args.duration ?? 5);
      const resolution = String(args.resolution ?? "1080p");
      const ratio = String(args.ratio ?? "16:9");
      if (!def.durations.includes(duration)) {
        throw new Error(`Duration must be one of ${def.durations.join(", ")} seconds for ${def.label}.`);
      }
      if (!def.resolutions.includes(resolution)) {
        throw new Error(`Resolution must be one of ${def.resolutions.join(", ")} for ${def.label}.`);
      }
      if (!def.ratios.includes(ratio)) {
        throw new Error(`Aspect ratio must be one of ${def.ratios.join(", ")} for ${def.label}.`);
      }
      // A Look by name → its id, from what this project can see.
      let lookId: string | null = null;
      if (typeof args.look === "string" && args.look.trim()) {
        const wanted = args.look.trim().toLowerCase();
        const lib = (await call(`/api/presets${project ? `?projectId=${encodeURIComponent(project.id)}` : ""}`)) as
          { presets: { id: string; name: string }[] };
        const hit = lib.presets.find((p) => p.name.toLowerCase() === wanted)
          ?? lib.presets.find((p) => p.name.toLowerCase().includes(wanted));
        if (!hit) throw new Error(`No look called "${args.look}". Looks available: ${lib.presets.map((p) => p.name).join(", ")}.`);
        lookId = hit.id;
      }
      const out = (await call("/api/generate", {
        method: "POST",
        body: {
          prompt: args.prompt,
          lookId,
          model,
          ratio,
          resolution,
          duration,
          generateAudio: Boolean(args.audio),
          seed: args.seed ?? null,
          watermark: false,
          projectId: project?.id ?? null,
        },
      })) as { id: string };
      return (
        `Rendering started.\n\nid: ${out.id}\nproject: ${project?.name ?? "Unfiled"}\n` +
        `model: ${model.includes("2-5") ? "Seedance 2.5" : "Seedance 2.0"} · ` +
        `${resolution} · ${ratio} · ${duration}s\n\n` +
        `Call wait_for_render with this id to collect it.`
      );
    }

    case "wait_for_render": {
      const timeout = Math.min(Math.max(Number(args.timeout_seconds ?? 240), 5), 600) * 1000;
      const started = Date.now();
      let last: Gen | null = null;
      while (Date.now() - started < timeout) {
        const { generation } = (await call(`/api/jobs/${encodeURIComponent(String(args.id))}`)) as { generation: Gen };
        last = generation;
        if (generation.status === "succeeded") {
          return (
            `Done in ${Math.round((Date.now() - started) / 1000)}s.\n\n${describe(generation)}\n\n` +
            `Cost ${usd((generation.costUsd ?? 0) + (generation.refineCostUsd ?? 0))}. ` +
            `Watch or download: ${origin}/api/media/${generation.id}`
          );
        }
        if (generation.status === "failed" || generation.status === "cancelled") {
          return `Render ${generation.status}.\n\n${generation.error ?? "No reason given."}`;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      return (
        `Still ${last?.status ?? "rendering"} after ${Math.round(timeout / 1000)}s — it hasn't failed, ` +
        `just taken longer than we waited. Call wait_for_render again with the same id.`
      );
    }

    case "list_renders": {
      const project = await resolveProject(call, args.project as string | undefined);
      const q = new URLSearchParams({
        limit: String(Math.min(Number(args.limit ?? 20), 60)),
        sync: "0",
      });
      if (project) q.set("projectId", project.id);
      if (args.status) q.set("status", String(args.status));
      if (args.search) q.set("q", String(args.search));
      const { generations } = (await call(`/api/jobs?${q}`)) as { generations: Gen[] };
      if (!generations.length) return "No renders match that.";
      return generations.map(describe).join("\n\n");
    }

    case "get_render": {
      const { generation } = (await call(`/api/jobs/${encodeURIComponent(String(args.id))}`)) as { generation: Gen };
      const link = generation.status === "succeeded"
        ? `\n\nWatch or download: ${origin}/api/media/${generation.id}` +
          `\n(That link needs the same token — it is not public.)`
        : "";
      return `${describe(generation)}${generation.authorName ? `\n  by ${generation.authorName}` : ""}${link}`;
    }

    case "list_projects": {
      const { projects } = (await call("/api/projects")) as {
        projects: { name: string; genCount: number; spend: number }[];
      };
      if (!projects.length) return "No projects yet.";
      return projects
        .map((p) => `${p.name} — ${p.genCount} render${p.genCount === 1 ? "" : "s"} · ${usd(p.spend)}`)
        .join("\n");
    }

    case "create_project": {
      const out = (await call("/api/projects", { method: "POST", body: { name: args.name } })) as { name: string };
      return `Created project "${out.name}".`;
    }

    case "usage_summary": {
      const u = (await call("/api/usage/summary")) as {
        spentUsd: number; purchasedUsd: number; remainingUsd: number; pending: number;
      };
      return (
        `Spent all time: ${usd(u.spentUsd)}\nCredit recorded: ${usd(u.purchasedUsd)}\n` +
        `Remaining: ${usd(u.remainingUsd)}\nRendering now: ${u.pending}`
      );
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
