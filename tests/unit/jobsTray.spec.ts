import { test, expect } from "@playwright/test";
import {
  ACTION_LABEL, TRAY_LIMIT, accountTrayJob, active, engineTrayJob, inFlight, parseTrayReply, priceLabel, statusFilter,
  trayOrder, traySummary, withComposerSlot, type AccountRow, type EngineRow, type TrayJob,
} from "../../lib/jobsTray";

/**
 * The header's jobs tray (lib/jobsTray): stored rows from both engines become
 * tray rows with their real stage, the approved price and one action; the
 * browser orders and counts them and folds in the composer's just-pressed
 * Generate. Nothing here reads a database or the network.
 */
const T0 = 1_760_000_000_000;
const MIN = 60_000;

function engine(fields: Partial<EngineRow> & { id: string; status: string }): EngineRow {
  return {
    kind: "video", model: "dreamina-seedance-2-5-260628", prompt: "A slow push-in on a lighthouse at dusk", title: null,
    params: {}, storedUrl: null, error: null, creditsBilled: null, costUsd: null, shotCode: null, shotTitle: null,
    task: "generate", createdAt: T0, updatedAt: T0, projectName: "Harbour launch spot", ...fields,
  };
}
function account(fields: Partial<AccountRow> & { id: string; status: string }): AccountRow {
  return {
    draftId: "draft-1", workflow: "generation", quoteCredits: 40, failureCode: null, createdAt: T0, updatedAt: T0,
    hasReceipt: false, setAside: false, prompt: "Product spins on a marble plinth", composer: null, modelId: "seedance_2_0",
    outputType: "video", toolLabel: null, originalId: null, originalKind: null, projectName: "Harbour launch spot", ...fields,
  };
}
const CR = { unit: "cr" as const, inFlight: 13, heldNeeds: null };

test("GET /api/jobs keeps one status as it was and reads a comma list as any of them", () => {
  expect(statusFilter(null)).toEqual({});
  expect(statusFilter("succeeded")).toEqual({ status: "succeeded" });
  expect(statusFilter("all")).toEqual({ status: "all" });
  expect(statusFilter("queued,running,held")).toEqual({ statuses: ["queued", "running", "held"] });
  expect(statusFilter(" queued , queued,held,")).toEqual({ statuses: ["queued", "held"] });
  expect(statusFilter("held,")).toEqual({ status: "held" });
  expect(statusFilter(",")).toEqual({});
});

test("a take on Particl's engines reads its real stage and the price it was approved at", () => {
  expect(engineTrayJob(engine({ id: "q", status: "queued" }), CR)).toMatchObject({ stage: "queued", label: "Queued", tone: "blue", price: { amount: 13, unit: "cr" }, action: null, progress: null });
  expect(engineTrayJob(engine({ id: "r", status: "running" }), CR)).toMatchObject({ stage: "rendering", label: "Rendering", price: { amount: 13, unit: "cr" } });

  const held = engineTrayJob(engine({ id: "h", status: "held", params: { held: { why: "credits", needs: 40, estUsd: 2.86 } } }), { unit: "cr", inFlight: 43, heldNeeds: 43 });
  expect(held).toMatchObject({ stage: "held", label: "Held · needs 43 cr", tone: "amber", action: "release", price: { amount: 43, unit: "cr" } });
  /* Waiting for a slot starts on its own: nothing to press. */
  expect(engineTrayJob(engine({ id: "s", status: "held", params: { held: { why: "slots" } } }), CR)).toMatchObject({ stage: "queued", label: "Held · waiting for a slot", action: null });
  /* A release refused for a reason of its own says it. */
  expect(engineTrayJob(engine({ id: "c", status: "held", error: "The shot is at its cap.", params: { held: { why: "credits" } } }), { unit: "cr", inFlight: 7, heldNeeds: 7 }).reason).toBe("The shot is at its cap.");

  const done = engineTrayJob(engine({ id: "gen_ok", status: "succeeded", storedUrl: "blob:x", creditsBilled: 29, updatedAt: T0 + 5 * MIN }), { unit: "cr", inFlight: null, heldNeeds: null });
  expect(done).toMatchObject({ stage: "complete", label: "Complete", tone: "green", action: "open", mediaUrl: "/api/media/gen_ok", price: { amount: 29, unit: "cr" } });
  expect(engineTrayJob(engine({ id: "a1", kind: "audio", status: "succeeded", storedUrl: "blob:x" }), CR).mediaUrl).toBeNull();

  /* On its own keys the workspace sees its own dollars. */
  expect(engineTrayJob(engine({ id: "u", status: "running" }), { unit: "usd", inFlight: 0.84, heldNeeds: null }).price).toEqual({ amount: 0.84, unit: "usd" });
});

test("a failed take says whether it was billed and why, and carries its own recipe for Recreate", () => {
  const failed = engineTrayJob(engine({
    id: "f", status: "failed", error: "Upstream 503 from fal.ai", creditsBilled: 0, title: "Lighthouse v2",
    params: { rawPrompt: "lighthouse", ratio: "16:9", resolution: "1080p", duration: 5, references: [{ genId: "g1", role: "first_frame" }], held: { estUsd: 1.2 }, paidClaim: 1 },
  }), { unit: "cr", inFlight: null, heldNeeds: null });
  expect(failed).toMatchObject({ stage: "failed", label: "Failed · not billed", tone: "red", action: "recreate", price: null, name: "Lighthouse v2" });
  /* The raw error named a vendor: the product's own sentence instead. */
  expect(failed.reason).toBe("The engine hit an error; nothing was charged for a failure.");
  /* Only what Gen needs to make it again — never the held estimate or recovery state. */
  expect(failed.recipe?.params).toEqual({ rawPrompt: "lighthouse", ratio: "16:9", resolution: "1080p", duration: 5, references: [{ genId: "g1", role: "first_frame" }] });
  expect(JSON.stringify(failed)).not.toContain("estUsd");

  expect(engineTrayJob(engine({ id: "b", status: "failed", error: "Stopped by the director", creditsBilled: 4 }), { unit: "cr", inFlight: null, heldNeeds: null }))
    .toMatchObject({ label: "Failed", reason: "Stopped by the director", price: { amount: 4, unit: "cr" } });
  expect(engineTrayJob(engine({ id: "x", status: "cancelled" }), CR)).toMatchObject({ label: "Cancelled · not billed", reason: null, action: "recreate" });
  expect(engineTrayJob(engine({ id: "rf", status: "failed", error: "Refused by the safety filter" }), CR).reason).toBe("The engine refused this prompt.");
});

test("a take's name is its title, then its shot, then its own words, never empty", () => {
  expect(engineTrayJob(engine({ id: "1", status: "queued", title: "Hero wide" }), CR).name).toBe("Hero wide");
  expect(engineTrayJob(engine({ id: "2", status: "queued", shotCode: "S01", shotTitle: "Harbour at dawn" }), CR).name).toBe("S01 · Harbour at dawn");
  expect(engineTrayJob(engine({ id: "3", status: "queued", params: { rawPrompt: "  gulls  over the pier " } }), CR).name).toBe("gulls over the pier");
  expect(engineTrayJob(engine({ id: "4", status: "queued", prompt: "" }), CR).name).toBe("Untitled take");
  const long = engineTrayJob(engine({ id: "5", status: "queued", prompt: "word ".repeat(40) }), CR).name;
  expect(long.length).toBeLessThanOrEqual(60);
  expect(long.endsWith("…")).toBe(true);
});

test("a connected-account job reads its stage from the account's own record", () => {
  expect(accountTrayJob(account({ id: "a", status: "accepted" }))).toMatchObject({ source: "account", stage: "rendering", label: "Rendering", price: { amount: 40, unit: "account-cr" }, action: null });
  expect(accountTrayJob(account({ id: "u", status: "uncertain", hasReceipt: true }))).toMatchObject({ stage: "confirming", label: "Confirming", tone: "amber" });
  /* Nothing a read can move: said as it is, and not counted as running. */
  const stuck = accountTrayJob(account({ id: "d", status: "dispatching" }));
  expect(stuck).toMatchObject({ stage: "unconfirmed", label: "Not confirmed · never sent twice" });
  expect(active(stuck)).toBe(false);
  expect(accountTrayJob(account({ id: "s", status: "accepted", setAside: true }))).toMatchObject({ stage: "unconfirmed" });

  expect(accountTrayJob(account({ id: "c", status: "completed", originalId: "gen_hfc_" + "a".repeat(40), originalKind: "video" })))
    .toMatchObject({ stage: "complete", action: "open", mediaUrl: `/api/media/gen_hfc_${"a".repeat(40)}`, kind: "video" });

  const refused = accountTrayJob(account({ id: "f", status: "failed", failureCode: "provider_failed" }));
  expect(refused).toMatchObject({ stage: "failed", label: "Failed · not billed", price: null, action: "recreate" });
  expect(refused.recipe).toEqual({ prompt: "Product spins on a marble plinth", model: "seedance_2_0", kind: "video", title: null, task: null, params: {}, connected: true });
  /* Finished on the account but not kept: it may have been billed, so the figure stays. */
  expect(accountTrayJob(account({ id: "k", status: "failed", failureCode: "invalid_result" }))).toMatchObject({ label: "Not kept · receipt saved", price: { amount: 40, unit: "account-cr" } });
  expect(accountTrayJob(account({ id: "v", status: "failed", workflow: "genjutsu" })).action).toBe("viral");
  expect(accountTrayJob(account({ id: "m", status: "failed", workflow: "marketing-video", prompt: null })).action).toBe("business");
  expect(accountTrayJob(account({ id: "n", status: "accepted", workflow: "genjutsu", prompt: null, outputType: null })).name).toBe("Motion transfer");
});

const row = (id: string, stage: TrayJob["stage"], createdAt: number, updatedAt = createdAt): TrayJob => ({
  id, source: "engine", kind: "video", name: id, mediaUrl: null, stage, label: stage, tone: "blue", reason: null, progress: null,
  createdAt, updatedAt, price: null, draftId: null, projectName: null, action: null, recipe: null,
});

test("held comes first, then what runs (newest first), then what finished (latest first)", () => {
  const order = trayOrder([
    row("done-old", "complete", T0, T0 + 1 * MIN), row("run-old", "rendering", T0), row("held", "held", T0 - 9 * MIN),
    row("fail-new", "failed", T0, T0 + 3 * MIN), row("run-new", "rendering", T0 + 2 * MIN), row("queued", "queued", T0 + 4 * MIN),
    row("run-new", "rendering", T0 + 2 * MIN),
  ]).map((j) => j.id);
  expect(order).toEqual(["held", "run-new", "run-old", "queued", "fail-new", "done-old"]);
  expect(trayOrder(Array.from({ length: 40 }, (_, i) => row(`r${i}`, "rendering", T0 + i)))).toHaveLength(TRAY_LIMIT);
});

test("the composer's just-pressed Generate shows until the read has its row", () => {
  const listed = [row("job-1", "rendering", T0)];
  const pending = withComposerSlot(listed, { id: "pending:composer", name: "Lighthouse", label: "Submitting" }, T0);
  expect(pending.map((j) => [j.id, j.stage])).toEqual([["pending:composer", "submitting"], ["job-1", "rendering"]]);
  expect(withComposerSlot(listed, { id: "job-2", name: "Pier", label: "Queued" }, T0)[0]).toMatchObject({ id: "job-2", stage: "queued", name: "Pier" });
  expect(withComposerSlot(listed, { id: "job-3", name: "Pier", label: "Held · needs credits" }, T0)[0]).toMatchObject({ stage: "held", tone: "amber" });
  expect(withComposerSlot(listed, { id: "job-4", name: "Pier", label: "Complete", tone: "green" }, T0)[0]).toMatchObject({ stage: "complete" });
  /* Once listed, the server's row wins. */
  expect(withComposerSlot(listed, { id: "job-1", name: "Other words", label: "Queued" }, T0)).toEqual(listed);
  expect(withComposerSlot(listed, null, T0)).toEqual(listed);
});

test("the pill says what runs and what waits on you, then what finished since the tray was opened", () => {
  const jobs = [row("a", "rendering", T0), row("b", "queued", T0), row("c", "submitting", T0), row("h", "held", T0), row("d", "complete", T0, T0 + MIN)];
  expect(traySummary(jobs, 0)).toMatchObject({ rendering: 3, held: 1, text: "3 rendering · 1 held", short: "4", tone: "blue" });
  expect(traySummary([row("h", "held", T0)], 0)).toMatchObject({ text: "1 held", short: "1", tone: "amber" });
  const settled = [row("d1", "complete", T0, T0 + 2 * MIN), row("d2", "complete", T0, T0 + 3 * MIN), row("f", "failed", T0, T0 + 4 * MIN), row("old", "complete", T0, T0 - MIN)];
  expect(traySummary(settled, T0)).toMatchObject({ done: 2, failed: 1, text: "2 done · 1 failed", short: "3", tone: "red" });
  expect(traySummary(settled, T0 + 10 * MIN)).toBeNull();
  expect(traySummary([row("u", "unconfirmed", T0)], 0)).toBeNull();
  expect(inFlight(row("q", "queued", T0))).toBe(true);
  expect(inFlight(row("h", "held", T0))).toBe(false);
});

test("prices read in credits, dollars on a workspace's own keys, and the account's credits for a connected job", () => {
  expect(priceLabel({ amount: 1250, unit: "cr" })).toBe("1,250 cr");
  expect(priceLabel({ amount: 0.84, unit: "usd" })).toBe("$0.84");
  expect(priceLabel({ amount: 40, unit: "account-cr" })).toBe("40 cr");
  expect(priceLabel(null)).toBeNull();
  expect(Object.values(ACTION_LABEL)).toEqual(["Open in Takes", "Release", "Recreate", "Open Business", "Open Viral"]);
});

test("a reply is checked row by row before the tray draws it", () => {
  expect(parseTrayReply(null)).toBeNull();
  expect(parseTrayReply({ jobs: "nope" })).toBeNull();
  const reply = parseTrayReply({
    pollAfterSeconds: 10, partial: true,
    jobs: [
      { ...row("ok", "rendering", T0), mediaUrl: "https://elsewhere.example/x.png", action: "delete", tone: "purple", kind: "model", price: { amount: 5, unit: "eur" }, progress: 3 },
      { ...row("bad-stage", "rendering", T0), stage: "exploding" },
      { id: 7, name: "no id" },
    ],
  });
  expect(reply?.pollAfterSeconds).toBe(10);
  expect(reply?.partial).toBe(true);
  expect(reply?.jobs).toHaveLength(1);
  expect(reply?.jobs[0]).toMatchObject({ id: "ok", mediaUrl: null, action: null, tone: "blue", kind: "other", price: null, progress: null });
  expect(parseTrayReply({ jobs: [] })?.pollAfterSeconds).toBe(60);
});
