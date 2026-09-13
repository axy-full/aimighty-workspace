import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signupInviteEmail, inviteEmail, SIGNUP_INVITE_DAYS, TEAM_INVITE_DAYS } from "../../lib/mail";

/**
 * Board 12i, the EMAIL card: "Your invite to particl" · the code · "A code,
 * good for N days. Nothing to read." · one button, "Open particl". Pure: the
 * email is a pair of strings, nothing is sent.
 */
const sample = {
  name: "Sam", inviter: "The desk", code: "PRTCL-7K2Q-abc_DEF", link: "https://particl.example/signup?invite=PRTCL-7K2Q-abc_DEF", days: SIGNUP_INVITE_DAYS,
};

test("the sign-up invite carries the subject, the code, the days line and one button — in text and html", () => {
  const mail = signupInviteEmail(sample);
  expect(mail.subject).toBe("Your invite to particl");
  const line = `A code, good for ${SIGNUP_INVITE_DAYS} days. Nothing to read.`;
  for (const body of [mail.text, mail.html]) {
    expect(body).toContain(sample.code);
    expect(body).toContain(line);
    expect(body).toContain(sample.link);
  }
  expect(mail.html).toContain(">Open particl</a>");
  expect(mail.html.match(/<a /g)?.length).toBe(1);
  expect(mail.text).toContain("Open particl:");
  /* The light email surface stays as it was. */
  expect(mail.html).toContain("background:#FCFCFD");
  expect(mail.html).toContain("color:#15171C");
});

test("the days line reads the number it is given, never a literal", () => {
  expect(signupInviteEmail({ ...sample, days: 7 }).text).toContain("A code, good for 7 days.");
  expect(signupInviteEmail({ ...sample, days: 30 }).html).toContain("A code, good for 30 days.");
  expect(signupInviteEmail({ ...sample, days: 30 }).html).not.toContain(`good for ${SIGNUP_INVITE_DAYS} days`);
});

test("the code and the name are escaped in the html", () => {
  const mail = signupInviteEmail({ ...sample, name: "<b>", code: "a&b" });
  expect(mail.html).not.toContain("<b>");
  expect(mail.html).toContain("&lt;b&gt;");
  expect(mail.html).toContain("a&amp;b");
  expect(mail.text).toContain("a&b");
});

test("the lifetimes are one number each, read by the routes and by the emails", () => {
  expect(SIGNUP_INVITE_DAYS).toBe(14);
  expect(TEAM_INVITE_DAYS).toBe(7);
  const root = join(__dirname, "..", "..");
  const admin = readFileSync(join(root, "app/api/admin/invites/route.ts"), "utf8");
  const team = readFileSync(join(root, "app/api/team/route.ts"), "utf8");
  /* The expiry and the answer are computed from the constant, not merely imported beside it. */
  expect(admin).toMatch(/expiresAt = ts \+ SIGNUP_INVITE_DAYS \* 86400_000/);
  expect(admin).toMatch(/expiresInDays: SIGNUP_INVITE_DAYS/);
  expect(admin).toContain("signupInviteEmail(");
  expect(admin).toContain("days: SIGNUP_INVITE_DAYS");
  expect(team).toMatch(/expiresAt = ts \+ TEAM_INVITE_DAYS \* 86400_000/);
  expect(team).toMatch(/expiresInDays: TEAM_INVITE_DAYS/);
  /* No route keeps a lifetime of its own. */
  expect(admin).not.toMatch(/const INVITE_DAYS\b/);
  expect(team).not.toMatch(/const INVITE_DAYS\b/);
  /* The team invite says how long THIS link lasts: the nominal seven on a fresh one, the days left on a resend. */
  const fresh = inviteEmail({ name: "Sam", inviter: "A desk (Studio)", link: "https://particl.example/invite/x", role: "member", expiresAt: Date.now() + TEAM_INVITE_DAYS * 86400_000 });
  expect(fresh.text).toContain(`works for ${TEAM_INVITE_DAYS} days`);
  expect(fresh.html).toContain(`works for ${TEAM_INVITE_DAYS} days`);
  const resent = inviteEmail({ name: "Sam", inviter: "A desk (Studio)", link: "https://particl.example/invite/x", role: "member", expiresAt: Date.now() + 3 * 86400_000 });
  expect(resent.text).toContain("works for 3 days");
  expect(resent.html).toContain("works for 3 days");
  expect(resent.text).not.toContain(`works for ${TEAM_INVITE_DAYS} days`);
});
