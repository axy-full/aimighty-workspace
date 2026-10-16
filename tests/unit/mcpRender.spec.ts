import { test, expect } from "@playwright/test";
import { runTool, TOOLS, type SpendPolicy } from "../../lib/mcp";

/**
 * render_shot is a paid call made by an agent over MCP. It is quoted first. Only a person approves spending (owner, 16 Oct 2026), so it starts a render
 * itself only where the workspace allows spending without asking AND the shot is a 480p draft at or under the per-job line: then it is sent with the
 * quote as its ceiling, so it can never bill more than the price it reports, and an optional request_id is its Idempotency-Key, so a client that retries
 * after losing its reply gets the render it started back, never a second one. Any other call is priced and filed for a person. A stubbed workspace API;
 * nothing is billed.
 */
/** The workspace lets small drafts run without asking: Auto, with the per-job line at 200 cr. */
const AUTO: SpendPolicy = { auto: true, lineCredits: 200 };
type Init = { method?: string; body?: unknown; headers?: Record<string, string> };
const FINGERPRINT = "a".repeat(64);
function workspace(quote: Record<string, unknown> = { estimatedCredits: 18, price: 18, unit: "cr", fingerprint: FINGERPRINT }) {
  const calls: { path: string; body?: unknown; key?: string }[] = [];
  const call = async (path: string, init: Init = {}) => {
    calls.push({ path, body: init.body, key: init.headers?.["Idempotency-Key"] });
    if (path === "/api/projects") return { projects: [] };
    if (path === "/api/generate/quote") return quote;
    if (path === "/api/generate") return { id: "gen_1", status: "queued" };
    if (path === "/api/prepared-jobs") return { job: { id: "prep_1" } };
    throw new Error(`unexpected ${path}`);
  };
  return { call, calls };
}

test("render_shot is quoted first and sent with that exact price as its ceiling", async () => {
  const api = workspace();
  const text = await runTool("render_shot", { prompt: "Rain on glass.", duration: 5, resolution: "480p" }, api.call as never, "", {}, AUTO);
  expect(api.calls.map((c) => c.path)).toEqual(["/api/generate/quote", "/api/generate"]);
  /* The render is the very body that was priced, with the price as its ceiling. */
  expect(api.calls[1].body).toEqual({ ...(api.calls[0].body as object), maxCredits: 18, quoteFingerprint: FINGERPRINT });
  expect(text).toContain("price: 18 cr");
  /* A workspace on its own keys is told its vendor's dollars; the ceiling is the same quote's. */
  const own = workspace({ estimatedCredits: 13, price: 0.84, unit: "usd", fingerprint: FINGERPRINT });
  expect(await runTool("render_shot", { prompt: "Rain.", resolution: "480p" }, own.call as never, "", {}, AUTO)).toContain("price: $0.84");
  expect(own.calls[1].body).toMatchObject({ maxCredits: 13 });
});

test("an unusable quote sends nothing", async () => {
  for (const quote of [{ estimatedCredits: -1, price: 1, unit: "cr" }, { price: 18, unit: "cr" }, { estimatedCredits: 1.5, price: 1.5, unit: "cr" }]) {
    const api = workspace(quote);
    await expect(runTool("render_shot", { prompt: "Rain." }, api.call as never, "")).rejects.toThrow("could not be priced");
    expect(api.calls.map((c) => c.path)).toEqual(["/api/generate/quote"]);
  }
});

test("render_shot's optional request_id is its Idempotency-Key, so a retried call returns the render it started", async () => {
  const keyed = workspace();
  await runTool("render_shot", { prompt: "Rain.", resolution: "480p", request_id: "retry-me-01" }, keyed.call as never, "", {}, AUTO);
  expect(keyed.calls.find((c) => c.path === "/api/generate")?.key).toBe("mcp-render:retry-me-01");
  expect(keyed.calls.find((c) => c.path === "/api/generate/quote")?.key).toBeUndefined();
  /* Without one, each call is its own render, as before. */
  const plain = workspace();
  await runTool("render_shot", { prompt: "Rain.", resolution: "480p" }, plain.call as never, "", {}, AUTO);
  expect(plain.calls.find((c) => c.path === "/api/generate")?.key).toBeUndefined();
  /* One the key cannot carry is refused before anything is quoted or sent. */
  for (const bad of ["no spaces allowed", "x".repeat(150), ""]) {
    const refused = workspace();
    await expect(runTool("render_shot", { prompt: "Rain.", request_id: bad }, refused.call as never, "")).rejects.toThrow("request_id");
    expect(refused.calls).toEqual([]);
  }
  /* The contract only grows: the argument is optional and described. */
  const schema = TOOLS.find((t) => t.name === "render_shot")!.inputSchema as { properties: Record<string, { type: string; description: string }>; required: string[] };
  expect(schema.required).toEqual(["prompt"]);
  expect(schema.properties.request_id).toMatchObject({ type: "string" });
  expect(schema.properties.request_id.description).toContain("retried with the same request_id");
});

test("only a person approves: unless the workspace lets 480p drafts run, a call is priced and filed for a person, and /api/generate is never called", async () => {
  /* Ask is the default: no spending setting at all, or one that is not exactly "auto". */
  for (const spend of [undefined, { auto: false, lineCredits: 200 }]) {
    for (const resolution of ["480p", "720p", "1080p"]) {
      const api = workspace();
      const text = await runTool("render_shot", { prompt: "Rain on glass.", duration: 5, resolution, request_id: "ask-01" }, api.call as never, "", {}, spend);
      expect(api.calls.map((c) => c.path), resolution).toEqual(["/api/generate/quote", "/api/prepared-jobs"]);
      expect(text, resolution).toMatch(new RegExp(`^Priced and prepared, not started\\.\\n\\nprice: 18 cr\\nprepared: Seedance 2\\.5 · ${resolution} · 16:9 · 5s\\nprepared job: prep_1\\n\\nThis needs a person's approval: nothing was started or spent`));
      /* The filed job is the shot's words and settings, no price and no approval. */
      expect(api.calls[1].body).toEqual({ prompt: "Rain on glass.", project: undefined, model: "2.5", duration: 5, resolution, ratio: "16:9", audio: false });
      expect(JSON.stringify(api.calls)).not.toMatch(/maxCredits|quoteFingerprint/);
    }
  }
  /* Auto still asks for a hero take (720p, 1080p), and for a draft priced over the per-job line. Only an exact "auto" is Auto. */
  for (const [resolution, credits, line] of [["720p", 18, 200], ["1080p", 18, 200], ["480p", 201, 200]] as const) {
    const api = workspace({ estimatedCredits: credits, price: credits, unit: "cr", fingerprint: FINGERPRINT });
    const text = await runTool("render_shot", { prompt: "Rain.", resolution }, api.call as never, "", {}, { auto: true, lineCredits: line });
    expect(text, `${resolution} ${credits}`).toMatch(/^Priced and prepared, not started\./);
    expect(api.calls.map((c) => c.path), `${resolution} ${credits}`).not.toContain("/api/generate");
  }
  /* A draft at exactly the line starts: the standing setting approves it, at the quote and no higher. */
  const atLine = workspace({ estimatedCredits: 200, price: 200, unit: "cr", fingerprint: FINGERPRINT });
  expect(await runTool("render_shot", { prompt: "Rain.", resolution: "480p" }, atLine.call as never, "", {}, AUTO)).toMatch(/^Rendering started\./);
  expect(atLine.calls.find((c) => c.path === "/api/generate")?.body).toMatchObject({ maxCredits: 200 });
});

test("a token that cannot render is filed for a person unpriced, and a filing the door refuses is said plainly, never claimed", async () => {
  /* A token made to prepare jobs cannot ask the paid door anything: its call is filed. */
  const calls: string[] = [];
  const prepares = async (path: string, init: Init = {}) => {
    calls.push(path);
    if (path === "/api/projects") return { projects: [] };
    if (path === "/api/generate/quote") throw new Error("This token prepares jobs; a person approves each in Particl.");
    if (path === "/api/prepared-jobs") return { job: { id: "prep_9" }, body: init.body };
    throw new Error(`unexpected ${path}`);
  };
  const text = await runTool("render_shot", { prompt: "Rain." }, prepares as never, "", {}, AUTO);
  expect(text).toMatch(/^Prepared, not started\.\n\nprepared: Seedance 2\.5 · 1080p · 16:9 · 5s\nprepared job: prep_9\n\nThis needs a person's approval/);
  expect(calls).toEqual(["/api/generate/quote", "/api/prepared-jobs"]);
  /* If the door will not take it, the first error stands: nothing is said to be filed. */
  const refusing = async (path: string) => {
    if (path === "/api/projects") return { projects: [] };
    if (path === "/api/generate/quote") throw new Error("This token prepares jobs; a person approves each in Particl.");
    throw new Error("Only a token made to prepare jobs files one.");
  };
  await expect(runTool("render_shot", { prompt: "Rain." }, refusing as never, "", {})).rejects.toThrow("This token prepares jobs");
  /* A token made to render (a legacy "Can generate" token) is priced, not started, and told nothing was filed. */
  const render = async (path: string) => {
    if (path === "/api/projects") return { projects: [] };
    if (path === "/api/generate/quote") return { estimatedCredits: 18, price: 18, unit: "cr", fingerprint: FINGERPRINT };
    if (path === "/api/prepared-jobs") throw new Error("Only a token made to prepare jobs files one; a person uses Make.");
    throw new Error(`unexpected ${path}`);
  };
  const out = await runTool("render_shot", { prompt: "Rain." }, render as never, "", {});
  expect(out).toMatch(/^Priced, not started\.\n\nprice: 18 cr\n/);
  expect(out).toContain("Nothing was filed: Only a token made to prepare jobs files one; a person uses Make.");
  expect(out).toContain("A person can make this themselves in Particl");
  expect(out).not.toMatch(/prepared job:|Rendering started/);
});

test("a caller cannot approve: maxCredits (or max_credits) in the arguments is refused before anything is quoted, filed or sent", async () => {
  for (const spend of [undefined, AUTO]) {
    for (const bad of [{ maxCredits: 1 }, { max_credits: 1 }, { maxCredits: 0 }]) {
      const api = workspace();
      await expect(runTool("render_shot", { prompt: "Rain.", resolution: "480p", ...bad }, api.call as never, "", {}, spend)).rejects.toThrow("only a person approves spending");
      expect(api.calls).toEqual([]);
    }
  }
});

test("Auto never starts anything but a 480p take at or under the line: every resolution, model and price, checked together", async () => {
  /* The owner's condition (16 Oct 2026): a 480p take is the draft; Auto may start a draft at or under the per-job line, and nothing else, ever. */
  const line = 200;
  const started: string[] = [], held: string[] = [];
  for (const model of ["2.5", "2.0"]) {
    for (const resolution of ["480p", "720p", "1080p"]) {
      for (const credits of [0, 1, 18, 199, 200, 201, 202, 900, 100000]) {
        for (const auto of [true, false]) {
          const api = workspace({ estimatedCredits: credits, price: credits, unit: "cr", fingerprint: FINGERPRINT });
          const text = await runTool("render_shot", { prompt: "Rain.", model, resolution, request_id: "all-01" }, api.call as never, "", {}, { auto, lineCredits: line });
          const sent = api.calls.some((c) => c.path === "/api/generate");
          const label = `${model} ${resolution} ${credits} cr, ${auto ? "Auto" : "Ask"}`;
          (sent ? started : held).push(label);
          /* A render starts only where Auto is on, the take is the 480p draft, and its price is at or under the line. */
          expect(sent, label).toBe(auto && resolution === "480p" && credits <= line);
          if (sent) expect(api.calls.find((c) => c.path === "/api/generate")?.body, label).toMatchObject({ maxCredits: credits, resolution: "480p" });
          else expect(text, label).toMatch(/^Priced and prepared, not started\./);
        }
      }
    }
  }
  /* The grid is large enough to mean something, and the started ones are exactly the 480p draft at or under the line in Auto. */
  expect(started.length + held.length).toBe(2 * 3 * 9 * 2);
  expect(started.length).toBe(2 * 5);
  expect(started.every((label) => label.includes("480p") && label.includes("Auto"))).toBe(true);
});
