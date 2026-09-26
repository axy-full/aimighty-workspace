import type { z } from "zod";

/**
 * What a refused project save says. A rule the schema states in words (the
 * screenplay source, OCR review, bindings, bins, audio, colour) says itself;
 * a field that is merely too long or malformed is named, so the person knows
 * what to fix instead of retrying an autosave that can never pass.
 */
export function saveProblem(error: Pick<z.ZodError, "issues">): string {
  const issues = error.issues;
  const stated = issues.find((issue) => issue.code === "custom" && issue.message);
  if (stated) return stated.message;
  const issue = issues[0];
  if (!issue) return "Check the project fields before saving.";
  const where = issue.path
    .filter((key) => key !== "project")
    .map((key) => (typeof key === "number" ? `#${key + 1}` : String(key).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()))
    .join(" ");
  const detail = issue as { origin?: string; maximum?: number | bigint; minimum?: number | bigint };
  const unit = detail.origin === "string" ? "characters" : detail.origin === "array" || detail.origin === "set" ? "items" : "";
  const reason =
    issue.code === "too_big" && detail.maximum != null
      ? unit ? `keep it to ${Number(detail.maximum).toLocaleString("en-US")} ${unit}` : `keep it at most ${Number(detail.maximum).toLocaleString("en-US")}`
      : issue.code === "too_small" && detail.minimum != null
        ? Number(detail.minimum) <= 1 && unit ? "it cannot be empty" : unit ? `it needs at least ${Number(detail.minimum).toLocaleString("en-US")} ${unit}` : `keep it at least ${Number(detail.minimum).toLocaleString("en-US")}`
        : "it is not valid";
  return where ? `Check the project's ${where}: ${reason}.` : `Check the project: ${reason}.`;
}
