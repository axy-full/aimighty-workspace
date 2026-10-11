/** What Next hands a page as `searchParams`. */
export type RawSearch = Record<string, string | string[] | undefined>;

/** Next hands searchParams as a record; the shell's address pipeline wants a query string. Repeated params are kept. */
export function searchStringOf(params: RawSearch): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const one of value) query.append(key, one);
    else if (typeof value === "string") query.append(key, value);
  }
  return query.toString();
}
