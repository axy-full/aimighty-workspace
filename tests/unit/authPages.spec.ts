import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  readAnswer,
  signInNotice,
  signupSignInPath,
} from "../../lib/authPages";

test("sign-in from an invitation comes back to that invitation, not to billing", () => {
  expect(signupSignInPath("CODE-1", "studio", "monthly")).toBe(
    "/login?next=" + encodeURIComponent("/signup?invite=CODE-1"),
  );
  expect(signupSignInPath("", "agency", "annual")).toBe(
    "/login?next=" +
      encodeURIComponent("/billing?plan=agency&cadence=annual&onboarding=1"),
  );
  const page = readFileSync("app/(auth)/signup/page.tsx", "utf8");
  expect(page).toContain("signupSignInPath(code, plan, cadence)");
});

test("an HTML error page reads as the server's status, never as a JSON parse error", async () => {
  const html = new Response("<!DOCTYPE html><title>502</title>", {
    status: 502,
    headers: { "Content-Type": "text/html" },
  });
  expect(await readAnswer(html, "Sign-up is unavailable.")).toEqual({
    data: {},
    problem: "The server answered 502. Try again in a moment.",
  });
  const refused = Response.json(
    { error: "That invitation is not valid.", needsSignIn: true },
    { status: 409 },
  );
  expect(await readAnswer(refused, "fallback")).toEqual({
    data: { error: "That invitation is not valid.", needsSignIn: true },
    problem: "That invitation is not valid.",
  });
  expect(
    (
      await readAnswer(
        Response.json({}, { status: 503 }),
        "Sign-up is unavailable.",
      )
    ).problem,
  ).toBe("Sign-up is unavailable.");
  expect(await readAnswer(Response.json({ ok: true }), "fallback")).toEqual({
    data: { ok: true },
    problem: null,
  });
  const page = readFileSync("app/(auth)/signup/page.tsx", "utf8");
  expect(page).not.toMatch(/await response\.json\(\)/);
});

test("after a reset that needs the second factor, sign-in says the password changed", () => {
  expect(signInNotice(new URLSearchParams("passwordReset=1"))).toMatch(
    /Password changed.*authenticator code/,
  );
  expect(signInNotice(new URLSearchParams("next=/"))).toBeNull();
  const reset = readFileSync("app/(auth)/reset/[token]/page.tsx", "utf8");
  expect(reset).toContain("/login?passwordReset=1");
  const signIn = readFileSync("components/WelcomeSignIn.tsx", "utf8");
  expect(signIn).toContain("notice={signInNotice(params)}");
});

test("the invitation page asks for the policy before an account is made", () => {
  const page = readFileSync("app/(auth)/invite/[code]/page.tsx", "utf8");
  expect(page).toContain("accept: agreed");
  /* The tick is the shared required checkbox (components/AgeConfirm.tsx; lib/ageConfirm.ts), not a box of the page's own. */
  expect(page).toMatch(/<AgeConfirm[^>]*checked=\{agreed\}/);
  expect(readFileSync("components/AgeConfirm.tsx", "utf8")).toMatch(/type="checkbox" required/);
  /* The Content policy and Privacy notice stay in view under the tick, as on the sign-up page. */
  expect(page).toMatch(/<AgeConfirm[^>]*checked=\{agreed\}[^>]*\/>\s*<AgeConfirmDocs /);
  const route = readFileSync("app/api/auth/accept/route.ts", "utf8");
  expect(route).toContain("acceptedPolicy: policyAccepted(body)");
});

test("the invitation page links the Content policy and the Privacy notice under the tick, to the pages the sign-up page links", () => {
  const signup = readFileSync("app/(auth)/signup/page.tsx", "utf8");
  const docs = readFileSync("components/AgeConfirm.tsx", "utf8");
  const shared = docs.slice(docs.indexOf("export function AgeConfirmDocs"));
  for (const [href, words] of [["/policy", "Content policy"], ["/privacy", "Privacy notice"]]) {
    expect(signup).toContain(`href="${href}" target="_blank">${words}</Link>`);
    expect(shared).toContain(`href="${href}" target="_blank" rel="noopener">${words}</Link>`);
  }
  expect(shared).toMatch(/className="age-confirm-link"/);
  expect(readFileSync("app/(auth)/invite/[code]/page.tsx", "utf8")).toMatch(/<AgeConfirmDocs testId="invite-docs" \/>/);
  /* Readable, 44 px targets, a visible ring (rule 15): the links share the tick's own link style. */
  const css = readFileSync("components/age-confirm.css", "utf8");
  expect(css).toMatch(/\.age-confirm-link \{[^}]*min-height: 44px/);
  expect(css).toMatch(/\.age-confirm-link:focus-visible \{ outline: 2px solid/);
  expect(css).toMatch(/\.age-confirm-docs \{[^}]*font-size: 13px/);
});

/* Moved here when the prototype-12 build was deleted (23 Oct 2026; docs/old-shells.md): the join sheet (components/v12/join) went with it. */
test.fixme("the join sheet's age tick carries the Content policy and Privacy notice links (AgeConfirm then AgeConfirmDocs) — no home: the visitor join sheet is deleted; sign-up, invite and setup keep the tick (tests/age-confirm-workbench.spec.ts); owner question: does v31.16 bring a join sheet back?", () => {});
