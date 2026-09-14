import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { creditsApply } from "../../lib/credits";
import type { TenantWorkspace } from "../../lib/tenant";

function teamRoute(
  options: {
    legacy?: boolean;
    platformKeys?: boolean;
    denied?: boolean;
    internalTest?: boolean;
  } = {},
) {
  const workspace = {
    id: options.legacy ? "ws_legacy" : "ws_customer",
    name: "Our workspace",
    slug: "ours",
    legacy: options.legacy ?? false,
    usesPlatformKeys: options.platformKeys ?? true,
    internalTest: options.internalTest ?? false,
  } as TenantWorkspace;
  const queries: {
    source: "platform" | "tenant";
    sql: string;
    args?: unknown[];
  }[] = [];
  const platform = {
    execute: async (statement: { sql: string; args: unknown[] }) => {
      queries.push({ source: "platform", ...statement });
      expect(statement.args[0]).toBe(workspace.id);
      expect(statement.sql).toContain(
        "WHERE m.workspace_id = ?".replace(
          "m.",
          statement.sql.includes("memberships") ? "m." : "",
        ),
      );
      return {
        rows: statement.sql.includes("memberships")
          ? [
              {
                id: "our_admin",
                email: "our-admin@example.test",
                name: "Our admin",
                role: "owner",
                m_disabled: 0,
                a_disabled: 0,
                last_seen: 123,
                created_at: 100,
                joined_at: 101,
              },
            ]
          : [],
      };
    },
  };
  const tenant = {
    execute: async (sql: string) => {
      queries.push({ source: "tenant", sql });
      // Deliberately include the private column even when not selected, so the
      // serialization guard is tested independently of the SQL projection.
      return { rows: [{ id: "our_admin", clips: 4, spend: 47.123456789 }] };
    },
  };
  const mocks: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "@/lib/mail": {
      mailConfigured: () => false,
      mailFrom: () => "studio@example.test",
    },
    "@/lib/db": { db: () => tenant, ready: async () => {}, now: () => 1000 },
    "@/lib/platform": {
      platformDb: () => platform,
      platformReady: async () => {},
    },
    "@/lib/tenant": { requireTenant: () => workspace },
    "@/lib/credits": { creditsApply },
    "@/lib/auth": {
      withTenant: (handler: unknown) => handler,
      requireAdmin: async () =>
        options.denied
          ? {
              response: Response.json(
                { error: "Admins only" },
                { status: 403 },
              ),
            }
          : { user: { id: "our_admin", owner: true } },
      isPlatformOwner: async () => true,
    },
  };
  const compiled = ts.transpileModule(
    readFileSync("app/api/team/route.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const exports: { GET?: () => Promise<Response> } = {};
  const require = createRequire(path.resolve("app/api/team/route.ts"));
  vm.runInNewContext(compiled, {
    exports,
    Response,
    require: (name: string) => mocks[name] ?? require(name),
  });
  return { GET: exports.GET!, queries };
}

test("credit workspace team response omits provider spend even for a platform owner", async () => {
  const { GET, queries } = teamRoute();
  const response = await GET();
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body.users).toHaveLength(1);
  expect(body.users[0].clips).toBe(4);
  expect(body.users[0]).not.toHaveProperty("spend");
  expect(JSON.stringify(body)).not.toContain("47.123456789");
  expect(queries.find((query) => query.source === "tenant")?.sql).not.toMatch(
    /cost_usd|refine_cost_usd/,
  );
});

for (const [label, options] of [
  ["legacy internal dollars", { legacy: true }],
  ["workspace-owned vendor keys", { platformKeys: false }],
] as const) {
  test(`${label} keeps its existing dollar spend without changing units`, async () => {
    const { GET, queries } = teamRoute(options);
    const body = await (await GET()).json();
    expect(body.users[0]).toMatchObject({ clips: 4, spend: 47.123456789 });
    expect(queries.find((query) => query.source === "tenant")?.sql).toContain(
      "cost_usd",
    );
  });
}

test("an internal-test flag alone does not expose costs in a credit workspace", async () => {
  const { GET } = teamRoute({ internalTest: true });
  expect((await (await GET()).json()).users[0]).not.toHaveProperty("spend");
});

test("a denied team request cannot read either workspace's roster or costs", async () => {
  const { GET, queries } = teamRoute({ denied: true });
  expect((await GET()).status).toBe(403);
  expect(queries).toHaveLength(0);
});
