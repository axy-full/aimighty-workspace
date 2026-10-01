import { z } from "zod";
import type { Reference } from "./ark";
import { db, ready, now } from "./db";
import { higgsfieldCredentials, HiggsfieldHttpError } from "./higgsfield";
import { withRecoveryActivity } from "./recovery";
import { imagePath, uploadPath, presignedReadUrl, usingBlob } from "./storage";
import { engineMock } from "./mock";
import { paidByPlatform } from "./platformSpend";
import { MARKETING_IMAGE_25_TOKEN_USD } from "./vendorRates";
import type { PricingWatch } from "./higgsfieldPricingWatch";

export const MARKETING_PATH = "marketing-studio/image";
export const MARKETING_ORIGIN = "https://api.higgsfield.ai";
/** The builds of Marketing Studio Image: 2.0 Alpha (priced by its live estimate) and the 2.5 builds (token-metered). */
export const MARKETING_VARIANTS = ["alpha", "flare", "sunburst"] as const;
export type MarketingVariant = (typeof MARKETING_VARIANTS)[number];
export const MARKETING_VARIANT_PATHS: Record<MarketingVariant, string> = {
  alpha: MARKETING_PATH,
  flare: `${MARKETING_PATH}/flare`,
  sunburst: `${MARKETING_PATH}/sunburst`,
};
export const MARKETING_CAPABILITIES = {
  variants: MARKETING_VARIANTS,
  /** 2.0 Alpha's qualities; the 2.5 builds add xhigh and max. */
  qualities: ["low", "medium", "high"],
  qualities25: ["low", "medium", "high", "xhigh", "max"],
  resolutions: ["1k", "2k", "4k"],
  ratios: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"],
  maxImages: 16,
} as const;
const settingsSchema = z
  .object({
    /** Absent on every take made before the 2.5 builds: 2.0 Alpha. */
    variant: z.enum(MARKETING_VARIANTS).optional(),
    quality: z.enum(MARKETING_CAPABILITIES.qualities25).default("high"),
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
  const alpha = (parsed.data.variant ?? "alpha") === "alpha";
  if (alpha && !(MARKETING_CAPABILITIES.qualities as readonly string[]).includes(parsed.data.quality))
    throw new MarketingError(
      "Extra-high and maximum quality are 2.5 builds only. Choose a 2.5 build or a lower quality.",
      400,
      "invalid_settings",
    );
  // 2.0 enhancement runs at high quality only; the 2.5 builds keep quality selectable.
  if (
    parsed.data.enhancePrompt !== Boolean(parsed.data.presetId) ||
    (alpha && parsed.data.enhancePrompt && parsed.data.quality !== "high")
  )
    throw new MarketingError(
      alpha
        ? "Preset enhancement requires a preset and high quality. Turn enhancement off to use your own prompt."
        : "Preset enhancement requires a preset. Turn enhancement off to use your own prompt.",
      400,
      "invalid_settings",
    );
  return parsed.data;
}

/** The provider route a take's build is sent to, and estimated at. */
export function marketingPath(settings: Pick<MarketingSettings, "variant">): string {
  return MARKETING_VARIANT_PATHS[settings.variant ?? "alpha"];
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
      "The connected account returned an unusable response.",
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
      "The connected account returned an unusable response.",
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
        if (status === 403) throw marketingBalanceError();
        throw new MarketingError(
          status === 401
            ? "This connected account cannot access Marketing Studio."
            : status === 404
              ? "Marketing Studio is unavailable for this connection."
              : status === 429
                ? "The connected account is rate limiting requests. Try again shortly."
                : "Marketing pricing or presets are temporarily unavailable.",
          status === 429 ? 429 : 503,
          status === 401
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
        "Marketing pricing or presets could not be reached.",
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
/**
 * A preset as a picker shows it: the documented public metadata only — its
 * cover picture (an https URL, never with credentials), the group the provider
 * files it under ("Product shots", "Graphic ads"…) and the aspect it was made
 * for. Each is present only when the provider gives a usable value.
 */
export type MarketingPresetItem = MarketingPreset & { cover?: string; group?: string; aspectRatio?: string };
/** The documented `search`: 1–100 characters. */
export const PRESET_SEARCH_MAX = 100;
function presetCover(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
function presetLabel(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return text && text.length <= max ? text : undefined;
}
function presetExtras(item: unknown): Pick<MarketingPresetItem, "cover" | "group" | "aspectRatio"> {
  const value = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
  const metadata = value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata) ? (value.metadata as Record<string, unknown>) : {};
  const cover = presetCover(value.cover_image), group = presetLabel(metadata.group_name, 100);
  const aspectRatio = presetLabel(metadata.aspect_ratio, 20);
  return { ...(cover ? { cover } : {}), ...(group ? { group } : {}), ...(aspectRatio && /^(auto|\d{1,2}:\d{1,2})$/.test(aspectRatio) ? { aspectRatio } : {}) };
}

export async function listMarketingPresets(
  cursor?: string,
  search?: string,
): Promise<{ items: MarketingPresetItem[]; total: number; cursor: string | null }> {
  if (
    cursor != null &&
    (cursor.length > 2048 || !cursor || /[\x00-\x1f]/.test(cursor))
  )
    throw new MarketingError(
      "Choose a valid preset page.",
      400,
      "invalid_cursor",
    );
  const term = search?.trim();
  if (search != null && (!term || term.length > PRESET_SEARCH_MAX || /[\x00-\x1f\x7f]/.test(term)))
    throw new MarketingError(
      `Search presets with 1–${PRESET_SEARCH_MAX} characters.`,
      400,
      "invalid_search",
    );
  const fingerprint = higgsfieldCredentials().fingerprint;
  // Mock mode never invents a production preset identifier or contacts a provider.
  if (engineMock()) return { items: [], total: 0, cursor: null };
  const query = new URLSearchParams({
    size: "50",
    ...(cursor ? { cursor } : {}),
    ...(term ? { search: term } : {}),
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
      "The connected account returned an unusable preset page.",
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
  const raw = Array.isArray(response.items) ? (response.items as unknown[]) : [];
  return {
    ...parsed.data,
    items: parsed.data.items.map((item, i) => ({ ...item, ...presetExtras(raw[i]) })),
    cursor: parsed.data.cursor ?? null,
  };
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
      "Refresh presets and choose one available to this connected account.",
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
        : presignedReadUrl(pathname, 0.25, ref.storedUrl);
    }),
  );
}
/**
 * The price a take is quoted at. 2.0 Alpha: the provider's live estimate for
 * exactly this input. The 2.5 builds: their estimate states the published
 * per-token rates but returns no figure, so the quote is APPROXIMATE, from
 * those rates and marketing25Tokens; the take settles on the delivered image.
 */
export async function estimateMarketingInput(
  input: ReturnType<typeof marketingInput>,
  variant: MarketingVariant = "alpha",
): Promise<number> {
  if (variant !== "alpha") return marketing25Usd(input);
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
      "The connected account did not return a positive USD estimate. Nothing was submitted.",
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

/**
 * HTTP 403 is the provider's documented "insufficient credits" reply, never a
 * missing grant. On the platform's shared key that balance is the platform's
 * own: the workspace sees neutral copy and the platform log gets the reason.
 * A workspace on its own key is told plainly, since the account is its own.
 */
export function marketingBalanceError(): MarketingError {
  const refusal = higgsfieldBalanceRefusal("marketing-studio");
  return new MarketingError(`${refusal.message} Nothing was submitted.`, 503, refusal.platform ? "provider_unavailable" : "insufficient_balance");
}

/** The same 403 for any paid request on the commercial key (lib/engines/higgsfield.ts). */
export function higgsfieldBalanceRefusal(surface: string): { message: string; platform: boolean } {
  if (paidByPlatform("higgsfield")) {
    console.warn(JSON.stringify({ level: "warn", event: "higgsfield.insufficient_balance", surface }));
    return { message: "This engine is unavailable right now; try again shortly.", platform: true };
  }
  return { message: "The connected account's API balance is too low for this request. Top it up, then try again.", platform: false };
}

/* ── The 2.5 builds: an approximate price from the published per-token rates ──
 * The provider bills text in and out, image in and image out by the token and
 * reconciles on completion, and publishes neither a per-request figure nor the
 * tokens an image of each size and quality produces. These counts are the
 * assumptions the quote is built from: GPT Image's token table as lib/vendorRates.ts
 * already prices GPT Image 2.5 (about 1.5 megapixels), per megapixel of output;
 * extra-high and maximum quality, which that table lacks, extrapolated from high;
 * a reference image counted like GPT Image's reference ceiling; and a fixed
 * allowance for the provider's own prompt rewrite when a preset enhances it. */
const OUTPUT_TOKENS_PER_MEGAPIXEL: Record<string, number> = { low: 400, medium: 1_512, high: 6_000, xhigh: 9_000, max: 12_000 };
/** Megapixels of each resolution tier's square frame; exact dimensions follow the aspect. */
const TIER_MEGAPIXELS: Record<string, number> = { "1k": 1.048576, "2k": 4.194304, "4k": 16.777216 };
const REFERENCE_IMAGE_TOKENS = 2_000;
const ENHANCEMENT_TEXT_TOKENS = 1_000;

/** Approximate provider USD for a 2.5 request; `outputMegapixels`, when known, is the delivered image's. */
export function marketing25Usd(
  input: Pick<ReturnType<typeof marketingInput>, "prompt" | "image_urls" | "quality" | "resolution" | "enhance_prompt">,
  outputMegapixels?: number,
): number {
  const rate = MARKETING_IMAGE_25_TOKEN_USD;
  const megapixels = outputMegapixels ?? TIER_MEGAPIXELS[input.resolution] ?? TIER_MEGAPIXELS["2k"];
  const perMegapixel = OUTPUT_TOKENS_PER_MEGAPIXEL[input.quality] ?? OUTPUT_TOKENS_PER_MEGAPIXEL.high;
  const textIn = Math.ceil(input.prompt.length / 4) + (input.enhance_prompt ? ENHANCEMENT_TEXT_TOKENS : 0);
  const textOut = input.enhance_prompt ? ENHANCEMENT_TEXT_TOKENS : 0;
  const imageIn = REFERENCE_IMAGE_TOKENS * input.image_urls.length;
  const imageOut = Math.ceil(perMegapixel * megapixels);
  return textIn * rate.textIn + textOut * rate.textOut + imageIn * rate.imageIn + imageOut * rate.imageOut;
}

/**
 * The settled cost of a 2.5 take: the provider's own charge when it states one
 * per job, else the approximate figure for the delivered image. Either is used
 * only within half to three times the quote; outside that band a unit or
 * measurement mistake is assumed and the quote stands.
 */
export function marketing25SettlementUsd(quoteUsd: number, deliveredUsd: number | null, reportedUsd?: number | null): number {
  const sane = (value: number | null | undefined): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= quoteUsd * 0.5 && value <= quoteUsd * 3;
  if (sane(reportedUsd)) return reportedUsd;
  if (sane(deliveredUsd)) return deliveredUsd;
  return quoteUsd;
}

/** The published 2.5 pricing the approximation is built from, watched for change (lib/higgsfieldPricingWatch.ts). */
const WATCH_2_5_SHA256 = "3e0d7e037ba52b2716e1b00a191137728b93cd73d32c49e8146e4e9797a2b503";
export const MARKETING_25_PRICING_WATCH: Record<Exclude<MarketingVariant, "alpha">, PricingWatch> = {
  flare: { model: "higgsfield/marketing-studio-image:flare", path: MARKETING_VARIANT_PATHS.flare,
    body: { prompt: "a bottle of juice on a white table" }, expectedSha256: WATCH_2_5_SHA256 },
  sunburst: { model: "higgsfield/marketing-studio-image:sunburst", path: MARKETING_VARIANT_PATHS.sunburst,
    body: { prompt: "a bottle of juice on a white table" }, expectedSha256: WATCH_2_5_SHA256 },
};
