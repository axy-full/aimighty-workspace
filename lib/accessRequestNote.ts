/**
 * The note an access request is stored with (app/api/access-request): where it came from, then what the person told
 * us, one line each, so the owner reads it in /admin's Requests with no new column. Guest Home's Request access adds
 * what they make and the brief they typed (lead decision 39); the new interface's join sheet (components/v12/join) adds
 * the company, the role and the company size. The company arrives as `organisation`: `company` is the route's honeypot.
 */
export function accessRequestNote(b: Record<string, unknown>): string {
  const field = (key: string, max: number) => String(b[key] ?? "").trim().slice(0, max);
  const organisation = field("organisation", 120);
  const role = field("role", 40);
  const size = field("size", 20);
  const make = field("make", 200);
  const brief = field("brief", 900);
  return [
    field("note", 1200),
    organisation ? `Company: ${organisation}` : "",
    role ? `Role: ${role}` : "",
    size ? `Company size: ${size}` : "",
    make ? `What they make: ${make}` : "",
    brief ? `Their brief: ${brief}` : "",
  ].filter(Boolean).join("\n").slice(0, 1200);
}
