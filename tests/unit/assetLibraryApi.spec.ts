import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import { assetCursor, assetPageQuery, parseAssetCursor } from "../../lib/assetPagination";

const dir = mkdtempSync(path.join(tmpdir(), "particl-asset-library-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

function workspace(id: string): TenantWorkspace {
  return {
    id, name: id, slug: id, legacy: false,
    dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: false, allowanceUsd: null,
    ownerId: "member", createdAt: 0, gatewayKeyId: null,
    suspendedAt: null, suspendedReason: null, flaggedAt: null,
    flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
}

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    mod, mod.exports,
  );
  return mod.exports as T;
}

async function seed(ws: TenantWorkspace, ids = ["a", "b", "c", "d"]) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    await ready();
    await db().batch(ids.flatMap((id, i) => [
      {
        sql: `INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind,duration_s)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [id, i === 0 ? "sound_100%.wav" : `Reference ${id}.png`, i === 0 ? "audio/wav" : "image/png", i === 0 ? "wav" : "png", 100, "a".repeat(64), i === 0 ? null : 100, i === 0 ? null : 100, "https://private.blob.invalid/original?token=do-not-return", i < 3 ? 200 : 100, i === 0 ? "file" : "image", i === 0 ? 2 : null],
      },
      {
        sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title)
          VALUES(?,'fixture','Cinematic reference','{}','succeeded',?,?,?,?)`,
        args: [id, i < 3 ? 200 : 100, 200, i === 0 ? "audio" : "image", `Take ${id}`],
      },
    ]));
  });
}

async function routes(initial: TenantWorkspace) {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const library = await import("../../lib/uploadLibrary");
  const pagination = await import("../../lib/assetPagination");
  const scope = await import("../../lib/workbench/request-scope");
  const jobs = await import("../../lib/jobs");
  const productions = await import("../../lib/productions");
  const shots = await import("../../lib/shots");
  let selected = initial, signedIn = true, mfaEnabled = true, reads = 0, syncs = 0;
  const auth = load<typeof import("../../lib/auth")>("lib/auth.ts", {
    "./recovery": { recoveryRoute: (handler: unknown) => handler },
    "./mediaBindings": { MediaSourceError: class extends Error {} },
    "./workbench/request-scope": scope,
    "./db": database, "./tenant": tenant,
    "next/headers": {
      cookies: async () => ({ get: () => signedIn ? { value: "fixture-session" } : undefined }),
      headers: async () => new Headers(),
    },
    "./platform": {
      sessionLookup: async () => ({
        account: { id: "member", name: "Studio member", email: "member@example.invalid", mfa_enabled: mfaEnabled ? 1 : 0 },
        workspaceId: selected.id,
      }),
      workspacesFor: async () => [{ workspace: selected, role: "member" }],
    },
  });
  const dependencies = {
    "@/lib/auth": auth, "@/lib/tenant": tenant,
    "@/lib/workbench/request-scope": scope,
    "@/lib/assetPagination": pagination,
    "@/lib/uploadLibrary": {
      listLibraryUploads: (...args: Parameters<typeof library.listLibraryUploads>) => { reads++; return library.listLibraryUploads(...args); },
      getLibraryUpload: (...args: Parameters<typeof library.getLibraryUpload>) => { reads++; return library.getLibraryUpload(...args); },
    },
    "@/lib/jobs": {
      listGenerations: (...args: Parameters<typeof jobs.listGenerations>) => { reads++; return jobs.listGenerations(...args); },
      getGeneration: (...args: Parameters<typeof jobs.getGeneration>) => { reads++; return jobs.getGeneration(...args); },
      syncGeneration: async (value: unknown) => { syncs++; return value; },
      syncActive: async () => { throw new Error("Unit reads must set sync=0"); },
    },
    "@/lib/uploadReservations": {}, "@/lib/uploadIntake": {},
    "@/lib/recovery": {}, "@/lib/workbench/records": {},
    "@/lib/mediaBindings": {}, "@/lib/db": database,
    "@/lib/mediaDeletion": {}, "@/lib/cache": {},
    "@/lib/shots": {
      ...shots,
      listShots: (...args: Parameters<typeof shots.listShots>) => { reads++; return shots.listShots(...args); },
    },
    "@/lib/productions": {
      ...productions,
      listProductions: (...args: Parameters<typeof productions.listProductions>) => { reads++; return productions.listProductions(...args); },
    },
    "@/lib/creditSql": await import("../../lib/creditSql"),
    "@/lib/push": {},
  };
  return {
    uploads: load<typeof import("../../app/api/uploads/route")>("app/api/uploads/route.ts", dependencies).GET,
    metadata: load<typeof import("../../app/api/uploads/[id]/metadata/route")>("app/api/uploads/[id]/metadata/route.ts", dependencies).GET,
    jobs: load<typeof import("../../app/api/jobs/route")>("app/api/jobs/route.ts", dependencies).GET,
    job: load<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", dependencies).GET,
    jobDelete: load<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", dependencies).DELETE,
    jobPatch: load<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", dependencies).PATCH,
    productions: load<typeof import("../../app/api/productions/route")>("app/api/productions/route.ts", dependencies).GET,
    shots: load<typeof import("../../app/api/shots/route")>("app/api/shots/route.ts", dependencies).GET,
    readCount: () => reads,
    syncCount: () => syncs,
    switch: (ws: TenantWorkspace) => { selected = ws; },
    signIn: (value: boolean) => { signedIn = value; },
    mfa: (value: boolean) => { mfaEnabled = value; },
  };
}

test("upload and take pages traverse equal timestamps once, with bounded lookahead and stable continuation", async () => {
  const ws = workspace("pagination");
  await seed(ws);
  const api = await routes(ws);
  for (const type of ["uploads", "jobs"] as const) {
    const query = new URLSearchParams({ limit: "2", ...(type === "jobs" ? { pagination: "stable", sync: "0" } : {}) });
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 2; page++) {
      if (cursor) query.set("cursor", cursor);
      const response = await api[type](new Request(`https://studio.test/api/${type}?${query}`), undefined);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = await response.json();
      ids.push(...body[type === "uploads" ? "uploads" : "generations"].map((row: { id: string }) => row.id));
      cursor = type === "uploads" ? body.nextCursor : body.nextPageCursor;
      if (page === 0) expect(parseAssetCursor(cursor)).toEqual({ createdAt: 200, id: "b" });
      else expect(cursor).toBeNull();
    }
    expect(ids).toEqual(["c", "b", "a", "d"]);
  }
  // Existing timestamp consumers retain their old response and semantics.
  const legacy = await (await api.jobs(new Request("https://studio.test/api/jobs?limit=2&sync=0&before=200"), undefined)).json();
  expect(legacy.generations.map((g: { id: string }) => g.id)).toEqual(["d"]);
  expect(legacy.nextCursor).toBeNull();
});

test("filename search is literal and metadata keeps files, hashes and canonical URLs without storage credentials", async () => {
  const ws = workspace("metadata");
  await seed(ws, ["a /?", "b"]);
  const api = await routes(ws);
  for (const q of ["100%", "sound_", "SOUND_100%", "%", "_"]) {
    const body = await (await api.uploads(new Request(`https://studio.test/api/uploads?${new URLSearchParams({ q })}`), undefined)).json();
    expect(body.uploads.map((row: { id: string }) => row.id)).toEqual(["a /?"]);
    expect(body.nextCursor).toBeNull();
  }
  const response = await api.metadata(new Request("https://studio.test/api/uploads/a/metadata"), { params: Promise.resolve({ id: "a /?" }) });
  const body = await response.json();
  expect(body.upload).toMatchObject({ kind: "file", mime: "audio/wav", sha256: "a".repeat(64), url: "/api/uploads/a%20%2F%3F", durationS: 2, width: null, height: null });
  expect(Object.keys(body.upload).sort()).toEqual(["id", "filename", "mime", "kind", "bytes", "width", "height", "durationS", "sha256", "url", "createdAt"].sort());
  expect(JSON.stringify(body)).not.toContain("do-not-return");
  expect(JSON.stringify(body)).not.toContain("private.blob.invalid");
  const filtered = await (await api.jobs(new Request("https://studio.test/api/jobs?pagination=stable&sync=0&kind=audio&q=Take"), undefined)).json();
  expect(filtered.generations.map((g: { id: string }) => g.id)).toEqual(["a /?"]);
});

test("all library reads enforce real authentication, MFA and captured workspace scope before touching data", async () => {
  const first = workspace("isolation-first"), second = workspace("isolation-second");
  await seed(first, ["private-first"]);
  await seed(second, ["private-second"]);
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  for (const ws of [first, second]) await runInTenant(ws, async () => {
    await db().batch([
      { sql: "INSERT INTO productions(id,name,created_at) VALUES(?,?,0)", args: [ws.id, ws.name] },
      { sql: "INSERT INTO projects(id,name,created_at,production_id) VALUES(?,?,0,?)", args: [ws.id, ws.name, ws.id] },
      { sql: "INSERT INTO shots(id,project_id,title,created_at,updated_at) VALUES(?,?,?,0,0)", args: [ws.id, ws.id, ws.name] },
    ]);
  });
  const api = await routes(first);
  const calls = (headers: Record<string, string> = {}) => [
    () => api.uploads(new Request("https://studio.test/api/uploads", { headers }), undefined),
    () => api.metadata(new Request("https://studio.test/api/uploads/private-first/metadata", { headers }), { params: Promise.resolve({ id: "private-first" }) }),
    () => api.jobs(new Request("https://studio.test/api/jobs?pagination=stable&sync=0", { headers }), undefined),
    () => api.job(new Request("https://studio.test/api/jobs/private-first", { headers }), { params: Promise.resolve({ id: "private-first" }) }),
    () => api.productions(new Request("https://studio.test/api/productions", { headers }), undefined),
    () => api.shots(new Request("https://studio.test/api/shots", { headers }), undefined),
  ];
  api.signIn(false);
  for (const call of calls()) expect((await call()).status).toBe(401);
  expect(api.readCount()).toBe(0);
  api.signIn(true);
  api.switch({ ...first, requiresMfa: true }); api.mfa(false);
  for (const call of calls()) expect((await call()).status).toBe(428);
  expect(api.readCount()).toBe(0);
  api.switch(second); api.mfa(true);
  for (const call of calls({ "X-Workbench-Scope": `particl-active-${first.id}-member` })) expect((await call()).status).toBe(409);
  expect(api.readCount()).toBe(0);
  const [list, metadata, jobs, job, productions, shots] = await Promise.all(calls().map((call) => call()));
  expect((await list.json()).uploads.map((u: { id: string }) => u.id)).toEqual(["private-second"]);
  expect((await jobs.json()).generations.map((g: { id: string }) => g.id)).toEqual(["private-second"]);
  expect(metadata.status).toBe(404); expect(job.status).toBe(404);
  expect((await productions.json()).productions.map((p: { id: string }) => p.id)).toEqual([second.id]);
  expect((await shots.json()).shots.map((s: { id: string }) => s.id)).toEqual([second.id]);
  api.switch(first);
  for (const call of calls({ "X-Workbench-Scope": `particl-active-${first.id}-member` })) expect((await call()).status).toBe(200);
});

test("generation writes from a browser session are refused without the captured workspace scope", async () => {
  const ws = workspace("delete-scope");
  await seed(ws, ["private-delete"]);
  const api = await routes(ws);
  const ctx = { params: Promise.resolve({ id: "private-delete" }) };
  const attempts = (headers: Record<string, string> = {}) => [
    () => api.jobDelete(new Request("https://studio.test/api/jobs/private-delete", { method: "DELETE", headers }), ctx),
    () => api.jobPatch(new Request("https://studio.test/api/jobs/private-delete", { method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ title: "Renamed" }) }), ctx),
  ];
  api.signIn(false);
  for (const call of attempts()) expect((await call()).status).toBe(401);
  api.signIn(true); api.switch(ws); api.mfa(true);
  // No header at all, and a header captured for another workspace, both stop
  // before any write (the deletion transaction's dependencies are stubbed).
  for (const call of attempts()) expect((await call()).status).toBe(409);
  for (const call of attempts({ "X-Workbench-Scope": "particl-active-somewhere-else-member" })) expect((await call()).status).toBe(409);
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    const row = (await db().execute("SELECT title FROM generations WHERE id='private-delete'")).rows[0];
    expect(row).toBeTruthy();
    expect(row.title).not.toBe("Renamed");
  });
  expect(api.readCount()).toBe(0);
});

test("malformed page parameters fail with 400 rather than truncating or querying an unbounded page", async () => {
  const api = await routes(workspace("invalid"));
  const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const invalid = [
    "limit=0", "limit=501", "limit=1.5", "limit=-1", "limit=1e2", "limit=", "limit=2&limit=3",
    "q=" + "x".repeat(201), "q=%00", "q=one&q=two", "cursor=", "cursor=not-json", "cursor=" + "a".repeat(1025),
    "cursor=" + cursor({ createdAt: -1, id: "a" }),
    "cursor=" + cursor({ createdAt: 1, id: "a", extra: "unexpected" }),
    "cursor=" + cursor({ createdAt: Number.MAX_SAFE_INTEGER + 1, id: "a" }),
    "cursor=" + cursor({ createdAt: 1, id: "a".repeat(201) }),
    "cursor=" + cursor({ createdAt: 1, id: "a" }) + "&cursor=" + cursor({ createdAt: 1, id: "b" }),
  ];
  for (const query of invalid) {
    expect((await api.uploads(new Request(`https://studio.test/api/uploads?${query}`), undefined)).status, query).toBe(400);
    expect((await api.jobs(new Request(`https://studio.test/api/jobs?pagination=stable&sync=0&${query}`), undefined)).status, query).toBe(400);
  }
  expect(assetPageQuery(new URLSearchParams(), 200).limit).toBe(200);
  expect(assetPageQuery(new URLSearchParams("limit=500"), 200).limit).toBe(500);
  expect(parseAssetCursor(assetCursor({ createdAt: 0, id: "zero" }))).toEqual({ createdAt: 0, id: "zero" });
  for (const query of ["pagination=unknown", "pagination=stable&before=1", "cursor=unused"]) {
    expect((await api.jobs(new Request(`https://studio.test/api/jobs?sync=0&${query}`), undefined)).status).toBe(400);
  }
});

test("single-take sync=0 reads persisted drag metadata without invoking provider reconciliation", async () => {
  const ws = workspace("read-only-take"); await seed(ws, ["take"]);
  const api = await routes(ws);
  const params = { params: Promise.resolve({ id: "take" }) };
  const metadata = await api.job(new Request("https://studio.test/api/jobs/take?sync=0"), params);
  expect(metadata.status).toBe(200);
  expect(metadata.headers.get("cache-control")).toBe("private, no-store");
  expect((await metadata.json()).generation.id).toBe("take");
  expect(api.syncCount()).toBe(0);
  expect((await api.job(new Request("https://studio.test/api/jobs/take"), params)).status).toBe(200);
  expect(api.syncCount()).toBe(1);
});

test("upload and generation keyset queries use indexes installed in tenant bootstrap", async () => {
  const ws = workspace("indexes"); await seed(ws);
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    const uploads = await db().execute("EXPLAIN QUERY PLAN SELECT id FROM uploads WHERE (created_at,id)<(200,'b') ORDER BY created_at DESC,id DESC LIMIT 2");
    const jobs = await db().execute("EXPLAIN QUERY PLAN SELECT id FROM generations WHERE deleted=0 AND (created_at,id)<(200,'b') ORDER BY created_at DESC,id DESC LIMIT 2");
    expect(JSON.stringify(uploads.rows)).toContain("idx_uploads_created_id");
    expect(JSON.stringify(jobs.rows)).toContain("idx_gen_library");
    expect(JSON.stringify([...uploads.rows, ...jobs.rows])).not.toContain("TEMP B-TREE");
  });
});
