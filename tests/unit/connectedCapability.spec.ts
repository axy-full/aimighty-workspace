import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import {
  ACCOUNT_RETIRED, ALTERNATIVE_LABEL, CONNECTED_PROVIDER, HISTORY_KEPT, OWNER_RUNS, OWNER_RUN_SUITES,
  alternativePrice, castStillPrompt, isOwnerRunSuite, ownerRunEyebrow,
} from "../../lib/shell/connected-capability";
import { markConnectedCapability, settleConnectedCapability } from "../../lib/shell/use-connected-capability";
import { SIGN_IN_RETIRED, SIGN_IN_RETIRED_MESSAGE } from "../../lib/higgsfield-consumer/retired";
import { SHELL_SUITES } from "../../lib/shell/ia";
import { INITIAL_COMPOSER, activeModel, workspaceModels, type EngineRow } from "../../lib/workspace/composer";
import { rowPrice } from "../../lib/workspace/model-picker";

/**
 * The retired Higgsfield sign-in (lib/higgsfield-consumer/retired.ts), as the
 * shell says it. Nobody runs the connected account: the capability answers
 * "member" for everyone and reads nothing, the pages that ran there meet one
 * card with the way to make the same kind of thing on this workspace's
 * credits, and Workspace › Engines keeps only the owner's Disconnect and the
 * running jobs to set aside.
 */

test("the words everyone meets since the sign-in was retired: what ran on the account, that Particl no longer signs in, no owner name, and the workspace-credit way", () => {
  expect(CONNECTED_PROVIDER).toBe("Higgsfield");
  expect(ACCOUNT_RETIRED).toBe("Particl no longer signs in to Higgsfield");
  expect(HISTORY_KEPT).toBe("Past results stay in your Library.");
  /* The card and the routes say the same thing. */
  expect(`${ACCOUNT_RETIRED}. ${HISTORY_KEPT}`).toBe(SIGN_IN_RETIRED_MESSAGE);
  expect(OWNER_RUNS.business.alternative).toMatchObject({ type: "image", action: "Open Gen · Images" });
  expect(OWNER_RUNS.viral.alternative).toMatchObject({ type: "video", action: "Open Gen · Video" });
  expect(OWNER_RUNS.cast.alternative).toMatchObject({ type: "image", action: "Open Gen · Images" });
  expect(OWNER_RUNS.cast.alternative?.what).toContain("Studio image engines");
  /* Dubbing, voice change and social cuts have no Studio engine that makes the same thing: no alternative is invented. */
  expect(OWNER_RUNS.workflows.alternative).toBeNull();
  expect(ownerRunEyebrow("workflows", ["Dub", "Change voice"])).toBe("Dub · Change voice");
  expect(ownerRunEyebrow("business")).toBe(OWNER_RUNS.business.eyebrow);
  expect(ALTERNATIVE_LABEL).toBe("On this workspace’s credits");
  for (const run of Object.values(OWNER_RUNS)) {
    /* One short line each, in the past tense, never a connect prompt, never who runs it, never the account's credits. */
    expect(run.line.split(". ").length).toBe(1);
    expect(run.line).toMatch(/ ran on a signed-in Higgsfield account\.$/);
    for (const words of [run.line, run.eyebrow, run.alternative?.what ?? ""]) expect(words).not.toMatch(/\bConnect (it|the|one)\b|Engines ›|Workspace ›|connected cr|Higgsfield credits|\bbalance\b|\brun by\b|\bowner\b/i);
  }
  expect(OWNER_RUN_SUITES).toEqual(["business", "viral"]);
  expect(isOwnerRunSuite("business") && isOwnerRunSuite("viral")).toBe(true);
  expect(isOwnerRunSuite("studio") || isOwnerRunSuite("gen") || isOwnerRunSuite("atomik") || isOwnerRunSuite(null)).toBe(false);
  /* The state layer's suites behind them: Moleculr's and Subatomik's pages. */
  expect(SHELL_SUITES.filter((suite) => OWNER_RUN_SUITES.includes(suite.id)).map((suite) => suite.legacy).sort()).toEqual(["moleculr", "subatomik"]);
});

test("the alternative is priced exactly as Gen's sheet prices it: the composer's own default engine, at the project's aspect, whole credits", () => {
  const rows: EngineRow[] = [
    { id: "gpt-image-2", kind: "image", resolutions: ["1024"], ratios: ["1:1", "16:9", "9:16"], durations: [], rate: { credits: 4, resolution: "1024", ratio: "9:16", duration: null } },
    { id: "dreamina-seedance-2-5-260628", kind: "video", resolutions: ["720p", "1080p"], ratios: ["16:9", "9:16"], durations: [5, 10], rate: { credits: 45, resolution: "720p", ratio: "9:16", duration: 5 } },
    { id: "soul-identity", kind: "image", resolutions: ["1024"], ratios: ["1:1"], durations: [], soulIdentity: true },
  ];
  const models = workspaceModels(rows, null);
  const image = activeModel({ ...INITIAL_COMPOSER, type: "image", chosen: {} }, models)!;
  expect(image.id).toBe("gpt-image-2");
  const at = { aspect: "9:16", picks: {}, references: [], seconds: 10, takes: 1 };
  const price = rowPrice(image, at);
  expect(price).toMatchObject({ credits: 4, unit: "cr" });
  expect(alternativePrice(image.label, price)).toBe(`${image.label} · 4 cr · 1024 · 9:16`);
  const video = activeModel({ ...INITIAL_COMPOSER, type: "video", chosen: {} }, models)!;
  expect(alternativePrice(video.label, rowPrice(video, at))).toBe(`${video.label} · 45 cr · 5 s · 720p · 9:16`);
  /* A rate read at other settings is not this price: nothing is shown rather than a guess. */
  expect(alternativePrice(image.label, rowPrice(image, { ...at, aspect: "1:1" }))).toBeNull();
  expect(alternativePrice("Any", null)).toBeNull();
  expect(alternativePrice("Big", { credits: 1250, unit: "cr", detail: "" })).toBe("Big · 1,250 cr");
});

test("a cast entry's still is made from its prompt, else its description, else its name", () => {
  expect(castStillPrompt({ name: "Fox", description: "A red fox", prompt: "  A red fox on ice at dusk " })).toBe("A red fox on ice at dusk");
  expect(castStillPrompt({ name: "Fox", description: " A red fox ", prompt: "" })).toBe("A red fox");
  expect(castStillPrompt({ name: " Fox ", description: "", prompt: " " })).toBe("Fox");
  expect(castStillPrompt({ name: "", description: "", prompt: "" })).toBe("");
});

test("the capability answers member for everyone, the owner included, and reads nothing: no store, no connection read, no collector", () => {
  expect(SIGN_IN_RETIRED).toBe(true);
  const hook = readFileSync("lib/shell/use-connected-capability.ts", "utf8");
  expect(hook).toContain('owner: false, status: "member" as const, connected: false');
  expect(hook).not.toMatch(/fetch\(|createCapabilityStore|CONNECTION_ENDPOINT|session\.owner/);
  /* A surface's own read has nothing to be tied to, and settles nothing. */
  expect(markConnectedCapability("particl-active-w-u")).toBeUndefined();
  expect(settleConnectedCapability("particl-active-w-u", { connected: true, requiresReconnect: false }, 0)).toBe(false);
  /* The shell's collector is gone with the sign-in: the shell mounts none, and its hook is deleted. */
  expect(readFileSync("lib/shell/state.tsx", "utf8")).not.toMatch(/useConnectedCollector|connected-collector/);
  expect(existsSync("lib/shell/use-connected-collector.ts")).toBe(false);
});

test("Gen's composer reads nothing of the account; Business and Viral decide ownership from the session, once; Engines never starts a sign-in", () => {
  const composer = readFileSync("lib/workspace/use-composer.ts", "utf8");
  expect(composer).not.toMatch(/useConnectedCapability|higgsfield-consumer|\/api\/higgsfield\/consumer|connected-collector/);
  for (const file of ["lib/shell/use-business.ts", "lib/shell/use-viral.ts"]) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toContain("/api/me");
    expect(source, file).toContain("useConnectedCapability");
  }
  expect(readFileSync("lib/shell/use-business.ts", "utf8")).not.toContain("/api/higgsfield/consumer/connection");
  /* Engines is the one place that still reads the owner's connection: to list running jobs and to Disconnect. It never starts a sign-in. */
  const row = readFileSync("components/graphite/ConnectedAccountRow.tsx", "utf8");
  expect(row).toContain("CONNECTION_ENDPOINT");
  expect(row).toContain('method: "DELETE"');
  expect(row).not.toMatch(/consumer\/connect"|consumerAuthorizeUrl|"Reconnect|Opening sign-in|window\.location\.assign/);
});

/* ── Atomik › Tools & connections reaches no signed-in account ── */

test("Tools & connections checks no connected account: it reads no capability, reach or connection route", () => {
  const source = readFileSync("components/graphite/atomik/ToolsView.tsx", "utf8");
  expect(source).not.toContain("useConnectedCapability");
  expect(source).not.toContain("/api/higgsfield/consumer/");
  expect(source).not.toMatch(/session\.(owner|requestScope)/);
});
