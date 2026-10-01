import { test, expect } from "@playwright/test";
import { canProgress, isOpen, resumeAge, resumeGivesUp, resumeLine, resumePhase, resumeProblem, shortName } from "../../lib/higgsfield-consumer/resume";

/**
 * A connected-account job's state in the product's words
 * (lib/higgsfield-consumer/resume.ts): the jobs tray and the account's
 * history say these. The shell's collector that read jobs back went with the
 * retired sign-in; the server's scheduled collection finishes what was still
 * running.
 */
const RECEIPT = { response: "submitted" };

test("every open job is listed; a read can move one that is rendering, or unconfirmed with a receipt", () => {
  const jobs = [
    { id: "a", status: "quoted" }, { id: "b", status: "accepted" }, { id: "c", status: "uncertain", providerReceipt: RECEIPT },
    { id: "d", status: "completed" }, { id: "e", status: "dispatching" }, { id: "f", status: "failed" }, { id: "g", status: "uncertain" },
  ];
  expect(jobs.filter((j) => isOpen(j.status)).map((j) => j.id)).toEqual(["b", "c", "e", "g"]);
  expect(jobs.filter(canProgress).map((j) => j.id)).toEqual(["b", "c"]);
});

test("each state has one short label; a job nobody is asking after says why instead of claiming to render", () => {
  const at = (status: string, extra: Record<string, unknown> = {}) => ({ status, createdAt: 0, ...extra });
  expect(resumePhase(at("accepted"))).toEqual({ label: "Rendering", tone: "blue" });
  expect(resumePhase(at("uncertain", { providerReceipt: RECEIPT }))).toEqual({ label: "Confirming", tone: "amber" });
  expect(resumePhase(at("uncertain"))).toEqual({ label: "Not confirmed · never sent twice", tone: "amber" });
  expect(resumePhase(at("dispatching"))).toEqual({ label: "Not confirmed · never sent twice", tone: "amber" });
  expect(resumePhase(at("uncertain", { setAside: true }))).toEqual({ label: "Set aside · never sent again", tone: "amber" });
  // Still being read, or stopped after a read that could not move it, or an error that would repeat.
  expect(resumePhase(at("dispatching"), true)).toEqual({ label: "Confirming", tone: "amber" });
  expect(resumePhase(at("uncertain", { providerReceipt: RECEIPT }), false).label).toBe("Not confirmed · never sent twice");
  expect(resumePhase(at("accepted"), false)).toEqual({ label: "Can't be checked", tone: "amber" });
  expect(resumePhase(at("completed")).label).toBe("Complete");
  /* A failure says "refunded" or "charged" only once the account's own ledger names the job. */
  expect(resumePhase(at("failed")).label).toBe("Failed");
  const account = (state: "refunded" | "billed" | "unknown") => ({ provider: "higgsfield_account", stage: "run", code: "nsfw", kind: "content_filter", message: null, payer: "account",
    billing: state === "unknown" ? { state, basis: "hf-account-silent" } : { state, amount: 12, unit: "higgsfield_credits", basis: "hf-ledger" } });
  expect(resumePhase(at("failed", { failure: account("unknown") })).label).toBe("Failed");
  expect(resumePhase(at("failed", { failure: account("refunded") })).label).toBe("Failed · refunded");
  expect(resumePhase(at("failed", { failure: account("billed") })).label).toBe("Failed · charged");
  expect(resumePhase(at("failed", { failureCode: "invalid_result" })).label).toBe("Not kept · receipt saved");
  // No percentages: the account reports none, so none is drawn.
  expect(Object.keys(resumePhase(at("accepted")))).toEqual(["label", "tone"]);
  // The age rides along only while it is still followed.
  expect(resumeLine(at("accepted"), 12 * 60_000)).toBe("Rendering · 12 min");
  expect(resumeLine(at("uncertain", { providerReceipt: RECEIPT }), 3 * 3_600_000)).toBe("Confirming · 3 h");
  expect(resumeLine(at("uncertain"), 27 * 3_600_000)).toBe("Not confirmed · never sent twice");
  expect(resumeLine(at("accepted"), 3 * 86_400_000, false)).toBe("Can't be checked");
  expect([0, 59_000, 4 * 60_000, 3 * 3_600_000, 5 * 86_400_000].map((ms) => resumeAge(0, ms))).toEqual(["just now", "just now", "4 min", "3 h", "5 d"]);
  expect(resumeAge(10_000, 0)).toBe("just now");
});

test("names are cut on a word with an ellipsis, never mid-word", () => {
  const prompt = "A slow dolly push across the wet harbour at blue hour, lanterns swaying over the moored boats";
  expect(shortName(prompt, 60)).toBe("A slow dolly push across the wet harbour at blue hour…");
  expect(shortName("  Short   and\nplain ", 60)).toBe("Short and plain");
  expect(shortName("x".repeat(90), 60)).toBe(`${"x".repeat(59)}…`);
  expect(shortName("", 60)).toBe("");
  expect(shortName(prompt, 80).length).toBeLessThanOrEqual(80);
});

test("a failed read is said in the product's words; one that would repeat for this job stops the asking", () => {
  const err = (code?: string, status?: number, message = "x") => Object.assign(new Error(message), { code, status });
  expect(resumeProblem(err("reconnect_required", 401))).toBe("Reconnect the account in Workspace › Engines to finish this take.");
  expect(resumeProblem(err("connection_changed", 409))).toBe("Started on an earlier account connection, so it can't be checked from here.");
  expect(resumeProblem(err("original_quota", 507))).toBe("Workspace storage is full. Make room to collect this take.");
  expect(resumeProblem(err(undefined, 404))).toBe("This job can no longer be checked from here.");
  expect(resumeProblem(err(undefined, 429, "Too many requests. Try again shortly."))).toBe("Too many requests. Try again shortly.");
  expect(resumeProblem(err(undefined, 503, "x".repeat(300)))).toBe("The account could not be reached. Trying again.");
  expect(resumeProblem("not an error")).toBe("The account could not be reached. Trying again.");
  expect(resumeProblem(null)).toBe("The account could not be reached. Trying again.");
  // The collector passes the reply's own fields and message.
  expect(resumeProblem({ status: 429 }, "Too many requests. Try again shortly.")).toBe("Too many requests. Try again shortly.");
  expect([err("connection_changed", 409), err(undefined, 404), err(undefined, 403), { status: 409, code: "connection_changed" }].every(resumeGivesUp)).toBe(true);
  expect([err("reconnect_required", 401), err("original_quota", 507), err(undefined, 429), err(undefined, 503), new Error("offline")].some(resumeGivesUp)).toBe(false);
});
