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

import { displayModelName, getModel } from "./models";

/**
 * The longest wait_for_render may hold its request open. The route ends at
 * 300 seconds (app/api/mcp/route.ts › maxDuration), and a request killed
 * there answers with a platform error page instead of a reply the client can
 * read, so the wait stops well short of it and says "call again".
 */
export const WAIT_MAX_SECONDS = 270;
export const WAIT_DEFAULT_SECONDS = 240;
/** How long one wait_for_render call waits: what was asked for, within 5 seconds and WAIT_MAX_SECONDS. */
export function waitSeconds(requested: unknown): number {
  const asked = Number(requested ?? WAIT_DEFAULT_SECONDS);
  return Math.min(Math.max(Number.isFinite(asked) ? asked : WAIT_DEFAULT_SECONDS, 5), WAIT_MAX_SECONDS);
}

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
      "rewritten with Seedance's own prompt recipe before rendering; prefix with 'raw:' to send " +
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
        timeout_seconds: { type: "number", description: `How long to wait. Default ${WAIT_DEFAULT_SECONDS}, max ${WAIT_MAX_SECONDS}; if it is still rendering, call again.` },
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
  id: string; status: string; prompt: string; title?: string | null; kind?: string;
  params?: Record<string, unknown>;
  costUsd?: number | null; refineCostUsd?: number | null;
  authorName?: string | null; error?: string | null;
};

function describe(g: Gen): string {
  const p = (g.params ?? {}) as { resolution?: string; ratio?: string; duration?: number };
  const spec = [p.resolution, p.ratio, p.duration ? `${p.duration}s` : null].filter(Boolean).join(" · ");
  const cost = g.costUsd == null ? "" : ` · ${usd((g.costUsd ?? 0) + (g.refineCostUsd ?? 0))}`;
  const name = g.title ? `${g.title} · ` : "";
  return `${name}${g.id} · ${g.status}${spec ? ` · ${spec}` : ""}${cost}\n  ${g.prompt}`;
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

/**
 * Projects are addressed by name — an agent shouldn't have to juggle ids.
 *
 * An id or an exact name (any case) is taken as it is. A partial name is only
 * a guess, so it is taken for reading when it names exactly one project, and
 * never for a paid render: filing a render under a production nobody named
 * would spend against the wrong cap. Then the candidates are named instead.
 */
async function resolveProject(call: Call, nameOrId: string | undefined, use: "read" | "spend") {
  if (!nameOrId) return null;
  const { projects } = (await call("/api/projects")) as { projects: { id: string; name: string }[] };
  const want = String(nameOrId).trim().toLowerCase();
  const byId = projects.find((p) => p.id === nameOrId);
  if (byId) return byId;
  const exact = projects.filter((p) => p.name.trim().toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  const list = (items: { id: string; name: string }[]) => items.map((p) => `"${p.name}" (${p.id})`).join(", ");
  if (exact.length > 1) throw new Error(`More than one project is called "${nameOrId}": ${list(exact)}. Give the project id.`);
  const partial = want ? projects.filter((p) => p.name.toLowerCase().includes(want)) : [];
  if (partial.length === 1 && use === "read") return partial[0];
  if (partial.length) throw new Error(`No project is called exactly "${nameOrId}". Did you mean ${list(partial.slice(0, 8))}? Give the exact name or id.`);
  throw new Error(
    `No project called "${nameOrId}". Existing: ${projects.map((p) => p.name).join(", ") || "none yet"}.`
  );
}

export async function runTool(
  name: string, args: Args, call: Call, origin: string
): Promise<string> {
  switch (name) {
    case "render_shot": {
      const project = await resolveProject(call, args.project as string | undefined, "spend");
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
      const out = (await call("/api/generate", {
        method: "POST",
        body: {
          prompt: args.prompt,
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
        `model: ${displayModelName(model)} · ` +
        `${resolution} · ${ratio} · ${duration}s\n\n` +
        `Call wait_for_render with this id to collect it.`
      );
    }

    case "wait_for_render": {
      const timeout = waitSeconds(args.timeout_seconds) * 1000;
      const started = Date.now(), deadline = started + timeout;
      let last: Gen | null = null;
      for (;;) {
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
        /* The last pause never runs past the deadline: the reply has to leave before the route is ended. */
        const left = deadline - Date.now();
        if (left <= 0) break;
        await new Promise((r) => setTimeout(r, Math.min(5000, left)));
      }
      return (
        `Still ${last?.status ?? "rendering"} after ${Math.round(timeout / 1000)}s — it hasn't failed, ` +
        `just taken longer than we waited. Call wait_for_render again with the same id.`
      );
    }

    case "list_renders": {
      const project = await resolveProject(call, args.project as string | undefined, "read");
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
      /* In the workspace's unit: a workspace on credits is told credits, never the vendor's dollars. */
      const { projects, unit } = (await call("/api/projects")) as {
        projects: { name: string; genCount: number; spend: number; credits?: number }[]; unit?: "cr" | "usd";
      };
      if (!projects.length) return "No projects yet.";
      return projects
        .map((p) => `${p.name} — ${p.genCount} render${p.genCount === 1 ? "" : "s"} · ${unit === "cr" ? `${Math.round(p.credits ?? 0).toLocaleString("en-US")} credits` : usd(p.spend)}`)
        .join("\n");
    }

    case "create_project": {
      const out = (await call("/api/projects", { method: "POST", body: { name: args.name } })) as { name: string };
      return `Created project "${out.name}".`;
    }

    case "usage_summary": {
      const u = (await call("/api/usage/summary")) as {
        spentUsd: number; purchasedUsd: number; remainingUsd: number; pending: number; unit?: "credits"; spentCredits?: number; credits?: {granted:number;used:number;balance:number};
      };
      if(u.unit==='credits'&&u.credits)return `Spent all time: ${u.spentCredits??u.credits.used} cr\nCredit recorded: ${u.credits.granted} cr\nRemaining: ${u.credits.balance} cr\nRendering now: ${u.pending}`;
      return (
        `Spent all time: ${usd(u.spentUsd)}\nCredit recorded: ${usd(u.purchasedUsd)}\n` +
        `Remaining: ${usd(u.remainingUsd)}\nRendering now: ${u.pending}`
      );
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
