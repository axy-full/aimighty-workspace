import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { CHECK_BACKOFF_MS, CHECK_LINE, sampleWorkspaceAnswer } from "../../lib/demo/sample";
import { createSampleChecker } from "../../lib/demo/sample-check";

/**
 * The workspace check has three answers, not two. A normal workspace whose GET /api/demo/sample fails is "unknown": its
 * priced controls stay hidden (the server refuses what it cannot clear), but nothing calls it the sample, a neutral
 * line says the check failed, and the check is read again on its own and by a free Try again. The browser proof of a
 * 500 then a 200 is tests/sample-paid-controls-workbench.spec.ts.
 */

test("the check has three answers: only a clear read decides; a failed, refused or unreadable one is unknown, never the sample", () => {
  /* Could not check: no request, 5xx, 401, bad JSON, no body. */
  expect(sampleWorkspaceAnswer(null)).toBe("unknown");
  expect(sampleWorkspaceAnswer({ ok: false, body: null })).toBe("unknown");
  expect(sampleWorkspaceAnswer({ ok: false, body: { sampleWorkspace: false } })).toBe("unknown");
  expect(sampleWorkspaceAnswer({ ok: false, body: { sampleWorkspace: true } })).toBe("unknown");
  expect(sampleWorkspaceAnswer({ ok: true, body: null })).toBe("unknown");
  expect(sampleWorkspaceAnswer({ ok: true, body: "<html>" })).toBe("unknown");
  /* Checked: the flag says so. */
  expect(sampleWorkspaceAnswer({ ok: true, body: { board: null, sampleWorkspace: true } })).toBe("sample");
  expect(sampleWorkspaceAnswer({ ok: true, body: { board: null } })).toBe("normal");
  expect(sampleWorkspaceAnswer({ ok: true, body: { board: null, sampleWorkspace: false } })).toBe("normal");
});

test("the words: a workspace that could not be checked does not say it is the sample", () => {
  expect(CHECK_LINE).toBe("Couldn't check this workspace.");
  expect(CHECK_LINE).not.toMatch(/sample/i);
  expect(CHECK_BACKOFF_MS).toEqual([2_000, 5_000, 15_000]);
  const source = readFileSync("lib/demo/use-sample.ts", "utf8");
  expect(source).toMatch(/state === "sample" \? SAMPLE_LINE : state === "unknown" \? CHECK_LINE : null/);
});

type Answer = "ok-normal" | "ok-sample" | "500" | "401" | "network" | "bad-json";

/** A checker with a fake network and a hand-turned clock: answers are queued, timers are run by the test. */
function harness(answers: Answer[]) {
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  const asked: { url: string; scope: string | null }[] = [];
  let clock = 0;
  const checker = createSampleChecker({
    fetch: async (url, init) => {
      asked.push({ url, scope: (init.headers as Record<string, string> | undefined)?.["X-Workbench-Scope"] ?? null });
      const next = answers.shift() ?? "500";
      if (next === "network") throw new TypeError("Failed to fetch");
      if (next === "500") return new Response(JSON.stringify({ error: "down" }), { status: 500 });
      if (next === "401") return new Response("{}", { status: 401 });
      if (next === "bad-json") return new Response("<html>", { status: 200 });
      return new Response(JSON.stringify(next === "ok-sample" ? { board: null, sampleWorkspace: true } : { board: null }), { status: 200 });
    },
    delays: CHECK_BACKOFF_MS,
    now: () => clock,
    setTimer: (run, ms) => { const t = { run: () => { t.cleared = true; run(); }, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
  });
  const live = () => timers.filter((t) => !t.cleared);
  return { checker, timers, asked, live, tick: (ms: number) => { clock += ms; } };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a normal workspace's check that fails (500, 401, network, bad JSON) is unknown, then retried at 2 s, 5 s and 15 s, then it stops", async () => {
  for (const fail of ["500", "401", "network", "bad-json"] as const) {
    const h = harness([fail, fail, fail, fail, "ok-normal"]);
    expect(h.checker.get("s1").state).toBeNull();
    await h.checker.ensure("s1");
    expect(h.checker.get("s1")).toMatchObject({ state: "unknown", failures: 1 });
    expect(h.live().map((t) => t.ms)).toEqual([2_000]);
    h.live()[0].run(); await settle();
    expect(h.checker.get("s1")).toMatchObject({ state: "unknown", failures: 2 });
    expect(h.timers.map((t) => t.ms)).toEqual([2_000, 5_000]);
    h.timers[1].run(); await settle();
    expect(h.timers.map((t) => t.ms)).toEqual([2_000, 5_000, 15_000]);
    h.timers[2].run(); await settle();
    /* Four reads failed in a row: no fourth wait is set, and the fifth answer is not asked for. */
    expect(h.asked).toHaveLength(4);
    expect(h.checker.get("s1")).toMatchObject({ state: "unknown", failures: 4 });
    expect(h.timers).toHaveLength(3);
    /* Asking again straight after does not start another run of reads. */
    await h.checker.ensure("s1");
    expect(h.asked).toHaveLength(4);
  }
});

test("a retry that succeeds restores the answer and stops retrying; the person's Try again reads now and starts the waits over", async () => {
  const h = harness(["500", "ok-normal", "500", "500", "ok-sample"]);
  await h.checker.ensure("s2");
  expect(h.checker.get("s2").state).toBe("unknown");
  h.live()[0].run(); await settle();
  expect(h.checker.get("s2")).toMatchObject({ state: "normal", failures: 0 });
  expect(h.live()).toHaveLength(0);
  /* A later failure fails closed again, with its own first wait. */
  h.tick(20_000);
  await h.checker.ensure("s2");
  expect(h.checker.get("s2").state).toBe("unknown");
  expect(h.live().map((t) => t.ms)).toEqual([2_000]);
  /* Try again: reads now (the pending wait is cancelled), and what it hears decides. */
  const waiting = h.live()[0];
  await h.checker.retry("s2");
  expect(waiting.cleared).toBe(true);
  expect(h.checker.get("s2")).toMatchObject({ state: "unknown", failures: 1 });
  await h.checker.retry("s2");
  expect(h.checker.get("s2").state).toBe("sample");
  expect(h.live()).toHaveLength(0);
});

test("a screen that mounts after the automatic reads ran out starts them over", async () => {
  const h = harness(["500", "500", "500", "500", "ok-normal"]);
  await h.checker.ensure("s3");
  for (let i = 0; i < 3; i++) { h.live()[0].run(); await settle(); }
  expect(h.checker.get("s3")).toMatchObject({ state: "unknown", failures: 4 });
  expect(h.live()).toHaveLength(0);
  /* A moment later: nothing. Later than the check is kept: one read, which here answers. */
  await h.checker.ensure("s3");
  expect(h.asked).toHaveLength(4);
  h.tick(16_000);
  await h.checker.ensure("s3");
  expect(h.checker.get("s3").state).toBe("normal");
});

test("the check is kept per scope and shared: two asks at once are one read; a good answer is kept for 15 s", async () => {
  const h = harness(["ok-normal", "ok-sample", "ok-normal"]);
  await Promise.all([h.checker.ensure("a"), h.checker.ensure("a")]);
  expect(h.asked).toHaveLength(1);
  expect(h.asked[0].scope).toBe("a");
  await h.checker.ensure("b");
  expect(h.checker.get("a").state).toBe("normal");
  expect(h.checker.get("b").state).toBe("sample");
  await h.checker.ensure("a");
  expect(h.asked).toHaveLength(2);
  h.tick(16_000);
  await h.checker.ensure("a");
  expect(h.asked).toHaveLength(3);
});

test("the hook reads the shared check and fails closed on every failure", () => {
  const source = readFileSync("lib/demo/use-sample.ts", "utf8");
  expect(source).toMatch(/useSyncExternalStore\(sampleChecker\.subscribe/);
  expect(source).toMatch(/sampleChecker\.ensure\(scope\)/);
  const store = readFileSync("lib/demo/sample-check.ts", "utf8");
  expect(store).toMatch(/sampleWorkspaceAnswer\(\{ ok: res\.ok/);
  expect(store).toMatch(/\} catch \{\n\s+answer = sampleWorkspaceAnswer\(null\);/);
  expect(store).not.toMatch(/\.catch\(\(\) => false\)/);
});

/* Where the neutral line is shown, it has a free Try again beside it. */
for (const file of [
  "components/graphite/home/StartFooter.tsx", "components/graphite/atomik/panel/AtomikPanel.tsx", "components/graphite/atomik/panel/PaletteCards.tsx",
  "components/graphite/atomik/panel/PaletteApprove.tsx", "components/graphite/board/BoardView.tsx", "components/graphite/make/Compose.tsx",
  "components/graphite/viral/ViralView.tsx", "components/graphite/phone/AtomikSheet.tsx", "components/graphite/phone/PlanScreen.tsx",
  "components/graphite/phone/RecordScreen.tsx", "components/graphite/phone/HomeScreen.tsx", "components/graphite/control-room/ApprovalRow.tsx",
]) {
  test(`${file.split("/").pop()}: the neutral line has a Try again`, () => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/CHECK_LINE/);
    expect(source).toMatch(/<CheckAgain /);
  });
}

/* The review's L1 and L2: no dead priced button, and the free Not now stays. */
test("L1: a sample item's Render on a board's Atomik lines is never pressable", () => {
  const source = readFileSync("components/graphite/board/agent/AgentLines.tsx", "utf8");
  expect(source).toMatch(/const tapOk = waiting && !!item && item\.canApprove && !item\.sample;/);
});

test("L1: the phone's plan has no priced Approve when nothing spends, and its Record shows a decision without a price or a way to approve", () => {
  const plan = readFileSync("components/graphite/phone/PlanScreen.tsx", "utf8");
  expect(plan).toMatch(/spendOff\?: string \| null/);
  expect(plan).toMatch(/const approve = spendOff \? null : model\.primary;/);
  expect(plan).toMatch(/const short = !spendOff && proposal/);
  expect(plan).toMatch(/\{spendOff \? null : <button type="button" className="ph-btn" onClick=\{onChange\}/);
  const app = readFileSync("components/graphite/phone/PhoneApp.tsx", "utf8");
  expect(app).toMatch(/<PlanScreen [^\n]*spendOff=\{spendOff \?\? /);
  expect(app).toMatch(/<RecordScreen [^\n]*spendOff=\{spendOff\}/);
  const record = readFileSync("components/graphite/phone/RecordScreen.tsx", "utf8");
  expect(record).toMatch(/const off = Boolean\(spendOff\) \|\| item\.sample;/);
  expect(record).toMatch(/item\.price && !off \?/);
  expect(record).toMatch(/\{!off && item\.approve\?\.kind === "board-approve" \? <button/);
});

test("L2: the control room's row keeps its free Not now for a sample item; Approve stays out", () => {
  const source = readFileSync("components/graphite/control-room/ApprovalRow.tsx", "utf8");
  const decline = source.indexOf('data-testid="approval-not-now"');
  const sample = source.indexOf("{item.sample ? (");
  const approve = source.indexOf('data-testid="approval-approve"');
  expect(decline).toBeGreaterThan(-1);
  /* Not now is drawn before, and outside, the sample branch; Approve is inside the other side of it. */
  expect(decline).toBeLessThan(sample);
  expect(approve).toBeGreaterThan(sample);
  expect(source).toMatch(/\{item\.decline && !thread \? \(/);
});
