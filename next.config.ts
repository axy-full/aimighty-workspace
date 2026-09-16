import type { NextConfig } from "next";

/**
 * Security headers on every response. The content policy stops the app
 * being framed and keeps forms and <base> at home; the rest are the
 * standard hardening a public site should carry. Script and style sources
 * are not restricted here because Next inlines both without nonces; the
 * data boundary is the server (every route answers 401 before it answers
 * anything), not the browser.
 */
const headers = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  /* The policy had no `default-src`, so every fetch destination was open and
     an injected script could exfiltrate anywhere it liked. These directives
     bound WHERE things may go.
     `script-src` is set EXPLICITLY, and permissively, on purpose. Writing
     `default-src 'self'` alone does not leave scripts alone — `default-src`
     is the fallback for `script-src`, so it silently became `script-src
     'self'` and blocked Next's own inline bootstrap. The app rendered a
     stub. Naming `script-src` with 'unsafe-inline' keeps today's behaviour
     exactly, which is the point: this change is about where data may GO, not
     about what may run. Locking down what may run needs per-request nonces
     through the whole app, and that is its own change, not a line in a
     security sweep. `unsafe-eval` is dev-only — Turbopack's HMR needs it and
     a production build does not. */
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
      "img-src 'self' data: blob: https:",
      "media-src 'self' data: blob: https:",
      "connect-src 'self' https:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // Keep framework debugging chrome from covering controls in mock browser rehearsals.
  ...(process.env.ENGINE_MOCK === "1" ? { devIndicators: false as const } : {}),
  async headers() {
    // Only the dedicated movie document can create the bundled AAC WASM worker.
    // Every other page retains the policy above; production never enables general eval.
    const movieHeaders = headers.map((header) =>
      header.key === "Content-Security-Policy"
        ? {
            ...header,
            value:
              header.value
                .replace(
                  "script-src 'self'",
                  "script-src 'self' 'wasm-unsafe-eval'",
                )
                .replace("connect-src 'self' https:", "connect-src 'self'") +
              "; worker-src 'self' blob:",
          }
        : header,
    );
    return [
      { source: "/(.*)", headers },
      { source: "/workbench/movie", headers: movieHeaders },
      { source: "/vendor/tesseract-7.0.0/worker.min.js", headers: [
        { key: "Content-Security-Policy", value: "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
      ] },
    ];
  },
};

export default nextConfig;
