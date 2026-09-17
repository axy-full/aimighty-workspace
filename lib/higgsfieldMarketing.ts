import { z } from "zod";
import type { Reference } from "./ark";
import { db, ready, now } from "./db";
import { higgsfieldCredentials, HiggsfieldHttpError } from "./higgsfield";
import { withRecoveryActivity } from "./recovery";
import { imagePath, uploadPath, presignedReadUrl, usingBlob } from "./storage";
import { engineMock } from "./mock";

export const MARKETING_PATH = "marketing-studio/image";
export const MARKETING_ORIGIN = "https://api.higgsfield.ai";
export const MARKETING_CAPABILITIES = {
  qualities: ["low", "medium", "high"],
  resolutions: ["1k", "2k", "4k"],
  ratios: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"],
  maxImages: 16,
} as const;
const settingsSchema = z
  .object({
    quality: z.enum(MARKETING_CAPABILITIES.qualities).default("high"),
    enhancePrompt: z.boolean().default(false),
    presetId: z.string().uuid().optional(),
  })
  .strict();
export type MarketingSettings = z.infer<typeof settingsSchema>;
export type MarketingPreset = { id: string; type: string; name: string };
export class MarketingError extends Error {
  constructor(
    message: string,
    public readonly status = 503,
    public readonly code = "provider_unavailable",
  ) {
    super(message);
  }
}
export function marketingSettings(value: unknown): MarketingSettings {
  const parsed = settingsSchema.safeParse(value ?? {});
  if (!parsed.success)
    throw new MarketingError(
      "Choose valid Marketing Studio settings.",
      400,
      "invalid_settings",
    );
  if (
    parsed.data.enhancePrompt !== Boolean(parsed.data.presetId) ||
    (parsed.data.enhancePrompt && parsed.data.quality !== "high")
  )
    throw new MarketingError(
      "Preset enhancement requires a preset and high quality. Turn enhancement off to use your own prompt.",
      400,
      "invalid_settings",
    );
  return parsed.data;
}
export function marketingInput(
  prompt: string,
  ratio: string,
  resolution: string,
  settings: MarketingSettings,
  imageUrls: string[],
) {
  const checked = marketingSettings(settings);
  if (
    typeof prompt !== "string" ||
    !prompt.trim() ||
    prompt.length > 5000 ||
    !(MARKETING_CAPABILITIES.ratios as readonly string[]).includes(ratio) ||
    !(MARKETING_CAPABILITIES.resolutions as readonly string[]).includes(
      resolution,
    ) ||
    imageUrls.length > 16 ||
    (checked.enhancePrompt && (imageUrls.length < 1 || imageUrls.length > 2))
  )
    throw new MarketingError(
      "Marketing Studio needs a prompt of 1–5000 characters, a supported size/aspect and at most 16 images. Presets require 1–2 images.",
      400,
      "invalid_input",
    );
  if (
    imageUrls.some((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol !== "https:" || Boolean(url.username || url.password)
        );
      } catch {
        return true;
      }
    })
  )
    throw new MarketingError(
      "Marketing references require signed HTTPS originals.",
      400,
      "invalid_source",
    );
  return {
    prompt,
    image_urls: imageUrls,
    quality: checked.quality,
    moderation: "auto",
    resolution,
    aspect_ratio: ratio,
    enhance_prompt: checked.enhancePrompt,
    ...(checked.presetId ? { preset_id: checked.presetId } : {}),
  };
}

/** Provider data is bounded and never exposed as a raw response or error. */
export async function marketingJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const limit = 512 * 1024;
  if (
    !response.body ||
    Number(response.headers.get("content-length")) > limit
  ) {
    await response.body?.cancel();
    throw new MarketingError(
      "Higgsfield returned an unusable response.",
      503,
      "invalid_response",
    );
  }
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new Error("limit");
      chunks.push(part.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("shape");
    return value as Record<string, unknown>;
  } catch {
    await reader.cancel().catch(() => {});
    throw new MarketingError(
      "Higgsfield returned an unusable response.",
      503,
      "invalid_response",
    );
  } finally {
    reader.releaseLock();
  }
}
async function readCall(url: string, body?: unknown) {
  // Both catalog GET and the documented estimate POST are non-generating.
  // Track the complete read without treating an estimate timeout as paid work.
  return withRecoveryActivity("external-read", async () => {
    const { keyId, keySecret } = higgsfieldCredentials();
    try {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Key ${keyId}:${keySecret}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;
        throw new MarketingError(
          status === 401 || status === 403
            ? "This Higgsfield connection cannot access Marketing Studio."
            : status === 404
              ? "Marketing Studio is unavailable for this connection."
              : status === 429
                ? "Higgsfield is rate limiting requests. Try again shortly."
                : "Higgsfield pricing or presets are temporarily unavailable.",
          status === 429 ? 429 : 503,
          status === 401 || status === 403
            ? "authentication_rejected"
            : status === 404
              ? "model_unavailable"
              : status === 429
                ? "rate_limited"
                : "provider_unavailable",
        );
      }
      return await marketingJson(response);
    } catch (error) {
      if (error instanceof MarketingError) throw error;
      throw new MarketingError(
        "Higgsfield pricing or presets could not be reached.",
      );
    }
  });
}
const catalogs = new WeakMap<object, Promise<unknown>>();
async function catalogReady() {
  await ready();
  const client = db();
  let boot = catalogs.get(client);
  if (!boot) {
    boot = client
      .execute(
        `CREATE TABLE IF NOT EXISTS higgsfield_marketing_presets (
    id TEXT NOT NULL, credential_fingerprint TEXT NOT NULL, name TEXT NOT NULL, seen_at INTEGER NOT NULL,
    PRIMARY KEY(id,credential_fingerprint))`,
      )
      .catch((error) => {
        catalogs.delete(client);
        throw error;
      });
    catalogs.set(client, boot);
  }
  await boot;
}
export async function listMarketingPresets(
  cursor?: string,
): Promise<{ items: MarketingPreset[]; total: number; cursor: string | null }> {
  if (
    cursor != null &&
    (cursor.length > 2048 || !cursor || /[\x00-\x1f]/.test(cursor))
  )
    throw new MarketingError(
      "Choose a valid preset page.",
      400,
      "invalid_cursor",
    );
  const fingerprint = higgsfieldCredentials().fingerprint;
  // Mock mode never invents a production preset identifier or contacts a provider.
  if (engineMock()) return { items: [], total: 0, cursor: null };
  const query = new URLSearchParams({
    size: "50",
    ...(cursor ? { cursor } : {}),
  });
  const response = await readCall(
    `${MARKETING_ORIGIN}/${MARKETING_PATH}/presets?${query}`,
  );
  const parsed = z
    .object({
      total: z.number().int().nonnegative(),
      cursor: z.preprocess(
        (value) =>
          typeof value === "number" && Number.isSafeInteger(value) && value >= 0
            ? String(value)
            : value,
        z.string().max(2048).nullable().optional(),
      ),
      items: z
        .array(
          z.object({
            id: z.string().uuid(),
            // The model-specific catalog determines usability. The documented
            // `ads` value is an example, not a published category enum.
            type: z.string().trim().min(1).max(100),
            name: z.string().min(1).max(300),
          }),
        )
        .max(50),
    })
    .safeParse(response);
  if (!parsed.success) {
    // Diagnose provider schema drift without logging provider records or values.
    const kind = (value: unknown) =>
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const fields = new Set(["total", "cursor", "items", "id", "type", "name"]);
    console.warn({
      event: "higgsfield_marketing_preset_schema_mismatch",
      totalType: kind(response.total),
      cursorType: kind(response.cursor),
      itemsType: kind(response.items),
      itemCount: Array.isArray(response.items) ? response.items.length : null,
      issues: parsed.error.issues.slice(0, 8).map((issue) => ({
        code: issue.code,
        path: issue.path
          .map((part) =>
            typeof part === "number"
              ? part
              : fields.has(String(part))
                ? part
                : "field",
          )
          .join(".")
          .slice(0, 160),
      })),
    });
    throw new MarketingError(
      "Higgsfield returned an unusable preset page.",
      503,
      "invalid_response",
    );
  }
  await catalogReady();
  if (parsed.data.items.length)
    await db().batch(
      parsed.data.items.map((item) => ({
        sql: `INSERT INTO higgsfield_marketing_presets(id,credential_fingerprint,name,seen_at) VALUES(?,?,?,?)
    ON CONFLICT(id,credential_fingerprint) DO UPDATE SET name=excluded.name,seen_at=excluded.seen_at`,
        args: [item.id, fingerprint, item.name, now()],
      })),
      "write",
    );
  return { ...parsed.data, cursor: parsed.data.cursor ?? null };
}
export async function requireMarketingPreset(settings: MarketingSettings) {
  if (!settings.presetId) return;
  await catalogReady();
  const row = (
    await db().execute({
      sql: "SELECT 1 FROM higgsfield_marketing_presets WHERE id=? AND credential_fingerprint=? AND seen_at>?",
      args: [
        settings.presetId,
        higgsfieldCredentials().fingerprint,
        now() - 3600_000,
      ],
    })
  ).rows[0];
  if (!row)
    throw new MarketingError(
      "Refresh presets and choose one available to this Higgsfield connection.",
      409,
      "preset_unavailable",
    );
}
/** Inputs come only from admission's authorized rows; never accept client URL values. */
export async function marketingReferenceUrls(
  references: Reference[],
): Promise<string[]> {
  if (
    references.length > 16 ||
    references.some(
      (ref) =>
        ref.kind !== "image" ||
        !ref.mime.startsWith("image/") ||
        !/^[A-Za-z0-9_-]+$/.test(ref.id) ||
        !/^[A-Za-z0-9]+$/.test(ref.ext),
    )
  )
    throw new MarketingError(
      "Choose up to 16 stored still references.",
      400,
      "invalid_source",
    );
  if (!engineMock() && references.length && !usingBlob())
    throw new MarketingError(
      "Marketing image references require configured private media storage.",
      503,
      "storage_unavailable",
    );
  return Promise.all(
    references.map((ref) => {
      const pathname = ref.fromGeneration
        ? imagePath(ref.id)
        : uploadPath(ref.id, ref.ext);
      return engineMock()
        ? `https://fixtures.particl.invalid/${pathname}`
        : presignedReadUrl(pathname);
    }),
  );
}
export async function estimateMarketingInput(
  input: ReturnType<typeof marketingInput>,
): Promise<number> {
  if (engineMock()) return 0.25; // Synthetic fixture price, never a live fallback.
  const result = await readCall(
    `${MARKETING_ORIGIN}/estimate/${MARKETING_PATH}`,
    input,
  );
  const usd =
    typeof result.usd === "string" && /^\d+(?:\.\d+)?$/.test(result.usd)
      ? Number(result.usd)
      : NaN;
  if (!Number.isFinite(usd) || usd <= 0)
    throw new MarketingError(
      "Higgsfield did not return a positive USD estimate. Nothing was submitted.",
      503,
      "price_unavailable",
    );
  return usd;
}
/** A failed read-only preflight proves that this worker sent no paid POST. */
export function marketingPreflightError(): HiggsfieldHttpError {
  return new HiggsfieldHttpError(
    422,
    "The Marketing Studio quote or connection changed or could not be verified. Nothing was submitted; review a fresh quote.",
  );
}
