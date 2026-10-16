import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The engine gate (lib/engineGate.ts): the owner's rule for every engine, 15 Oct 2026. Mocked: local temporary databases only; no engine is called.
 * The switch name below is a sample; each engine passes its own.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-engine-gate-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
test.afterEach(() => { delete process.env.EXAMPLE_ENGINE_ENABLED; });

test("the engine gate: the engine's own switch AND (the house OR a listed workspace); the switch is the kill switch; fail closed", async () => {
  const { engineEnabled, enginesOnWorkspaces } = await import("../../lib/engineGate");
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const customer = { id: "ws_gate_customer" };
  const setList = (value: unknown) => platformDb().execute({
    sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [typeof value === "string" ? value : JSON.stringify(value)],
  });
  const before = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await setList({ openSignup: false, enginesOnWorkspaces: [] });
    /* Switch unset or anything but "1": off for everyone, the house included. */
    for (const v of [undefined, "", "0", "true", "yes", "on"]) {
      if (v === undefined) delete process.env.EXAMPLE_ENGINE_ENABLED; else process.env.EXAMPLE_ENGINE_ENABLED = v;
      expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", { id: "ws_legacy" }), String(v)).toBe(false);
    }
    process.env.EXAMPLE_ENGINE_ENABLED = "1";
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", { id: "ws_legacy" })).toBe(true);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", customer)).toBe(false);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", null)).toBe(false);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", undefined)).toBe(false);
    /* Listed: on for that workspace and no other; and the list alone, with the switch off, is nothing. */
    await setList({ enginesOnWorkspaces: [customer.id, "bad id; drop", 7] });
    expect(await enginesOnWorkspaces()).toEqual([customer.id]);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", customer)).toBe(true);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", { id: "ws_gate_other" })).toBe(false);
    delete process.env.EXAMPLE_ENGINE_ENABLED;
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", customer)).toBe(false);
    /* An unreadable row is nobody. */
    process.env.EXAMPLE_ENGINE_ENABLED = "1";
    await setList("{not json");
    expect(await enginesOnWorkspaces()).toEqual([]);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", customer)).toBe(false);
    expect(await engineEnabled("EXAMPLE_ENGINE_ENABLED", { id: "ws_legacy" })).toBe(true);
  } finally {
    if (typeof before === "string") await setList(before); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});
