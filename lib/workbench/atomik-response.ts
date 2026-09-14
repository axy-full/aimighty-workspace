/** Customers see their credits; BYOK workspaces retain their direct dollar view.
 * Apply at the route boundary to quotes, history and accepted job responses. */
export function atomikPublicResponse(
  value: unknown,
  credits: boolean,
): unknown {
  if (!credits || value == null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) => atomikPublicResponse(item, true));
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            "estimateUsd",
            "costUsd",
            "inputPerMillion",
            "outputPerMillion",
            "budgets",
          ].includes(key),
      )
      .map(([key, item]) => [key, atomikPublicResponse(item, true)]),
  );
}
