import { test, expect } from "@playwright/test";
import { HOW_IT_WORKS, NO_ACCESS, SAMPLE_PILL, VISITOR_SCREENS, sampleTab, showcase, visitorAsk, visitorBrief } from "../../lib/v12/visitor";
import { inviteBanner, inviteKind, inviteTitle, signupPath } from "../../components/v12/join/join-model";

/* The visitor's new interface, as data (lib/v12/visitor.ts): what an address asks for, Particl's own showcase, the words
   that are the prototype's, and what an invite code is (components/v12/join/join-model.ts). Pure. */

test("the address asks for a screen, a sheet, an invite or a board link, and ignores anything else", () => {
  expect(visitorAsk({})).toEqual({ screen: "home", join: null, requested: false, invite: null, step: null, board: false, joined: false });
  expect(visitorAsk({ screen: "make", join: "start", requested: "1", joined: "1" })).toMatchObject({ screen: "make", join: "start", requested: true, joined: true });
  expect(visitorAsk({ screen: "elsewhere", join: "nonsense", step: "plan" })).toMatchObject({ screen: "home", join: null, step: "plan" });
  /* A code is well formed or nothing; a board link is only a flag, so its id goes no further than the address. */
  expect(visitorAsk({ invite: "short" }).invite).toBeNull();
  expect(visitorAsk({ invite: "abcdefgh12345678" }).invite).toBe("abcdefgh12345678");
  expect(visitorAsk({ invite: "has space here!!" }).invite).toBeNull();
  expect(visitorAsk({ board: "draft-1" }).board).toBe(true);
  expect(visitorAsk({ board: "<script>" }).board).toBe(false);
  expect(Object.keys(visitorAsk({ board: "draft-1" }))).not.toContain("boardId");
  expect(VISITOR_SCREENS).toEqual(["home", "make", "board"]);
});

test("the showcase is Particl's own: public stills, never a workspace's, never the prototype's stand-ins", () => {
  const tiles = showcase();
  expect(tiles).toHaveLength(3);
  for (const tile of tiles) {
    expect(tile.url).toMatch(/^\/campaign\/[a-z]+\.webp$/);
    expect(tile.title).toBeTruthy();
    expect(tile.type).toMatch(/^Still · /);
  }
  expect(new Set(tiles.map((t) => t.url)).size).toBe(3);
  const words = JSON.stringify(tiles);
  for (const sample of ["Mirror at noon", "Aqua, carried far", "Walk the ridge", "Bleached gold", "Dune Studies", "Maggi", "MAYA"]) expect(words).not.toContain(sample);
});

test("the prototype's own words, verbatim", () => {
  expect(HOW_IT_WORKS.map((s) => s.title)).toEqual(["Describe it", "Atomik plans the stages", "Approve as it’s made", "Deliver in every size and language"]);
  expect(HOW_IT_WORKS[0].line).toBe("A film, an ad or an idea, in a sentence or a brief.");
  expect(NO_ACCESS.title).toBe("You don’t have access");
  expect(NO_ACCESS.line).toBe("This board belongs to another workspace. Boards, names and assets are never shown outside their workspace.");
  expect(SAMPLE_PILL).toBe("Sample · changes on the sample aren’t saved");
  expect(sampleTab("A short film")).toBe("Sample · A short film");
});

test("a picked tile's words go after what the visitor typed; nothing picked is what they typed", () => {
  const tile = { title: "The encounter", prompt: "A walk through dunes" };
  expect(visitorBrief(null, "  a tea ad  ")).toBe("a tea ad");
  expect(visitorBrief(tile, "")).toBe("Make one like “The encounter”: A walk through dunes");
  expect(visitorBrief(tile, "but at night")).toBe("but at night\n\nMake one like “The encounter”: A walk through dunes");
  expect(visitorBrief({ title: "Plain", prompt: "" }, "")).toBe("Make one like “Plain”.");
});

test.describe("invites", () => {
  const code = "abcdefgh12345678";
  const team = inviteKind(code, { status: 200, body: { ok: true, workspace: "North Quay", email: "a@b.test", name: "Ana" } }, null);
  const fresh = inviteKind(code, { status: 404, body: {} }, { status: 200, body: { ok: true, email: "c@d.test", name: "Cy" } });
  const used = inviteKind(code, { status: 409, body: { error: "That invite has already been used." } }, null);
  const none = inviteKind(code, { status: 404, body: {} }, { status: 404, body: {} });

  test("the sheet's title and the banner by what the code is", () => {
    expect(inviteTitle(team, "fallback")).toBe("Join North Quay’s workspace");
    expect(inviteTitle(fresh, "fallback")).toBe("Create your workspace");
    expect(inviteTitle(used, "fallback")).toBe("This invite has expired");
    expect(inviteTitle(none, "fallback")).toBe("fallback");
    expect(inviteTitle(null, "fallback")).toBe("fallback");
    expect(inviteBanner(team)).toEqual({ line: "North Quay invited you to Particl", action: "Accept invite", to: "accept" });
    expect(inviteBanner(fresh)).toEqual({ line: "You’re invited to create a workspace on Particl", action: "Accept invite", to: "accept" });
    expect(inviteBanner(used)).toEqual({ line: "This invite has expired or been used", action: "Request access", to: "request" });
    expect(inviteBanner(none)?.to).toBe("request");
    expect(inviteBanner(null)).toBeNull();
  });

  test("a new workspace's invite goes to today's sign-up page, carrying only the name typed", () => {
    expect(signupPath(code, "")).toBe(`/signup?invite=${code}`);
    expect(signupPath(code, "  North Quay Films ")).toBe(`/signup?invite=${code}&workspace=North%20Quay%20Films`);
    expect(signupPath(code, "x".repeat(300)).length).toBeLessThan(200);
    expect(signupPath("a b&c", "n&m")).toBe("/signup?invite=a%20b%26c&workspace=n%26m");
  });
});
