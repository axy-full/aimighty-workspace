import { test, expect } from "@playwright/test";
import nextConfig from "../../next.config";
import { seedProject } from "../../lib/workbench/studio";
import { movieHandoffKey, movieScopeFor, movieScopeIsCurrent, readMovieHandoff } from "../../lib/workbench/movie-handoff";
import { accountScopeFor, workbenchScopeFor } from "../../lib/workbench/request-scope";
import { defaultMovieOptions, moviePlan } from "../../lib/workbench/movie";

test("movie snapshots reject another account in the same workspace and expire before loading content", () => {
  const project = seedProject();
  const scope = "particl-active-workspace-a-user-one";
  const raw = JSON.stringify({ scope, project, createdAt: Date.now() });
  expect(readMovieHandoff(raw, scope).name).toBe(project.name);
  expect(() =>
    readMovieHandoff(raw, "particl-active-workspace-a-user-two"),
  ).toThrow(/another account/);
  expect(() =>
    readMovieHandoff(raw, "particl-active-workspace-b-user-one"),
  ).toThrow(/another account/);
  expect(() =>
    readMovieHandoff(
      JSON.stringify({ scope, project, createdAt: Date.now() - 600_001 }),
      scope,
    ),
  ).toThrow(/expired/);
  expect(() =>
    readMovieHandoff(
      JSON.stringify({
        scope,
        project: { ...project, aspect: "unsupported" },
        createdAt: Date.now(),
      }),
      scope,
    ),
  ).toThrow();
});

test("the renderer reads a handoff under the same scope /workbench wrote it with, visitors and workspace-less accounts included", () => {
  /* app/workbench/page.tsx: a workspace, an account without one, or 'particl-visitor'. */
  expect(movieScopeFor(null)).toBe("particl-visitor");
  expect(movieScopeFor({ id: "user-one", workspaceId: "workspace-a" })).toBe(workbenchScopeFor("workspace-a", "user-one"));
  expect(movieScopeFor({ id: "user-one", workspaceId: null })).toBe(accountScopeFor("user-one"));
  const project = seedProject();
  for (const scope of [movieScopeFor(null), movieScopeFor({ id: "user-one" })]) {
    const raw = JSON.stringify({ scope, project, createdAt: Date.now() });
    expect(readMovieHandoff(raw, scope).name).toBe(project.name);
  }
  const token = "0f8fad5b-d9cb-469f-a165-70867728950e";
  expect(movieHandoffKey(token, movieScopeFor(null))).toBe(`particl-movie-visitor:${token}`);
  expect(movieHandoffKey(token, movieScopeFor({ id: "user-one" }))).toBe(`particl-movie-private:${token}`);
});

test("Render re-checks the identity: a workspace-less account passes, a changed or signed-out one does not", async () => {
  /* The real answers: /api/me is a 401 "Pick a workspace first." without a workspace (lib/auth.ts
     requireUser); GET /api/workspaces is 401 signed out and 409 on a scope header that is not this session's. */
  type Answer = { status: number; body?: unknown };
  const session = (me: Answer, workspaces?: (header: string | null) => Answer) => {
    const calls: { url: string; header: string | null }[] = [];
    const request = (async (url: string, init?: RequestInit) => {
      const header = new Headers(init?.headers).get("X-Workbench-Scope");
      calls.push({ url, header });
      const answer = url === "/api/me" ? me : workspaces?.(header);
      if (!answer) throw new Error(`unexpected ${url}`);
      return Response.json(answer.body ?? {}, { status: answer.status });
    }) as typeof fetch;
    return { request, calls };
  };
  const signal = new AbortController().signal;
  const account = accountScopeFor("user-one");
  const workspace = workbenchScopeFor("workspace-a", "user-one");
  const noWorkspace = { status: 401, body: { error: "Pick a workspace first." } };
  const signedOut = { status: 401, body: { error: "Not signed in" } };
  const accountSession = (header: string | null) =>
    header === null || header === account ? { status: 200, body: { active: null, workspaces: [] } } : { status: 409 };

  /* The finding's path: a workspace-less account opened the renderer from /workbench and clicks Render. */
  const same = session(noWorkspace, accountSession);
  expect(await movieScopeIsCurrent(account, signal, same.request)).toBe(true);
  expect(same.calls).toEqual([{ url: "/api/me", header: null }, { url: "/api/workspaces", header: account }]);
  /* Another workspace-less account in this browser now, or signed out since. */
  expect(await movieScopeIsCurrent(accountScopeFor("user-two"), signal, session(noWorkspace, accountSession).request)).toBe(false);
  expect(await movieScopeIsCurrent(account, signal, session(signedOut, () => signedOut).request)).toBe(false);
  /* A visitor stays a visitor only while signed out. */
  expect(await movieScopeIsCurrent(movieScopeFor(null), signal, session(signedOut, () => signedOut).request)).toBe(true);
  expect(await movieScopeIsCurrent(movieScopeFor(null), signal, session(noWorkspace, accountSession).request)).toBe(false);
  /* Inside a workspace /api/me answers on its own. */
  const me = { status: 200, body: { id: "user-one", workspace: { id: "workspace-a" } } };
  const inside = session(me);
  expect(await movieScopeIsCurrent(workspace, signal, inside.request)).toBe(true);
  expect(inside.calls).toHaveLength(1);
  expect(await movieScopeIsCurrent(account, signal, session(me).request)).toBe(false);
  expect(await movieScopeIsCurrent(workspace, signal, session(noWorkspace, accountSession).request)).toBe(false);
  await expect(movieScopeIsCurrent(workspace, signal, session({ status: 503 }).request)).rejects.toThrow(/could not be verified/);
  await expect(movieScopeIsCurrent(account, signal, session(noWorkspace, () => ({ status: 503 })).request)).rejects.toThrow(/could not be verified/);
});

test("movie planning keeps cumulative frame time and refuses unbounded edits", () => {
  const project = seedProject();
  project.fps = 25;
  project.aspect = "9:16";
  project.shots = project.shots
    .slice(0, 2)
    .map((shot, i) => ({ ...shot, sourceIn: i * 7, duration: i ? 38 : 17 }));
  const plan = moviePlan(project, defaultMovieOptions);
  expect(plan.clips.map((clip) => [clip.startFrame, clip.sourceIn])).toEqual([
    [0, 0],
    [17, 7],
  ]);
  expect(plan.duration).toBe(2.2);
  expect([plan.width, plan.height]).toEqual([720, 1280]);
  project.shots[1].duration = 25 * 180;
  expect(() => moviePlan(project, defaultMovieOptions)).toThrow(
    /up to 3 minutes/,
  );
});

test("WASM is restricted to the movie document and isolated OCR worker", async () => {
  const entries = await nextConfig.headers!();
  const general = entries.find((entry) => entry.source === "/(.*)")!;
  const policy = general.headers.find(
    (header) => header.key === "Content-Security-Policy",
  )!.value;
  expect(policy).not.toContain("wasm-unsafe-eval");
  expect(policy).not.toContain("worker-src");
  /* The team canvas's live room is the only websocket the app opens. */
  expect(policy).toContain("connect-src 'self' https: wss://*.liveblocks.io;");
  const movie = entries.filter((entry) =>
    entry.headers.some((header) => header.value.includes("wasm-unsafe-eval")),
  );
  expect(movie.map((entry) => entry.source)).toEqual(["/workbench/movie", "/vendor/tesseract-7.0.0/worker.min.js"]);
  const moviePolicy = movie[0].headers.find(
    (header) => header.key === "Content-Security-Policy",
  )!.value;
  expect(moviePolicy).toContain("worker-src 'self' blob:");
  expect(moviePolicy).toContain("connect-src 'self';");
  expect(moviePolicy).not.toContain("liveblocks");
});
