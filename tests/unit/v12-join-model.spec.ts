import { test, expect } from "@playwright/test";
import { cleanCode, emailPath, inviteKind, joinTitle, loginPath, requestBody, requestProblem, JOIN_REASONS } from "../../components/v12/join/join-model";

/* The join sheet's model (components/v12/join/join-model.ts): titles by reason, the request body for today's
   POST /api/access-request, and what an invite code is by today's two routes. */

const fields = { name: " Ana ", email: "ana@studio.test", company: "Studio", role: "Agency", size: "11–50", want: "A 15 s ad" };

test("each reason has its title; only make and price carry the action's detail", () => {
  expect(JOIN_REASONS).toEqual(["start", "make", "upload", "ask", "download", "plus", "library", "price", "approve", "request"]);
  expect(joinTitle("start")).toBe("To start a board you need a Particl account");
  expect(joinTitle("make", "4 stills · 8 cr")).toBe("To make this you need a Particl account · 4 stills · 8 cr");
  expect(joinTitle("price", "Redraw · 2 cr")).toBe("To run this you need a Particl account · Redraw · 2 cr");
  expect(joinTitle("ask", "ignored")).toBe("To ask Atomik you need a Particl account");
  expect(joinTitle("request")).toBe("Request access to Particl");
  /* The free actions the prototype left ungated (Approve, Lock…) say why too. */
  expect(joinTitle("approve")).toBe("To change the sample you need a Particl account");
});

test("a request needs a name and a work email; its body never fills the route's honeypot", () => {
  expect(requestProblem({ ...fields, name: " " })).toBe("Tell us your name.");
  expect(requestProblem({ ...fields, email: "ana" })).toBe("Enter your work email.");
  expect(requestProblem(fields)).toBeNull();
  const body = requestBody(fields, "start");
  expect(body).toEqual({ name: "Ana", email: "ana@studio.test", note: "From the join sheet (start)", organisation: "Studio", role: "Agency", size: "11–50", brief: "A 15 s ad" });
  expect("company" in body).toBe(false);
  /* Only the listed roles and sizes are sent. */
  expect(requestBody({ ...fields, role: "CEO", size: "9000" }, "make")).not.toHaveProperty("role");
});

test("a code is a team invite, a new-workspace invite, expired or not valid, as today's routes answer", () => {
  const code = cleanCode("  ZZF 7K2Q ");
  expect(code).toBe("ZZF7K2Q");
  expect(inviteKind(code, { status: 200, body: { ok: true, workspace: "North", email: "a@b.test", name: "A" } }, null))
    .toEqual({ kind: "team", code, workspace: "North", email: "a@b.test", name: "A" });
  expect(inviteKind(code, { status: 410, body: { error: "That invite has expired. Ask for a new one." } }, null).kind).toBe("expired");
  expect(inviteKind(code, { status: 404, body: {} }, { status: 200, body: { email: "n@b.test", name: "" } }).kind).toBe("new");
  expect(inviteKind(code, { status: 404, body: {} }, { status: 409, body: { error: "used" } }).kind).toBe("expired");
  expect(inviteKind(code, { status: 404, body: {} }, { status: 404, body: { error: "not valid" } }).kind).toBe("invalid");
  expect(emailPath({ kind: "team", code: "A B", workspace: "", email: "", name: "" })).toBe("/invite/A%20B");
  expect(emailPath({ kind: "new", code: "X", email: "", name: "" })).toBe("/signup?invite=X");
  expect(emailPath({ kind: "expired", code: "X", why: "" })).toBeNull();
  expect(loginPath("/suites?guest=1")).toBe("/login?next=%2Fsuites%3Fguest%3D1");
  expect(loginPath("https://elsewhere.test")).toBe("/login?next=%2F");
});

test("the access request's note: as before for Guest Home, plus the join sheet's company, role and size", async () => {
  const { accessRequestNote } = await import("../../lib/accessRequestNote");
  /* Guest Home's request reads exactly as it did. */
  expect(accessRequestNote({ note: "From guest Home", make: "Ad films", brief: "A brief" })).toBe("From guest Home\nWhat they make: Ad films\nTheir brief: A brief");
  expect(accessRequestNote({})).toBe("");
  expect(accessRequestNote({ note: "From the join sheet (start)", organisation: "North", role: "Agency", size: "11–50", brief: "A 15 s ad" }))
    .toBe("From the join sheet (start)\nCompany: North\nRole: Agency\nCompany size: 11–50\nTheir brief: A 15 s ad");
  /* The honeypot field is never read into the note. */
  expect(accessRequestNote({ company: "bot" })).toBe("");
  expect(accessRequestNote({ brief: "x".repeat(5000) }).length).toBeLessThanOrEqual(1200);
});
