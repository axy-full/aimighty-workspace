import { test, expect, request } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { DEFAULT_MODEL_ID } from "../lib/models";

/**
 * Rule 6, timed: a stranger with an invitation → account → workspace →
 * the starter production → a first render, against a local dev server
 * whose engines are mocked. It never runs against a deployment: the
 * server must say it is mocking, and it must be on localhost.
 */
test("a stranger with an invite reaches a first render inside five minutes", async () => {
  test.setTimeout(6 * 60_000);
  const base = process.env.PW_BASE_URL ?? "http://localhost:4551";
  const api = await request.newContext({ baseURL: base });
  const health = await api.get("/api/health").then((r) => r.json()).catch(() => null);
  test.skip(!health?.mock || !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(base), "runs only against a local dev server with mocked engines");

  const t0 = Date.now();
  // The invitation the platform owner would have sent.
  const platform = createClient({ url: "file:.data/ark.db" });
  const code = randomBytes(18).toString("base64url");
  const email = `starter-${Date.now()}@example.test`;
  await platform.execute({
    sql: `INSERT INTO signup_invites (code, email, name, note, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`,
    args: [code, email, "Test Person", "onboarding test", "test", Date.now(), Date.now() + 86_400_000],
  });

  const signup = await api.post("/api/auth/signup", {
    data: { code, name: "Test Person", email, workspace: `Onboarding ${Date.now()}`, password: "a long passphrase for a test account 42", accept: true },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();

  const projects = await api.get("/api/projects").then((r) => r.json());
  const starter = (projects.projects as { id: string; starter?: boolean; name: string }[]).find((p) => p.starter);
  expect(starter, "the workspace opens on a starter production").toBeTruthy();
  const shots = await api.get(`/api/shots?projectId=${starter!.id}`).then((r) => r.json());
  expect(shots.shots.length).toBe(3);
  const cast = await api.get(`/api/cast?projectId=${starter!.id}`).then((r) => r.text());
  expect(cast).toContain("Mara");

  const gen = await api.post("/api/generate", {
    data: {
      prompt: "A courier crosses a wet rooftop at dawn, static wide.",
      model: DEFAULT_MODEL_ID, ratio: "16:9", resolution: "1080p", duration: 5,
      generateAudio: true, watermark: false, seed: null,
      projectId: starter!.id, shotId: shots.shots[0].id, task: "generate", sourceGenId: null, references: [],
    },
  });
  expect(gen.status(), await gen.text()).toBeLessThan(300);
  const { id } = await gen.json();
  let status = "queued";
  for (let i = 0; i < 90 && !["succeeded", "failed"].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    status = (await api.get(`/api/jobs/${id}`).then((r) => r.json())).generation?.status ?? status;
  }
  expect(status).toBe("succeeded");
  const secs = (Date.now() - t0) / 1000;
  console.log(`onboarding: invitation → first render in ${secs.toFixed(1)}s`);
  expect(secs).toBeLessThan(300);
});
