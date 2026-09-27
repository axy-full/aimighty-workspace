import { test, expect } from "@playwright/test";
import {
  ACTION_LABEL, TRAY_LIMIT, accountTrayJob, active, changing, engineTrayJob, failureLine, moving, parseTrayReply, priceLabel, seenKey, statusFilter,
  trayOrder, traySummary, trayWhen, withComposerSlot, type AccountRow, type EngineMoney, type EngineRow, type TrayJob,
} from "../../lib/jobsTray";
import type { GenPreset } from "../../lib/shell/recipe";
import { releaseRefusal } from "../../lib/held";

/**
 * The header's jobs tray (lib/jobsTray): stored rows from both engines become
 * tray rows with their real stage, the ledger's figure and one action; the
 * browser orders and counts them the way the rows are labelled and folds in
 * the composer's just-pressed Generate. Nothing here reads a database or the
 * network.
 */
const T0 = 1_760_000_000_000;
const MIN = 60_000;

function engine(fields: Partial<EngineRow> & { id: string; status: string }): EngineRow {
  return {
    kind: "video", model: "dreamina-seedance-2-5-260628", prompt: "A slow push-in on a lighthouse at dusk", title: null,
    params: {}, storedUrl: null, error: null, createdAt: T0, settledAt: null, projectName: "Harbour launch spot", ...fields,
  };
}
function account(fields: Partial<AccountRow> & { id: string; status: string }): AccountRow {
  return {
    draftId: "draft-1", workflow: "generation", quoteCredits: 40, failureCode: null, createdAt: T0, updatedAt: T0,
    hasReceipt: false, setAside: false, prompt: "Product spins on a marble plinth", modelId: "seedance_2_0",
    outputType: "video", toolLabel: null, originalId: null, originalKind: null, projectName: "Harbour launch spot", ...fields,
  };
}
const money = (fields: Partial<EngineMoney> = {}): EngineMoney => ({ unit: "cr", reserved: null, charged: null, needs: null, ...fields });
const preset = (name: string): GenPreset => ({ prompt: "A slow push-in on a lighthouse at dusk", model: "dreamina-seedance-2-5-260628", type: "video", billing: "workspace", picks: { ratio: "16:9" }, from: { id: "gen_f", name }, note: `Recreate · ${name}` });

test("GET /api/jobs keeps one status as it was and reads a comma list as any of them", () => {
  expect(statusFilter(null)).toEqual({});
  expect(statusFilter("succeeded")).toEqual({ status: "succeeded" });
  expect(statusFilter("all")).toEqual({ status: "all" });
  expect(statusFilter("queued,running,held")).toEqual({ statuses: ["queued", "running", "held"] });
  expect(statusFilter(" queued , queued,held,")).toEqual({ statuses: ["queued", "held"] });
  expect(statusFilter("held,")).toEqual({ status: "held" });
  expect(statusFilter(",")).toEqual({});
});

test("a take in flight shows the price it was approved and reserved at, off the ledger, and nothing when the ledger has none", () => {
  expect(engineTrayJob(engine({ id: "q", status: "queued" }), money({ reserved: 52 }))).toMatchObject({ stage: "queued", label: "Queued", tone: "blue", price: { amount: 52, unit: "cr" }, action: null, progress: null, settledAt: null });
  expect(engineTrayJob(engine({ id: "r", status: "running" }), money({ reserved: 36 }))).toMatchObject({ stage: "rendering", label: "Rendering", price: { amount: 36, unit: "cr" } });
  /* Never estimated again here: no reservation read, no figure. */
  expect(engineTrayJob(engine({ id: "r2", status: "running" }), money()).price).toBeNull();
  /* A workspace that pays its vendors sees its own dollars. */
  expect(engineTrayJob(engine({ id: "u", status: "running" }), money({ unit: "usd", reserved: 0.84 })).price).toEqual({ amount: 0.84, unit: "usd" });
});

test("a held take says what it needs and waits on Release; one waiting for a slot is in the line, with nothing to press", () => {
  const held = engineTrayJob(engine({ id: "h", status: "held", params: { held: { why: "credits", needs: 43 } } }), money({ needs: 43 }));
  /* The figure approved when it was held is the one its Release approves again: on the button, and sent with the press. */
  expect(held).toMatchObject({ stage: "held", label: "Held · needs 43 cr", tone: "amber", action: "release", releaseCredits: 43, price: null, reason: null });
  /* With no figure there is nothing to approve: no Release. */
  expect(engineTrayJob(engine({ id: "h0", status: "held", params: { held: { why: "credits" } } }), money())).toMatchObject({ label: "Held · needs credits", action: null });
  expect(active(held)).toBe(true);
  expect(moving(held)).toBe(false);
  const slot = engineTrayJob(engine({ id: "s", status: "held", params: { held: { why: "slots" } } }), money({ needs: 13 }));
  expect(slot).toMatchObject({ stage: "queued", label: "Queued", reason: "Waiting for a free slot", action: null, price: { amount: 13, unit: "cr" } });
  expect(moving(slot)).toBe(false);
  /* A release refused for a cap says so; a refusal for credits is what the label already says. */
  expect(engineTrayJob(engine({ id: "c", status: "held", error: "The production is over the cap.", params: { held: { why: "credits" } } }), money({ needs: 7 })).reason).toBe("The production is over the cap.");
  expect(engineTrayJob(engine({ id: "b", status: "held", error: "This job needs 43 credits; 5 are available after reserved jobs.", params: { held: { why: "credits" } } }), money({ needs: 43 })).reason).toBeNull();
});

test("a finished take shows what the ledger charged and opens itself in Takes", () => {
  const done = engineTrayJob(engine({ id: "gen_ok", status: "succeeded", storedUrl: "blob:x", settledAt: T0 + 5 * MIN }), money({ charged: 29 }));
  expect(done).toMatchObject({ stage: "complete", label: "Complete", tone: "green", action: "open", takeId: "generation:gen_ok", mediaUrl: "/api/media/gen_ok", price: { amount: 29, unit: "cr" }, settledAt: T0 + 5 * MIN });
  expect(engineTrayJob(engine({ id: "a1", kind: "audio", status: "succeeded", storedUrl: "blob:x" }), money({ charged: 2 })).mediaUrl).toBeNull();
  expect(engineTrayJob(engine({ id: "own", status: "succeeded" }), money({ charged: 0 })).price).toBeNull();
});

test("a failed take is 'not billed' only when the ledger shows nothing charged, and its reason never says either way", () => {
  const unbilled = engineTrayJob(engine({ id: "f", status: "failed", error: "Upstream 503 from fal.ai", title: "Lighthouse v2" }), money({ charged: 0 }), null, { preset: preset("Lighthouse v2") });
  expect(unbilled).toMatchObject({ stage: "failed", label: "Failed · not billed", tone: "red", action: "recreate", price: null, name: "Lighthouse v2", reason: "The engine hit an error" });
  expect(unbilled.preset?.from).toEqual({ id: "gen_f", name: "Lighthouse v2" });
  /* Charged for a failure: said with its figure, never "not billed". */
  expect(engineTrayJob(engine({ id: "b", status: "failed", error: "Stopped by the director" }), money({ charged: 4 })))
    .toMatchObject({ label: "Failed", reason: "Stopped by the director", price: { amount: 4, unit: "cr" } });
  /* The ledger has not settled it (or never metered it): nothing is claimed. */
  expect(engineTrayJob(engine({ id: "n", status: "failed", error: "The render never came back" }), money())).toMatchObject({ label: "Failed", price: null, reason: "The engine timed out" });
  expect(engineTrayJob(engine({ id: "rf", status: "failed", error: "Refused by the safety filter" }), money({ charged: 0 })).reason).toBe("Refused by the content filter");
  expect(engineTrayJob(engine({ id: "u", status: "failed", error: null }), money({ charged: 0 })).reason).toBe("It did not render");
  for (const error of ["Upstream 503 from fal.ai", "Stopped by the director", "The render never came back", "Refused", null])
    expect(failureLine(error)).not.toMatch(/charged|billed|refund/i);
  /* A take Gen cannot make again opens in Takes instead. */
  const blocked = engineTrayJob(engine({ id: "e", status: "failed", error: "x" }), money({ charged: 0 }), null, { blocked: "This take was made from a source clip. Run that tool again from Takes." });
  expect(blocked).toMatchObject({ action: "open", takeId: "generation:e" });
  expect(blocked.preset).toBeUndefined();
});

test("a discarded take is the person's own doing: not a failure, not red", () => {
  const discarded = engineTrayJob(engine({ id: "d", status: "cancelled", error: "Discarded before it started. Nothing was charged.", params: { discardedAt: T0 } }), money(), null, { preset: preset("x") });
  expect(discarded).toMatchObject({ stage: "cancelled", label: "Discarded", tone: "idle", reason: null, action: "recreate" });
  expect(engineTrayJob(engine({ id: "c", status: "cancelled", error: "Stopped by an admin." }), money({ charged: 0 }))).toMatchObject({ label: "Cancelled · not billed", tone: "idle", reason: "Stopped by an admin." });
  expect(engineTrayJob(engine({ id: "c2", status: "cancelled" }), money())).toMatchObject({ label: "Cancelled" });
});

test("a take is named the way the Library names it — its title, else its words — never by an internal shot code", () => {
  const shot = { shotCode: "WB1EE9F8A3", shotTitle: "Wide on the water" } as Partial<EngineRow>;
  expect(engineTrayJob(engine({ id: "1", status: "queued", title: "Hero wide", ...shot }), money()).name).toBe("Hero wide");
  expect(engineTrayJob(engine({ id: "2", status: "queued", ...shot }), money()).name).toBe("A slow push-in on a lighthouse at dusk");
  expect(engineTrayJob(engine({ id: "3", status: "queued", prompt: "  gulls  over the pier " }), money()).name).toBe("gulls over the pier");
  expect(engineTrayJob(engine({ id: "4", status: "queued", prompt: "" }), money()).name).toBe("Untitled take");
  const long = engineTrayJob(engine({ id: "5", status: "queued", prompt: "word ".repeat(40) }), money()).name;
  expect(long.length).toBeLessThanOrEqual(60);
  expect(long.endsWith("…")).toBe(true);
});

test("a connected-account job reads its stage from the account's own record, in the account's own credits", () => {
  expect(accountTrayJob(account({ id: "a", status: "accepted" }))).toMatchObject({ source: "account", stage: "rendering", label: "Rendering", price: { amount: 40, unit: "account-cr" }, action: null });
  expect(accountTrayJob(account({ id: "u", status: "uncertain", hasReceipt: true }))).toMatchObject({ stage: "confirming", label: "Confirming", tone: "amber" });
  /* Nothing a read can move: said as it is, counted as unconfirmed, never as rendering, and it opens where its card offers Check again. */
  const stuck = accountTrayJob(account({ id: "d", status: "dispatching" }));
  expect(stuck).toMatchObject({ stage: "unconfirmed", label: "Not confirmed · never sent twice", action: "gen" });
  expect(moving(stuck)).toBe(false);
  expect(accountTrayJob(account({ id: "dv", status: "uncertain", workflow: "genjutsu" })).action).toBe("viral");
  /* Set aside (or past the time it may hold a slot): never sent again, nothing to wait for — closed, not counted, not news. */
  const aside = accountTrayJob(account({ id: "s", status: "accepted", setAside: true, updatedAt: T0 + 3 * MIN }));
  expect(aside).toMatchObject({ stage: "aside", label: "Can't be checked", tone: "idle", settledAt: T0 + 3 * MIN, action: "gen" });
  expect(active(aside)).toBe(false);
  expect(accountTrayJob(account({ id: "s2", status: "uncertain", setAside: true }))).toMatchObject({ stage: "aside", label: "Set aside · never sent again" });
  expect(traySummary([aside], new Set())).toMatchObject({ kind: "quiet" });

  const original = `gen_hfc_${"a".repeat(40)}`;
  expect(accountTrayJob(account({ id: "c", status: "completed", originalId: original, originalKind: "video", updatedAt: T0 + 9 * MIN })))
    .toMatchObject({ stage: "complete", action: "open", takeId: `generation:${original}`, mediaUrl: `/api/media/${original}`, kind: "video", settledAt: T0 + 9 * MIN });

  /* The ledger keeps connected jobs as quotes, not refunds: a failure never claims "not billed", nor a figure. */
  const refused = accountTrayJob(account({ id: "f", status: "failed", failureCode: "provider_failed" }), preset("Product spins"));
  expect(refused).toMatchObject({ stage: "failed", label: "Failed", price: null, action: "recreate", reason: "The connected account reported it as failed." });
  expect(JSON.stringify(refused)).not.toMatch(/not billed/i);
  /* Finished on the account but not kept: it may have been spent, so the approved figure stays. */
  expect(accountTrayJob(account({ id: "k", status: "failed", failureCode: "invalid_result" }))).toMatchObject({ label: "Not kept · receipt saved", price: { amount: 40, unit: "account-cr" }, action: null });
  expect(accountTrayJob(account({ id: "v", status: "failed", workflow: "genjutsu" })).action).toBe("viral");
  expect(accountTrayJob(account({ id: "m", status: "failed", workflow: "marketing-video", prompt: null })).action).toBe("ads");
  expect(accountTrayJob(account({ id: "n", status: "accepted", workflow: "genjutsu", prompt: null, outputType: null })).name).toBe("Motion transfer");
  expect(priceLabel({ amount: 12.5, unit: "account-cr" })).toBe("12.5 connected cr");
});

const row = (id: string, stage: TrayJob["stage"], createdAt: number, settledAt: number | null = null): TrayJob => ({
  id, source: "engine", kind: "video", name: id, mediaUrl: null, stage, label: stage, tone: "blue", reason: null, progress: null,
  createdAt, settledAt, price: null, draftId: null, projectName: null, action: null,
});

test("held comes first, then what renders (newest first), then what waits its turn, then what finished (latest first)", () => {
  const order = trayOrder([
    row("done-old", "complete", T0, T0 + 1 * MIN), row("run-old", "rendering", T0), row("held", "held", T0 - 9 * MIN),
    row("fail-new", "failed", T0, T0 + 3 * MIN), row("run-new", "rendering", T0 + 2 * MIN), row("queued", "queued", T0 + 4 * MIN),
    row("check", "unconfirmed", T0), row("gone", "cancelled", T0, T0 + 2 * MIN), row("run-new", "rendering", T0 + 2 * MIN),
  ]).map((j) => j.id);
  expect(order).toEqual(["held", "run-new", "run-old", "queued", "check", "fail-new", "gone", "done-old"]);
  expect(trayOrder(Array.from({ length: 40 }, (_, i) => row(`r${i}`, "rendering", T0 + i)))).toHaveLength(TRAY_LIMIT);
});

test("the composer's just-pressed Generate shows until the read has its row, and its end is said at once", () => {
  const listed = [row("job-1", "rendering", T0)];
  const pending = withComposerSlot(listed, { id: "pending:composer", name: "Lighthouse", label: "Submitting" }, T0);
  expect(pending.map((j) => [j.id, j.stage])).toEqual([["pending:composer", "submitting"], ["job-1", "rendering"]]);
  expect(withComposerSlot(listed, { id: "job-2", name: "Pier", label: "Queued" }, T0)[0]).toMatchObject({ id: "job-2", stage: "queued", name: "Pier" });
  expect(withComposerSlot(listed, { id: "job-3", name: "Pier", label: "Held · needs credits" }, T0)[0]).toMatchObject({ stage: "held", tone: "amber" });
  expect(withComposerSlot(listed, { id: "job-4", name: "Pier", label: "Complete", tone: "green" }, T0)[0]).toMatchObject({ stage: "complete", settledAt: T0 });
  /* Listed and still going: the read's row wins. */
  expect(withComposerSlot(listed, { id: "job-1", name: "Other words", label: "Queued" }, T0)).toEqual(listed);
  /* Listed as going, but the composer saw it end: the row says so until the next read, with no figure claimed meanwhile. */
  expect(withComposerSlot(listed, { id: "job-1", name: "x", tone: "green" }, T0 + MIN)[0]).toMatchObject({ id: "job-1", stage: "complete", label: "Complete", tone: "green", settledAt: T0 + MIN, price: null });
  expect(withComposerSlot(listed, { id: "job-1", name: "x", tone: "red" }, T0)[0]).toMatchObject({ stage: "failed", label: "Failed" });
  /* A settled row is the ledger's word, and stays. */
  const done = [row("job-5", "complete", T0, T0)];
  expect(withComposerSlot(done, { id: "job-5", name: "x", tone: "red" }, T0)).toEqual(done);
  expect(withComposerSlot(listed, null, T0)).toEqual(listed);
});

test("the pill counts the rows as they are labelled: rendering, queued, held and unconfirmed apart", () => {
  const jobs = [row("a", "rendering", T0), row("c", "confirming", T0), row("s", "submitting", T0), row("q", "queued", T0), row("slot", "queued", T0), row("h", "held", T0), row("u", "unconfirmed", T0), row("d", "complete", T0, T0)];
  expect(traySummary(jobs, new Set())).toMatchObject({ kind: "active", rendering: 3, queued: 2, held: 1, unconfirmed: 1, text: "3 rendering · 2 queued · 1 held · 1 unconfirmed", short: "7", tone: "blue" });
  expect(traySummary([row("h", "held", T0)], new Set())).toMatchObject({ text: "1 held", short: "1", tone: "amber" });
  expect(traySummary([row("q", "queued", T0)], new Set())).toMatchObject({ text: "1 queued", tone: "blue" });
  /* A connected job nobody can confirm keeps the pill up, so its row can be reached. */
  expect(traySummary([row("u", "unconfirmed", T0)], new Set())).toMatchObject({ kind: "active", text: "1 unconfirmed", tone: "amber" });
  /* The server reads often only while something moves on its own; a held take waits on a person, an unconfirmed job on nobody. */
  expect(["rendering", "confirming", "submitting", "queued"].every((stage) => changing({ stage: stage as TrayJob["stage"] }))).toBe(true);
  expect(["held", "unconfirmed", "complete", "failed", "cancelled", "aside"].some((stage) => changing({ stage: stage as TrayJob["stage"] }))).toBe(false);
});

test("with nothing running, what finished is news until it is seen in the tray; then the pill goes quiet but stays while rows remain", () => {
  const settled = [row("d1", "complete", T0, T0 + 2 * MIN), row("d2", "complete", T0, T0 + 3 * MIN), row("f", "failed", T0, T0 + 4 * MIN), row("x", "cancelled", T0, T0 + 4 * MIN)];
  expect(traySummary(settled, new Set())).toMatchObject({ kind: "news", done: 2, failed: 1, text: "2 done · 1 failed", short: "3", tone: "red" });
  /* Seen by id and stage: no clock is compared. A discarded or cancelled take is never news. */
  const seen = new Set(settled.map(seenKey));
  expect(traySummary(settled, seen)).toMatchObject({ kind: "quiet", text: "Jobs", short: "", tone: "idle" });
  expect(traySummary([row("x", "cancelled", T0, T0)], new Set())).toMatchObject({ kind: "quiet" });
  /* Seen as failed, then it succeeds: news again. */
  expect(traySummary([row("f", "complete", T0, T0 + 9 * MIN)], seen)).toMatchObject({ kind: "news", text: "1 done", tone: "green" });
  /* Before this browser's record is read, nothing is news. */
  expect(traySummary(settled, null)).toMatchObject({ kind: "quiet" });
  expect(traySummary([], new Set())).toBeNull();
});

test("figures are written the ledger's way, and ages say how long it has run or when it finished", () => {
  expect(priceLabel({ amount: 1250, unit: "cr" })).toBe("1,250 cr");
  expect(priceLabel({ amount: 12.5, unit: "cr" })).toBe("12.5 cr");
  expect(priceLabel({ amount: 0.84, unit: "usd" })).toBe("$0.840");
  expect(priceLabel({ amount: 1.5, unit: "usd" })).toBe("$1.50");
  expect(priceLabel({ amount: 40, unit: "account-cr" })).toBe("40 connected cr");
  expect(priceLabel(null)).toBeNull();
  expect(trayWhen(row("r", "rendering", T0), T0 + 4 * MIN)).toBe("4 min");
  expect(trayWhen(row("d", "complete", T0 - 60 * MIN, T0), T0 + 20 * MIN)).toBe("20 min ago");
  expect(trayWhen(row("d", "complete", T0, T0), T0 + 20_000)).toBe("just now");
  expect(Object.values(ACTION_LABEL)).toEqual(["Open in Takes", "Release", "Recreate", "Open Gen", "Open Ads", "Open Viral"]);
});

test("a reply is checked row by row before the tray draws it", () => {
  expect(parseTrayReply(null)).toBeNull();
  expect(parseTrayReply({ jobs: "nope" })).toBeNull();
  const reply = parseTrayReply({
    pollAfterSeconds: 10, partial: true,
    jobs: [
      { ...row("ok", "rendering", T0), mediaUrl: "https://elsewhere.example/x.png", action: "delete", tone: "purple", kind: "model", price: { amount: 5, unit: "eur" }, progress: 3, settledAt: "later" },
      { ...row("open-nowhere", "complete", T0, T0), action: "open", takeId: "../../etc" },
      { ...row("open", "complete", T0, T0), action: "open", takeId: "generation:gen_1" },
      { ...row("again-nothing", "failed", T0, T0), action: "recreate", preset: { prompt: 4 } },
      { ...row("again", "failed", T0, T0), action: "recreate", preset: preset("again") },
      { ...row("free", "held", T0), action: "release", releaseCredits: 12.5 },
      { ...row("priced", "held", T0), action: "release", releaseCredits: 43 },
      { ...row("bad-stage", "rendering", T0), stage: "exploding" },
      { id: 7, name: "no id" },
    ],
  });
  expect(reply?.pollAfterSeconds).toBe(10);
  expect(reply?.partial).toBe(true);
  expect(reply?.jobs.map((j) => j.id)).toEqual(["ok", "open-nowhere", "open", "again-nothing", "again", "free", "priced"]);
  expect(reply?.jobs[0]).toMatchObject({ mediaUrl: null, action: null, tone: "blue", kind: "other", price: null, progress: null, settledAt: null });
  /* An action whose target is missing is no action. */
  expect(reply?.jobs[1]).toMatchObject({ action: null, takeId: null });
  expect(reply?.jobs[2]).toMatchObject({ action: "open", takeId: "generation:gen_1" });
  expect(reply?.jobs[3]).toMatchObject({ action: null, preset: null });
  expect(reply?.jobs[4].action).toBe("recreate");
  /* Release approves whole credits, or it is no Release. */
  expect(reply?.jobs[5]).toMatchObject({ action: null, releaseCredits: null });
  expect(reply?.jobs[6]).toMatchObject({ action: "release", releaseCredits: 43 });
  expect(parseTrayReply({ jobs: [] })?.pollAfterSeconds).toBe(60);
});

test("a refused Release says why without sending anyone to top up needlessly", () => {
  expect(releaseRefusal({ needs: 43, balance: 5, reason: null, slotsFull: true })).toEqual({ status: 402, error: "Still short: this needs 43 credits and 5 are left." });
  expect(releaseRefusal({ needs: 6000, balance: 1250.7, reason: null, slotsFull: false }).error).toBe("Still short: this needs 6,000 credits and 1,250 are left.");
  /* Covered, but refused for a reason of its own, or waiting for room: never "short", never Top up. */
  expect(releaseRefusal({ needs: 43, balance: 250, reason: "The shot is at its cap.", slotsFull: true })).toEqual({ status: 409, error: "The shot is at its cap." });
  expect(releaseRefusal({ needs: 43, balance: 250, reason: null, slotsFull: true })).toEqual({ status: 409, error: "Every render slot is busy. It starts on its own when one frees up." });
  expect(releaseRefusal({ needs: 43, balance: 250, reason: null, slotsFull: false })).toEqual({ status: 409, error: "It cannot start just now. It starts on its own when the workspace can run it." });
  /* A workspace on its own keys, or a take held for a slot, has no balance to be short of. */
  expect(releaseRefusal({ needs: 43, balance: null, reason: null, slotsFull: true }).status).toBe(409);
});
