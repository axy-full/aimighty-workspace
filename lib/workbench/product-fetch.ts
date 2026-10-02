import { lookup } from "node:dns/promises";
import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import * as ipaddr from "next/dist/compiled/ipaddr.js";

export const PRODUCT_PAGE_BYTES = 2 * 1024 * 1024;
export const PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024;
export const CONSUMER_VIDEO_BYTES = 100 * 1024 * 1024;
const DEADLINE_MS = 15_000;
const MAX_REDIRECTS = 3;
type Address = { address: string; family: number };
type PageResponse = {
  status: number;
  location?: string;
  bytes?: Buffer;
  mime?: string;
};
type FetchPolicy = {
  deadlineMs?: number;
  httpsOnly?: boolean;
  completeLength?: boolean;
  limit: number;
  accept: string;
  mimes: string[];
  contentError: string;
  sizeError: string;
  sizeCode: string;
};
const htmlPolicy: FetchPolicy = {
  limit: PRODUCT_PAGE_BYTES,
  accept: "text/html,application/xhtml+xml;q=0.9",
  mimes: ["text/html", "application/xhtml+xml"],
  contentError:
    "Use a public HTML product page. Compressed or other downloads are not imported.",
  sizeError: "The product page is too large to inspect safely.",
  sizeCode: "page_too_large",
};
const imagePolicy: FetchPolicy = {
  limit: PRODUCT_IMAGE_BYTES,
  accept: "image/jpeg,image/png,image/webp,image/avif",
  mimes: ["image/jpeg", "image/png", "image/webp", "image/avif"],
  contentError:
    "Choose a JPEG, PNG, WebP or AVIF original. Compressed responses and other file types cannot be imported.",
  sizeError: "Choose an original image no larger than 10 MB.",
  sizeCode: "image_too_large",
};
const videoPolicy: FetchPolicy = {
  limit: CONSUMER_VIDEO_BYTES,
  deadlineMs: 60_000,
  httpsOnly: true,
  completeLength: true,
  accept: "video/mp4,application/octet-stream;q=0.5",
  mimes: ["video/mp4", "application/octet-stream"],
  contentError: "The original video must be an uncompressed MP4 response.",
  sizeError: "The original video exceeds the 100 MB collection limit.",
  sizeCode: "video_too_large",
};
export class ProductExtractionError extends Error {
  constructor(
    message: string,
    public status = 422,
    public code = "unavailable_page",
  ) {
    super(message);
  }
}

export function publicProductUrl(value: string, base?: string): URL {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2048 ||
    /[\x00-\x20\\]/.test(value)
  )
    throw new ProductExtractionError(
      "Enter a public HTTP or HTTPS product URL.",
      400,
      "invalid_url",
    );
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    throw new ProductExtractionError(
      "Enter a valid product URL.",
      400,
      "invalid_url",
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    isIP(hostname.replace(/^\[|\]$/g, "")) ||
    !hostname.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|onion|arpa)$/.test(
      hostname,
    )
  )
    throw new ProductExtractionError(
      "Use a public product website without credentials or a custom port.",
      400,
      "unsafe_url",
    );
  url.hostname = hostname;
  url.hash = "";
  if (url.href.length > 2048)
    throw new ProductExtractionError(
      "Keep the product URL under 2048 characters.",
      400,
      "invalid_url",
    );
  return url;
}

/** Only ordinary public unicast destinations; IPv6 translation/tunnel ranges
 * must not turn an apparently public DNS record into a private IPv4 request. */
export function isPublicProductAddress(value: string): boolean {
  if (!isIP(value)) return false;
  try {
    const address = ipaddr.parse(value);
    if (address.range() !== "unicast") return false;
    if (address.kind() === "ipv6") {
      return (
        address.match(ipaddr.parseCIDR("2000::/3")) &&
        !address.match(ipaddr.parseCIDR("3fff::/20"))
      );
    }
    return true;
  } catch {
    return false;
  }
}

export type ProductFetchDependencies = {
  resolve: (hostname: string) => Promise<Address[]>;
  http: typeof httpRequest;
  https: typeof httpsRequest;
};
const defaultDependencies: ProductFetchDependencies = {
  resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  http: httpRequest,
  https: httpsRequest,
};
function timeoutError() {
  return new ProductExtractionError(
    "The product website took too long to respond. Try again or enter its details manually.",
    504,
    "timeout",
  );
}
async function beforeDeadline<T>(
  work: Promise<T>,
  deadline: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(timeoutError()),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function getPinned(
  url: URL,
  address: Address,
  deadline: number,
  deps: ProductFetchDependencies,
  policy: FetchPolicy,
): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(timeoutError());
      return;
    }
    const options: RequestOptions = {
      method: "GET",
      agent: false,
      family: address.family,
      // The validated address is used by the actual socket; no second DNS lookup.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      maxHeaderSize: 16 * 1024,
      signal: AbortSignal.timeout(remaining),
      headers: {
        "User-Agent": "Particl-Product-Review/1.0",
        Accept: policy.accept,
        "Accept-Encoding": "identity",
      },
    };
    const request = (url.protocol === "https:" ? deps.https : deps.http)(
      url,
      options,
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        response.on("error", () =>
          reject(
            new ProductExtractionError(
              "The product page could not be read. Try again or enter its details manually.",
              502,
              "unavailable_page",
            ),
          ),
        );
        response.on("aborted", () =>
          reject(
            new ProductExtractionError(
              "The product page stopped responding.",
              502,
              "unavailable_page",
            ),
          ),
        );
        if ([301, 302, 303, 307, 308].includes(status)) {
          resolve({ status, location: response.headers.location });
          response.destroy();
          return;
        }
        const fail = (error: ProductExtractionError) => {
          reject(error);
          response.destroy();
          request.destroy();
        };
        if (status < 200 || status >= 300) {
          fail(
            new ProductExtractionError(
              "This product page is unavailable or blocks extraction. Enter the details manually.",
              422,
              "unavailable_page",
            ),
          );
          return;
        }
        const contentType = String(response.headers["content-type"] ?? "")
          .toLowerCase()
          .split(";")[0]
          .trim();
        if (
          !policy.mimes.includes(contentType) ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        ) {
          fail(
            new ProductExtractionError(
              policy.contentError,
              422,
              "unsupported_content",
            ),
          );
          return;
        }
        if (Number(response.headers["content-length"]) > policy.limit) {
          fail(
            new ProductExtractionError(policy.sizeError, 413, policy.sizeCode),
          );
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > policy.limit) {
            fail(
              new ProductExtractionError(
                policy.sizeError,
                413,
                policy.sizeCode,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (policy.completeLength && response.headers["content-length"] !== undefined &&
              (!/^\d+$/.test(String(response.headers["content-length"])) ||
                Number(response.headers["content-length"]) !== bytes)) {
            fail(new ProductExtractionError("The original video response was incomplete.", 422, "unsupported_content"));
            return;
          }
          resolve({ status, bytes: Buffer.concat(chunks), mime: contentType });
        });
      },
    );
    request.on("error", (error: Error) =>
      reject(
        error.name === "AbortError"
          ? timeoutError()
          : new ProductExtractionError(
              "The product website could not be reached. Try again or enter its details manually.",
              502,
              "unavailable_page",
            ),
      ),
    );
    request.end();
  });
}

/** One shared DNS-pinned transport for page inspection and explicit image reads. */
async function fetchPublicProductResource(
  value: string,
  policy: FetchPolicy,
  overrides?: Partial<ProductFetchDependencies>,
) {
  const deps = { ...defaultDependencies, ...overrides };
  const requested = publicProductUrl(value);
  let current = requested;
  const deadline = Date.now() + (policy.deadlineMs ?? DEADLINE_MS);
  const seen = new Set<string>();
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (policy.httpsOnly && current.protocol !== "https:")
      throw new ProductExtractionError(
        "Use a public HTTPS original video URL.",
        400,
        "unsafe_url",
      );
    if (Date.now() >= deadline) throw timeoutError();
    if (seen.has(current.href))
      throw new ProductExtractionError(
        "The product page redirects repeatedly. Use its final public address.",
        422,
        "redirect_limit",
      );
    seen.add(current.href);
    let addresses: Address[];
    try {
      addresses = await beforeDeadline(
        deps.resolve(current.hostname),
        deadline,
      );
    } catch (error) {
      if (error instanceof ProductExtractionError) throw error;
      throw new ProductExtractionError(
        "The product website could not be found.",
        422,
        "unavailable_page",
      );
    }
    if (
      !addresses.length ||
      addresses.length > 32 ||
      addresses.some(
        (item) =>
          ![4, 6].includes(item.family) ||
          isIP(item.address) !== item.family ||
          !isPublicProductAddress(item.address),
      )
    )
      throw new ProductExtractionError(
        "This address does not resolve only to public web servers.",
        400,
        "unsafe_url",
      );
    const result = await getPinned(
      current,
      addresses[0],
      deadline,
      deps,
      policy,
    );
    if (result.bytes !== undefined)
      return {
        requestedUrl: requested.href,
        finalUrl: current.href,
        bytes: result.bytes,
        mime: result.mime!,
      };
    if (!result.location || redirects === MAX_REDIRECTS)
      throw new ProductExtractionError(
        "The product page has too many redirects. Use its final public address.",
        422,
        "redirect_limit",
      );
    const next = publicProductUrl(result.location, current.href);
    if (current.protocol === "https:" && next.protocol !== "https:")
      throw new ProductExtractionError(
        "The product website redirects to an insecure address.",
        400,
        "unsafe_url",
      );
    current = next;
  }
  throw new ProductExtractionError("The product page could not be read.");
}

/** No cookies, Authorization, scripts, subresources or image bytes are fetched. */
export async function fetchPublicProductPage(
  value: string,
  overrides?: Partial<ProductFetchDependencies>,
) {
  const { bytes, ...page } = await fetchPublicProductResource(
    value,
    htmlPolicy,
    overrides,
  );
  return {
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    html: bytes.toString("utf8"),
  };
}

/** Called only after an explicit import action; byte validation follows in product-image. */
export function fetchPublicProductImageBytes(
  value: string,
  overrides?: Partial<ProductFetchDependencies>,
) {
  return fetchPublicProductResource(value, imagePolicy, overrides);
}

/** A verified provider result URL only; no credentials or cookies are forwarded.
 * Container/track validation must follow before these bytes are retained. */
export function fetchPublicConsumerVideoBytes(
  value: string,
  overrides?: Partial<ProductFetchDependencies>,
) {
  return fetchPublicProductResource(value, videoPolicy, overrides);
}
