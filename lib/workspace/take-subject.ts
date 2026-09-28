/**
 * Who a "rendered" toast is about (Rig; the composer's own toast says "Your
 * take" outright). The composer files its take on a shot named with the prompt
 * cut at 60 characters (lib/workspace/use-composer.ts, trimmed again by
 * shotPatch), and a prompt is never the subject of a sentence ("…desk lamp in
 * rendered."): that take is "Your take". A shot's own title stays.
 */
export function renderedSubject(title: string, note: string): string {
  const name = title.trim();
  return !name || name === note.trim().slice(0, 60).trim() ? "Your take" : name;
}
