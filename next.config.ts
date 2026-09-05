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
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/(.*)", headers }];
  },
};

export default nextConfig;
