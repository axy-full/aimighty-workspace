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
  expect(page).toMatch(/type="checkbox" required/);
  const route = readFileSync("app/api/auth/accept/route.ts", "utf8");
  expect(route).toContain("acceptedPolicy: policyAccepted(body)");
});
