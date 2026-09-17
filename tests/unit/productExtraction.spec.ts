import { test, expect } from "@playwright/test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import {
  fetchPublicProductPage,
  fetchPublicProductImageBytes,
  publicProductUrl,
  isPublicProductAddress,
  PRODUCT_PAGE_BYTES,
  PRODUCT_IMAGE_BYTES,
  type ProductFetchDependencies,
} from "../../lib/workbench/product-fetch";
import { parseProductPage } from "../../lib/workbench/product-extraction";

const source = {
  requestedUrl: "https://shop.example.com/item",
  finalUrl: "https://shop.example.com/products/item",
  fetchedAt: "2026-09-17T00:00:00.000Z",
};
type FixtureResponse = {
  status?: number;
  headers?: IncomingMessage["headers"];
  chunks?: Buffer[];
  abort?: boolean;
  error?: boolean;
};
function transport(pages: FixtureResponse[]) {
  const calls: { url: URL; options: RequestOptions }[] = [];
  let destroyed = 0;
  const open = ((
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    calls.push({ url, options });
    const req = new EventEmitter() as ClientRequest;
    req.destroy = () => {
      destroyed++;
      return req;
    };
    req.end = (() => {
      queueMicrotask(() => {
        const page = pages.shift();
        if (!page) {
          req.emit("error", new Error("PRIVATE_TRANSPORT"));
          return;
        }
        const response = Readable.from(
          page.chunks ?? [Buffer.from("<title>Fixture</title>")],
        ) as IncomingMessage;
        response.statusCode = page.status ?? 200;
        response.headers = {
          "content-type": "text/html; charset=utf-8",
          ...page.headers,
        };
        callback(response);
        if (page.abort) {
          response.emit("aborted");
          response.destroy();
        }
        if (page.error) {
          response.emit("error", new Error("PRIVATE_RESPONSE"));
          response.destroy();
        }
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  }) as ProductFetchDependencies["http"];
  return {
    calls,
    destroyed: () => destroyed,
    deps: {
      http: open,
      https: open,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    },
  };
}

test("product URLs refuse credentials, nondefault ports, local names and normalized IP aliases", () => {
  for (const url of [
    "file:///etc/passwd",
    "data:text/html,a",
    "ftp://example.com/a",
    "https://user:pass@example.com/a",
    "https://example.com:444/a",
    "http://example.com:443/a",
    "https://localhost/a",
    "https://server/a",
    "https://a.internal/a",
    "https://a.local./a",
    "http://127.1/a",
    "http://2130706433/a",
    "http://0177.0.0.1/a",
    "http://0x7f000001/a",
    "http://[::1]/a",
    "http://[::ffff:127.0.0.1]/a",
    "https://example.com\\@localhost/a",
  ])
    expect(() => publicProductUrl(url), url).toThrow();
  expect(
    publicProductUrl("https://SHOP.EXAMPLE.COM.:443/p#tracking").href,
  ).toBe("https://shop.example.com/p");
});

test("address classification excludes special IPv4 and IPv6 translation/tunnel networks", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "100.64.1.1",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:8.8.8.8",
    "64:ff9b::7f00:1",
    "64:ff9b:1::7f00:1",
    "2002:7f00:1::",
    "2001::1",
    "2001:db8::1",
    "3fff::1",
    "4000::1",
  ])
    expect(isPublicProductAddress(address), address).toBe(false);
  for (const address of [
    "93.184.216.34",
    "8.8.8.8",
    "2606:4700::1111",
    "2001:4860:4860::8888",
  ])
    expect(isPublicProductAddress(address), address).toBe(true);
});

test("each redirect resolves afresh and its socket uses only a pinned public address without credentials", async () => {
  const fake = transport([
    { status: 302, headers: { location: "/final" } },
    {},
  ]);
  let resolves = 0;
  const page = await fetchPublicProductPage("https://shop.example.com/start", {
    ...fake.deps,
    resolve: async () => {
      resolves++;
      return [{ address: "93.184.216.34", family: 4 }];
    },
  });
  expect(page.finalUrl).toBe("https://shop.example.com/final");
  expect(resolves).toBe(2);
  for (const call of fake.calls) {
    expect(call.url.hostname).toBe("shop.example.com");
    expect(call.options).toMatchObject({
      agent: false,
      family: 4,
      method: "GET",
      headers: { "Accept-Encoding": "identity" },
    });
    expect(JSON.stringify(call.options.headers)).not.toMatch(
      /Authorization|Cookie|Bearer/i,
    );
    const addresses: unknown[] = [];
    call.options.lookup!("shop.example.com", { all: true }, (error, result) => {
      expect(error).toBeNull();
      addresses.push(result);
    });
    call.options.lookup!("shop.example.com", {}, (error, result, family) => {
      expect(error).toBeNull();
      addresses.push({ result, family });
    });
    expect(addresses).toEqual([
      [{ address: "93.184.216.34", family: 4 }],
      { result: "93.184.216.34", family: 4 },
    ]);
  }
});

test("mixed private DNS answers and redirect rebinding cannot reach a second destination", async () => {
  const blocked = transport([]);
  await expect(
    fetchPublicProductPage("https://shop.example.com/a", {
      ...blocked.deps,
      resolve: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    }),
  ).rejects.toMatchObject({ code: "unsafe_url" });
  expect(blocked.calls).toHaveLength(0);
  const rebound = transport([
    { status: 302, headers: { location: "https://other.example.com/secret" } },
    {},
  ]);
  let count = 0;
  await expect(
    fetchPublicProductPage("https://shop.example.com/a", {
      ...rebound.deps,
      resolve: async () => [
        { address: count++ ? "169.254.169.254" : "8.8.8.8", family: 4 },
      ],
    }),
  ).rejects.toMatchObject({ code: "unsafe_url" });
  expect(rebound.calls).toHaveLength(1);
});

test("redirects cannot downgrade HTTPS, loop or exceed three hops", async () => {
  for (const location of [
    "http://shop.example.com/insecure",
    "http://127.0.0.1/private",
    "https://shop.example.com/start",
  ]) {
    const fake = transport([{ status: 302, headers: { location } }, {}]);
    await expect(
      fetchPublicProductPage("https://shop.example.com/start", fake.deps),
    ).rejects.toThrow();
    expect(fake.calls).toHaveLength(1);
  }
  const fake = transport(
    Array.from({ length: 5 }, (_, i) => ({
      status: 302,
      headers: { location: `/hop-${i}` },
    })),
  );
  await expect(
    fetchPublicProductPage("https://shop.example.com/start", fake.deps),
  ).rejects.toMatchObject({ code: "redirect_limit" });
  expect(fake.calls).toHaveLength(4);
});

test("the deadline spans DNS and prevents a late lookup from opening a connection", async () => {
  const fake = transport([{}]),
    originalNow = Date.now;
  try {
    await expect(
      fetchPublicProductPage("https://shop.example.com/start", {
        ...fake.deps,
        resolve: async () => {
          const expired = originalNow() + 20_000;
          Date.now = () => expired;
          return [{ address: "8.8.8.8", family: 4 }];
        },
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(fake.calls).toHaveLength(0);
  } finally {
    Date.now = originalNow;
  }
});

test("wire body cap covers lying/missing lengths and rejects compressed or non-HTML downloads", async () => {
  const exact = transport([{ chunks: [Buffer.alloc(PRODUCT_PAGE_BYTES, 32)] }]);
  expect(
    (await fetchPublicProductPage("https://shop.example.com/a", exact.deps))
      .html,
  ).toHaveLength(PRODUCT_PAGE_BYTES);
  for (const headers of [{}, { "content-length": "1" }]) {
    const fake = transport([
      {
        headers,
        chunks: [Buffer.alloc(PRODUCT_PAGE_BYTES, 32), Buffer.from("x")],
      },
    ]);
    await expect(
      fetchPublicProductPage("https://shop.example.com/a", fake.deps),
    ).rejects.toMatchObject({ code: "page_too_large" });
    expect(fake.destroyed()).toBeGreaterThan(0);
  }
  for (const headers of [
    { "content-encoding": "gzip" },
    { "content-type": "image/png" },
    { "content-length": String(PRODUCT_PAGE_BYTES + 1) },
  ]) {
    const fake = transport([{ headers }]);
    await expect(
      fetchPublicProductPage("https://shop.example.com/a", fake.deps),
    ).rejects.toThrow();
    expect(fake.destroyed()).toBeGreaterThan(0);
  }
});

test("transport and response failures never expose upstream messages", async () => {
  for (const pages of [[], [{ abort: true }], [{ error: true }]]) {
    const fake = transport(pages);
    await expect(
      fetchPublicProductPage("https://shop.example.com/a", fake.deps),
    ).rejects.not.toThrow(/PRIVATE/);
  }
});

test("explicit image reads preserve bytes and retain DNS redirect MIME compression and byte-cap guards", async () => {
  const original = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2]);
  const safe = transport([
    {
      status: 302,
      headers: { location: "https://cdn.example.com/original.png" },
    },
    { headers: { "content-type": "image/png" }, chunks: [original] },
  ]);
  const image = await fetchPublicProductImageBytes(
    "https://shop.example.com/image",
    safe.deps,
  );
  expect(image.bytes.equals(original)).toBe(true);
  expect(image.mime).toBe("image/png");
  expect(image.finalUrl).toBe("https://cdn.example.com/original.png");
  expect(safe.calls[1].options.headers).toMatchObject({
    "Accept-Encoding": "identity",
  });
  for (const headers of [
    { "content-type": "text/html" },
    { "content-type": "image/svg+xml" },
    { "content-type": "image/png", "content-encoding": "br" },
  ]) {
    const fake = transport([{ headers }]);
    await expect(
      fetchPublicProductImageBytes("https://shop.example.com/image", fake.deps),
    ).rejects.toMatchObject({ code: "unsupported_content" });
  }
  const oversized = transport([
    {
      headers: { "content-type": "image/png", "content-length": "1" },
      chunks: [Buffer.alloc(PRODUCT_IMAGE_BYTES), Buffer.from("x")],
    },
  ]);
  await expect(
    fetchPublicProductImageBytes(
      "https://shop.example.com/image",
      oversized.deps,
    ),
  ).rejects.toMatchObject({ code: "image_too_large" });
  const rebound = transport([
    {
      status: 302,
      headers: { location: "https://metadata.example.com/private" },
    },
    {},
  ]);
  let resolutions = 0;
  await expect(
    fetchPublicProductImageBytes("https://shop.example.com/image", {
      ...rebound.deps,
      resolve: async () => [
        { address: resolutions++ ? "10.0.0.1" : "8.8.8.8", family: 4 },
      ],
    }),
  ).rejects.toMatchObject({ code: "unsafe_url" });
  expect(rebound.calls).toHaveLength(1);
});

test("Product JSON-LD graph takes priority and preserves evidence without approving claims or importing images", () => {
  const html = `<meta property="og:title" content="Fallback"><script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "Product", name: "Acme &amp; Co", description: "<b>Claim</b> supplied by the page", brand: { "@type": "Brand", name: "Acme" }, image: ["/master.jpg", { contentUrl: "https://cdn.example.com/photo.jpg", caption: "Front view" }, "http://127.0.0.1/no", "data:image/png;bad"] }] })}</script>`;
  const result = parseProductPage(html, source);
  expect(result.product).toEqual({
    name: "Acme &amp; Co",
    description: "Claim supplied by the page",
    brand: "Acme",
  });
  expect(result.requiresReview).toBe(true);
  expect(result.source).toEqual(source);
  expect(result.imageCandidates).toEqual([
    { url: "https://shop.example.com/master.jpg", source: "json-ld" },
    {
      url: "https://cdn.example.com/photo.jpg",
      source: "json-ld",
      alt: "Front view",
    },
  ]);
  expect(
    result.evidence.every((item) => item.sourceUrl === source.finalUrl),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/uploadId|assetId|storedUrl/);
});

test("malformed JSON-LD falls back to uppercase OpenGraph tags with decoded attribute entities", () => {
  const result = parseProductPage(
    `<script TYPE="application/ld+json">{broken</script><META PROPERTY="og:title" CONTENT="A &amp; B"><meta property="og:description" content="Draft details"><meta property="og:image" content="/image.jpg"><title>Unused title</title>`,
    source,
  );
  expect(result.product).toEqual({
    name: "A & B",
    description: "Draft details",
    brand: "",
  });
  expect(result.evidence[0].source).toBe("open-graph");
  expect(result.warnings.join(" ")).toContain("malformed");
  expect(
    parseProductPage("<title>Title &amp; fallback</title>", source).product
      .name,
  ).toBe("Title & fallback");
});

test("hostile deep HTML/JSON and excessive images remain bounded without selector recursion", () => {
  const deepHtml = `<meta property="og:title" content="Safe title">${"<div>".repeat(12_000)}x${"</div>".repeat(12_000)}`;
  expect(parseProductPage(deepHtml, source).product.name).toBe("Safe title");
  let nested: object = { "@type": "Product", name: "Too deep" };
  for (let i = 0; i < 30; i++) nested = { child: nested };
  const result = parseProductPage(
    `<script type="application/ld+json">${JSON.stringify(nested)}</script><title>Fallback</title>`,
    source,
  );
  expect(result.product.name).toBe("Fallback");
  expect(result.warnings.join(" ")).toContain("limits");
  const images = Array.from(
    { length: 100 },
    (_, i) => `https://cdn.example.com/${i}.jpg`,
  );
  expect(
    parseProductPage(
      `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Fixture", image: images })}</script>`,
      source,
    ).imageCandidates,
  ).toHaveLength(8);
});
