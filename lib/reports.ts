/**
 * A report: something someone saw that should not be here. Anyone may
 * send one, signed in or not; the desk reads them all. Pure validation
 * here, storage in the platform record.
 */
export const REPORT_REASONS = ["real-person", "minors", "harassment", "illegal", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REASON_LABELS: Record<ReportReason, string> = {
  "real-person": "A real person, without their consent",
  minors: "Sexual content involving a minor",
  harassment: "Harassment, hate or a threat",
  illegal: "Something unlawful",
  other: "Something else",
};

export type ReportInput = { url: string; reason: ReportReason; details: string; email: string | null };

export function reportInput(body: unknown): { ok: true; value: ReportInput } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const url = String(b.url ?? "").trim().slice(0, 500);
  if (!url) return { ok: false, error: "Say where: a link, or a take id." };
  const reason = String(b.reason ?? "");
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) return { ok: false, error: "Say what is wrong." };
  const details = String(b.details ?? "").trim().slice(0, 2000);
  const emailRaw = String(b.email ?? "").trim().toLowerCase();
  const email = emailRaw ? (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw) ? emailRaw.slice(0, 200) : null) : null;
  if (emailRaw && !email) return { ok: false, error: "That doesn't look like an email address." };
  return { ok: true, value: { url, reason: reason as ReportReason, details, email } };
}
