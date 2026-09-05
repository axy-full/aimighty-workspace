import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Secrets at rest — a workspace's vendor keys, a tenant database token.
 *
 * AES-256-GCM under a key derived from KEYRING_SECRET. Nothing here is
 * readable from a database copy without that secret, and the secret never
 * leaves the server's environment. In production it must be set; locally a
 * fixed fallback keeps development keyless.
 */
const PREFIX = "v1";

function key(): Buffer {
  const secret = process.env.KEYRING_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("KEYRING_SECRET is not set — the deployment cannot hold a workspace's keys.");
    }
    return createHash("sha256").update("particl-dev-keyring").digest();
  }
  return createHash("sha256").update(secret).digest();
}

export function keyringConfigured(): boolean {
  return Boolean(process.env.KEYRING_SECRET) || process.env.NODE_ENV !== "production";
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function open(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== PREFIX || !iv || !tag || !ct) throw new Error("Unreadable secret.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

/** The last four characters, for a masked display that proves which key it is. */
export function mask(value: string): string {
  const tail = value.slice(-4);
  return `••••${tail}`;
}
