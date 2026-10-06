import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, type Page } from "@playwright/test";
import { createClient, type Client } from "@libsql/client";
import { localPlatformDbUrl } from "./workbenchLocal";
import { smallTargets, smallText } from "../phoneFloors";

/* Lane 5's browser specs share this (security gap screens). Neutral names only; nothing is generated or spent. */
export const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
export const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
/** The phone shell's widths and the landscape phone. */
export const phone = (page: Page) => !desktop(page);

const SHOTS = process.env.L5_SHOTS || join(tmpdir(), "claude-l5-shots");
export async function shot(page: Page, name: string, info: { project: { name: string } }) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/l5-${name}-${info.project.name.replace(/^workbench-/, "")}.png` });
}

/** The floors every screen keeps: no sideways page scroll, text at 12 px or more, 44 px targets on a phone. */
export async function floors(page: Page, where: string, targets?: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${where}: no horizontal page scroll`).toBe(true);
  expect(await smallText(page, ".gx-header, header, .gx-tabbar, .ph-tabs"), `${where}: text under 12px`).toEqual([]);
  if (targets && phone(page)) expect(await smallTargets(page, targets), `${where}: targets under 44×44`).toEqual([]);
}

/** This workspace's own local database, for fixture rows a test may not make by spending. */
export async function tenantDb(workspaceId: string): Promise<Client> {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const row = (await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0];
    expect(row, "the signed-in workspace has a database").toBeTruthy();
    const url = String(row.db_url);
    if (!url.startsWith("file:")) throw new Error("Browser fixtures require a local workspace database.");
    return createClient({ url, timeout: 10_000 });
  } finally { platform.close(); }
}

/** A short, valid WAV of silence: the consent recording a person would make, without a microphone. */
export function silentWav(seconds = 1, rate = 8000): Buffer {
  const samples = seconds * rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

/** Any request that would spend: a render, a release, an identity training, a claimed step. */
export function watchPaid(page: Page): string[] {
  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST") return;
    if ((path.startsWith("/api/generate") && !path.endsWith("/quote")) || /\/release$/.test(path) || path === "/api/soul/identities" || /\/train$/.test(path) || /\/claim$/.test(path)) paid.push(path);
  });
  return paid;
}
