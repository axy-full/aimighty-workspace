/**
 * The switch for Remotion exports (owner, 13 Oct 2026): `REMOTION_EXPORTS`, read at run time.
 *
 * Unset or anything but 1/on/true/yes means OFF, and off is the production default until the screens exist and the
 * owner has tested it. Off, the export route answers 404, the export tools are not offered over MCP, and no job is
 * admitted, written or dispatched. Pure: no database, safe anywhere.
 */
export function exportsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = (env.REMOTION_EXPORTS ?? "").trim().toLowerCase();
  return value === "1" || value === "on" || value === "true" || value === "yes";
}
