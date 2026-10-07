import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { libraryEntries } from "../../lib/workspace/library";
import {
  DRAWN_SCREENS, PHONE_PARAMS, SWIPE_MIN, judgedLine, phoneSearch, queueJudgement, readPhone, readQueued, reviewCountLine,
  reviewQueue, shotWords, swipeVerdict, takeSpec, takeTitle, versionsOf,
  readableTakeName,
} from "../../components/graphite/phone/phone-model";
import { PHONE_SCREEN } from "../../components/graphite/phone/routes";
import { generation } from "../helpers/workspaceFixtures";

const entries = (gens: Parameters<typeof generation>[0][]) => libraryEntries({ uploads: [], generations: gens.map(generation) });

/** README § 1.1: the phone's addresses, and DECISIONS 11: how a phone answers the other pages. */
test("addresses open the phone's screens; the board is its Record and Approvals is Home", () => {
  expect(readPhone("?device=phone&screen=review&take=gen_1")).toMatchObject({ asked: "review", screen: "review", framed: true, take: "gen_1", own: true });
  expect(readPhone("?screen=plan&from=notification")).toMatchObject({ asked: "plan", fromNotification: true, own: true });
  expect(readPhone("?view=board&project=p1").asked).toBe("record");
  /* Today's Studio stages are regions of the board, and on a phone the board is its Record. */
  for (const page of ["rig", "boards", "cast", "takes", "astra", "edit", "deliver", "brief"]) expect(readPhone(`?suite=particl&page=${page}`)).toMatchObject({ asked: "record", own: true });
  expect(readPhone("?suite=particl&page=brief&sp=stages")).toMatchObject({ asked: "home", own: true });
  expect(readPhone("?screen=plan&run=rar_1&project=p1").run).toBe("rar_1");
  expect(readPhone("?screen=plan&run=../x").run).toBeNull();
  expect(readPhone("?make=video").asked).toBe("make");
  expect(readPhone("?atomik=how").asked).toBe("atomik");
  expect(readPhone("?suite=atomik&page=approvals")).toMatchObject({ asked: "home", own: true });
  expect(readPhone("")).toMatchObject({ asked: "home", screen: "home", framed: false, own: true });
  /* Today's Studio overview and the old phone Home are what Home replaces. */
  expect(readPhone("?suite=particl&page=brief&sp=stages")).toMatchObject({ asked: "home", own: true });
  /* Settings and the rest render under the phone's header. */
  expect(readPhone("?view=workspace&tab=credits").own).toBe(false);
  expect(readPhone("?suite=moleculr&page=marketing").own).toBe(false);
  /* A malformed take id is never carried. */
  expect(readPhone("?screen=review&take=../x").take).toBeNull();
  expect(readPhone("?screen=nonsense").asked).toBe("home");
});

test("every one of the design's phone screens is drawn (the eight, Gaps A's Cut and its consent step); an address that is not one opens Home, never an empty screen", () => {
  expect([...DRAWN_SCREENS].sort()).toEqual(["atomik", "consent", "cut", "fix", "home", "make", "plan", "record", "review", "states"]);
  /* The consent step (Gaps A) carries the cast member it records for; a malformed one is never carried, and leaving drops it. */
  expect(readPhone("?screen=consent&cast=cast:cast:lead").cast).toBe("cast:cast:lead");
  expect(readPhone("?screen=consent&cast=../x").cast).toBeNull();
  expect(phoneSearch("?screen=consent&cast=n1&project=p1", { screen: "home" })).toBe("?project=p1");
  for (const screen of ["fix", "states", "cut"]) expect(readPhone(`?screen=${screen}`).screen).toBe(screen);
  expect(readPhone("?screen=nonsense").screen).toBe("home");
  /* Change with words keeps the take it was opened on. */
  expect(phoneSearch("?screen=review&take=gen_1", { screen: "fix" })).toBe("?screen=fix&take=gen_1");
  expect(phoneSearch("?screen=fix&take=gen_1", { screen: "review", take: "gen_1" })).toBe("?screen=review&take=gen_1");
  expect(PHONE_SCREEN).toMatchObject({ id: "phone", landed: true, params: PHONE_PARAMS });
});

test("phoneSearch changes only the phone's own params and drops what belonged to the screen left", () => {
  expect(phoneSearch("?project=p1&screen=review&take=gen_1&account=a", { screen: "home" })).toBe("?project=p1&account=a");
  expect(phoneSearch("?project=p1", { screen: "review", take: "gen_2" })).toBe("?project=p1&screen=review&take=gen_2");
  expect(phoneSearch("?screen=plan&from=notification&device=phone", { screen: "home" })).toBe("?device=phone");
  /* Leaving the address a screen came in on: the board's, or an old stage's. */
  expect(phoneSearch("?view=board&region=cast&project=p1", { screen: "home" })).toBe("?project=p1");
  expect(phoneSearch("?suite=particl&page=takes&project=p1", { screen: "record" })).toBe("?project=p1&screen=record");
  expect(phoneSearch("?screen=home&project=p1", { screen: "plan", run: "rar_1" })).toBe("?screen=plan&project=p1&run=rar_1");
  expect(phoneSearch("?screen=plan&run=rar_1", { screen: "home" })).toBe("");
});

/** Frame C: swiping judges, and only a clear sideways drag does. */
test("a swipe right approves, left rejects (the trail's 'changes'), and a tap or a scroll means nothing", () => {
  expect(swipeVerdict(SWIPE_MIN, 0)).toBe("approved");
  expect(swipeVerdict(-SWIPE_MIN - 20, 10)).toBe("changes");
  expect(swipeVerdict(SWIPE_MIN - 1, 0)).toBeNull();
  expect(swipeVerdict(4, 3)).toBeNull();
  expect(swipeVerdict(70, 80)).toBeNull();
  expect(swipeVerdict(Number.NaN, 0)).toBeNull();
  expect(judgedLine("Shot 2 · v2", "approved", false)).toBe("Shot 2 · v2 approved · nothing spent");
  expect(judgedLine("Shot 2 · v2", "changes", false)).toBe("Shot 2 · v2 rejected · nothing spent");
  expect(judgedLine("Shot 2 · v2", "changes", true)).toBe("Shot 2 · v2 rejected · sent when you're back online");
});

test("the review queue is the project's finished, unjudged pictures and videos, oldest first", () => {
  const list = entries([
    { id: "late", createdAt: 3_000, kind: "video", shotId: "s1", shotCode: "SH01", version: 2 },
    { id: "early", createdAt: 1_000, kind: "image", reviewState: "picked" },
    { id: "done", createdAt: 2_000, reviewState: "approved" },
    { id: "back", createdAt: 2_500, reviewState: "changes" },
    { id: "live", createdAt: 2_600, status: "running" },
    { id: "sound", createdAt: 2_700, kind: "audio" },
    { id: "first", createdAt: 500, kind: "video", shotId: "s1", shotCode: "SH01", version: 1, reviewState: "approved" },
  ]);
  expect(reviewQueue(list).map((e) => e.take.sourceId)).toEqual(["early", "late"]);
  expect(reviewCountLine(1)).toBe("1 take to review");
  expect(reviewCountLine(3)).toBe("3 takes to review");
  const late = list.find((e) => e.take.sourceId === "late")!;
  expect(versionsOf(late, list).map((e) => e.take.sourceId)).toEqual(["first", "late"]);
  expect(takeTitle(late)).toBe("Shot 1 · v2");
});

test("the badge says the take's own frame and length, and nothing it does not know", () => {
  const [video] = entries([{ id: "v", kind: "video", durationS: 5, params: { ratio: "16:9" } }]);
  const [still] = entries([{ id: "i", kind: "image", params: {} }]);
  expect(takeSpec(video)).toBe("16:9 · 5 s");
  expect(takeSpec(still)).toBeNull();
});

/** README § 3.6 states: judging queues offline; the newest word on a take is the one sent. */
test("offline judgements: well-formed rows only, and a later judgement of a take replaces the earlier", () => {
  const one = { projectId: "p1", generationId: "g1", state: "approved" as const, at: 1 };
  const two = { projectId: "p1", generationId: "g1", state: "changes" as const, at: 2 };
  const other = { projectId: "p1", generationId: "g2", state: "" as const, at: 3 };
  expect(queueJudgement(queueJudgement([one], other), two)).toEqual([other, two]);
  expect(readQueued([two, { ...one, state: "paid" }, { ...one, generationId: "../x" }, null, "x", other])).toEqual([two, other]);
  expect(readQueued("nonsense")).toEqual([]);
});

/** The phone never spends from a swipe, and words no price by hand (DECISIONS 18). */
test("no phone screen calls a paid route itself, and none formats a price by hand", () => {
  for (const file of ["ReviewScreen.tsx", "HomeScreen.tsx", "PhoneApp.tsx", "PhoneChrome.tsx", "use-online.ts", "phone-model.ts"]) {
    const source = readFileSync(`components/graphite/phone/${file}`, "utf8");
    expect(source, file).not.toMatch(/\/api\/generate|\/release|agent\.render|agent\.approve|quoteFingerprint|maxCredits/);
    expect(source, file).not.toMatch(/\$\{[^}]*\}\s*cr\b/);
    expect(source, file).not.toMatch(/backdrop-filter|blur\(/);
  }
  const css = readFileSync("components/graphite/phone/phone-screens.css", "utf8");
  expect(css).not.toMatch(/backdrop-filter|blur\(/);
  /* Nothing read is under 12px. */
  for (const size of css.matchAll(/font-size:\s*([\d.]+)px/g)) expect(Number(size[1])).toBeGreaterThanOrEqual(12);
  /* Colours are tokens: no hex outside app/graphite.css. */
  expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
});

test("a shot code is said in words, never shown as the code", () => {
  expect(shotWords("SH03")).toBe("Shot 3");
  expect(shotWords("sh12")).toBe("Shot 12");
  expect(shotWords("A1")).toBeNull();
  expect(shotWords(null)).toBeNull();
});

test("a take's id never reaches the phone: tk-s1-v1 reads Shot 1 · v1, any other id reads Take", () => {
  expect(readableTakeName("Take tk-s1-v1")).toBe("Shot 1 · v1");
  expect(readableTakeName("tk-s12-v3")).toBe("Shot 12 · v3");
  expect(readableTakeName("gen_9f8a7b6c5d", 2)).toBe("Take · v2");
  expect(readableTakeName("")).toBe("Take");
  expect(readableTakeName("Shot 2 · The sphere")).toBe("Shot 2 · The sphere");
  /* A person's own names are never taken for ids. */
  for (const name of ["Take-off at dawn", "Job-site walkthrough", "Asset-light hero", "Take_final_v2", "take-3-final.mov", "job-site.mp4"]) expect(readableTakeName(name)).toBe(name);
});
