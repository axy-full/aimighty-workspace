import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newInterfaceOn } from "../../lib/newInterface";
import { DEFAULT_SITE, cleanSite, newInterfaceOffKey, sitePatch } from "../../lib/site/settings";

/* The new-interface switch (lib/newInterface.ts): on for every workspace (owner, 11 October 2026), with the platform owner's way back:
   "New interface for everyone" off puts everyone on today's screens; one `ni_off:<workspace id>` row keeps one workspace there. */

const dir = mkdtempSync(path.join(tmpdir(), "particl-ni-switch-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.PLATFORM_KEYS_FOR_NEW_WORKSPACES = "1";
delete process.env.TURSO_API_TOKEN;
delete process.env.TURSO_ORG;

test("on for any signed-in workspace; off with no workspace, for everyone when the owner says so, or for a workspace the owner keeps back", () => {
  expect(newInterfaceOn(null)).toBe(false);
  expect(newInterfaceOn({ id: "ws_customer" })).toBe(true);
  expect(newInterfaceOn({ id: "ws_customer" }, { everyone: true, workspaceOff: false })).toBe(true);
  expect(newInterfaceOn({ id: "ws_customer" }, { everyone: false })).toBe(false);
  expect(newInterfaceOn({ id: "ws_customer" }, { workspaceOff: true })).toBe(false);
});

test("the global switch is on by default and only a stored false turns it off", () => {
  expect(DEFAULT_SITE.newInterfaceEveryone).toBe(true);
  expect(cleanSite(undefined).newInterfaceEveryone).toBe(true);
  expect(cleanSite({ newInterfaceEveryone: "no" }).newInterfaceEveryone).toBe(true);
  expect(cleanSite({ newInterfaceEveryone: false }).newInterfaceEveryone).toBe(false);
});

test("the owner's change is checked: a boolean for everyone, one workspace id to add or remove, nothing uncapped by a list", () => {
  expect(sitePatch({ newInterfaceEveryone: false })).toEqual({ patch: { newInterfaceEveryone: false } });
  expect(sitePatch({ newInterfaceEveryone: "off" })).toHaveProperty("error");
  expect(sitePatch({ newInterfaceOffAdd: "ws_a" })).toEqual({ patch: { newInterfaceOffAdd: "ws_a" } });
  expect(sitePatch({ newInterfaceOffRemove: "ws_a" })).toEqual({ patch: { newInterfaceOffRemove: "ws_a" } });
  expect(sitePatch({ newInterfaceOffAdd: "bad id; drop" })).toHaveProperty("error");
  expect(sitePatch({ newInterfaceOffAdd: ["ws_a"] })).toHaveProperty("error");
  expect(sitePatch({ newInterfaceOff: ["ws_a"] })).toHaveProperty("error");
  expect(newInterfaceOffKey("ws_a")).toBe("ni_off:ws_a");
});

test.describe("on the platform database", () => {
  test.describe.configure({ mode: "serial" });
  type Ws = { id: string };
  const made: Ws[] = [];
  test.beforeAll(async () => {
    const { createAccount, createWorkspace } = await import("../../lib/platform");
    for (const label of ["one", "two", "three"]) {
      const owner = await createAccount(`${label}@example.test`, label, "not-a-real-hash");
      made.push(await createWorkspace({ name: label, owner }));
    }
  });

  test("a workspace is kept on today's screens by its own row; the others are untouched; removing it brings it back", async () => {
    const { newInterfaceFor } = await import("../../lib/newInterface.server");
    const { writeSite, listNewInterfaceOff } = await import("../../lib/site/settings.server");
    const [a, b] = made;
    expect(await newInterfaceFor(a)).toBe(true);
    expect(await newInterfaceFor(b)).toBe(true);
    await writeSite({ newInterfaceOffAdd: a.id }, "owner");
    expect(await newInterfaceFor(a)).toBe(false);
    expect(await newInterfaceFor(b)).toBe(true);
    expect(await listNewInterfaceOff()).toEqual([a.id]);
    await writeSite({ newInterfaceOffRemove: a.id }, "owner");
    expect(await newInterfaceFor(a)).toBe(true);
    expect(await listNewInterfaceOff()).toEqual([]);
  });

  test("there is no cap on how many are kept back, and an unknown workspace is refused", async () => {
    const { writeSite, listNewInterfaceOff } = await import("../../lib/site/settings.server");
    const { platformDb } = await import("../../lib/platform");
    for (let i = 0; i < 60; i++) {
      await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES (?, '1', ?, 'x')`, args: [newInterfaceOffKey(`ws_filler_${i}`), i] });
    }
    await writeSite({ newInterfaceOffAdd: made[0].id }, "owner");
    expect(await listNewInterfaceOff()).toHaveLength(61);
    await expect(writeSite({ newInterfaceOffAdd: "ws_not_here" }, "owner")).rejects.toThrow(/not on this deployment/);
    await platformDb().execute({ sql: `DELETE FROM platform_layer WHERE key GLOB 'ni_off:*'`, args: [] });
  });

  test("the global switch off puts every workspace back; on again restores them", async () => {
    const { newInterfaceFor } = await import("../../lib/newInterface.server");
    const { writeSite } = await import("../../lib/site/settings.server");
    await writeSite({ newInterfaceEveryone: false }, "owner");
    for (const w of made) expect(await newInterfaceFor(w)).toBe(false);
    expect(await newInterfaceFor(null)).toBe(false);
    await writeSite({ newInterfaceEveryone: true }, "owner");
    for (const w of made) expect(await newInterfaceFor(w)).toBe(true);
  });

  test("a setting that can't be read means on", async () => {
    const { newInterfaceFor } = await import("../../lib/newInterface.server");
    const { platformDb } = await import("../../lib/platform");
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', '{not json', 0, 'x') ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [] });
    expect(await newInterfaceFor(made[2])).toBe(true);
  });
});
