export function usd(n: number | null | undefined, dp = 3): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(dp)}`;
}

export function compactTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Video thumbnails render black until a frame is decoded. Asking for a media
 * fragment makes the browser seek and paint a real poster frame instead.
 */
export function posterSrc(url: string): string {
  return url.includes("#") ? url : `${url}#t=0.1`;
}

/**
 * Downloads go through our own route so the file keeps its name — a
 * cross-origin redirect would drop the `download` attribute on the floor.
 * External or legacy URLs are handed back untouched.
 */
export function downloadHref(url: string): string {
  return url.startsWith("/api/media/") ? `${url}?download=1` : url;
}

/** Machine time, spoken the way a producer would say it. */
export function dur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function hours(ms: number | null | undefined): string {
  if (!ms) return "0h";
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.round(ms / 60000)}m` : `${h.toFixed(1)}h`;
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
