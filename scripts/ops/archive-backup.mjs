#!/usr/bin/env node
/**
 * Keeps a verified backup forever (owner, 24 September: "The data should be
 * available on the server indefinitely. At no point should it be deleted").
 * GitHub artifacts expire (400 days at most), so every verified bundle — it is
 * ciphertext only — is also written to a dedicated private Vercel Blob store
 * that nothing ever deletes from. Objects are written once (no overwrite) and
 * read back: each size and SHA-256 must match before the archive counts.
 *
 * Usage (on the protected runner): node scripts/ops/archive-backup.mjs BUNDLE_DIRECTORY ARCHIVE_PREFIX
 * Needs PARTICL_BACKUP_ARCHIVE_TOKEN — the read-write token of the backup store,
 * NOT the application's media store.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function files(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}
export const archiveKey = (prefix, root, path) => `${prefix.replace(/\/+$/, "")}/${relative(root, path).split("\\").join("/")}`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function main() {
  const [bundle, prefix] = process.argv.slice(2);
  if (!bundle || !prefix || !/^[A-Za-z0-9._/-]{1,200}$/.test(prefix)) throw new Error("Usage: archive-backup.mjs BUNDLE_DIRECTORY ARCHIVE_PREFIX");
  const token = process.env.PARTICL_BACKUP_ARCHIVE_TOKEN;
  if (!token) throw new Error("PARTICL_BACKUP_ARCHIVE_TOKEN (the dedicated backup store) is required.");
  const { put, head, get } = await import("@vercel/blob");
  const root = resolve(bundle), list = await files(root);
  if (!list.length) throw new Error("The verified bundle is empty.");
  let bytes = 0;
  for (const path of list) {
    const body = await readFile(path), key = archiveKey(prefix, root, path);
    await put(key, body, { access: "private", token, addRandomSuffix: false, allowOverwrite: false, contentType: "application/octet-stream" });
    const meta = await head(key, { token });
    if (meta.size !== body.length) throw new Error(`Archive size mismatch for ${key}.`);
    const back = await get(key, { access: "private", token, useCache: false });
    if (!back || back.statusCode !== 200) throw new Error(`Archive read-back failed for ${key}.`);
    const copy = Buffer.from(await new Response(back.stream).arrayBuffer());
    if (sha(copy) !== sha(body)) throw new Error(`Archive checksum mismatch for ${key}.`);
    bytes += body.length;
  }
  console.log(JSON.stringify({ archived: true, prefix, objects: list.length, bytes }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => { console.error(error instanceof Error ? error.message.replace(/vercel_blob_rw_[A-Za-z0-9_]+/g, "[token]") : "Archiving failed."); process.exitCode = 1; });
