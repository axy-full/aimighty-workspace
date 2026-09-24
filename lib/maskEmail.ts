/**
 * An email with most of it hidden: enough to tell two people with the same
 * name apart, not enough to read the address. The first letter of the name
 * and of the domain stay, and the ending; every hidden run is three dots, so
 * the length gives nothing away either. a•••@a•••.com
 */
export function maskEmail(email: string | null | undefined): string {
  const value = String(email ?? "").trim();
  const at = value.lastIndexOf("@");
  if (at < 1 || at === value.length - 1) return "";
  const local = value.slice(0, at), domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const ending = dot > 0 ? domain.slice(dot) : "";
  return `${local[0]}•••@${host[0]}•••${ending}`;
}
