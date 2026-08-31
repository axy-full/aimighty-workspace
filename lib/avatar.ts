/** Deterministic avatar hue per person, so a face is recognisable by colour
 *  before the name is read. */
export function avatarHue(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 42% 52%)`;
}

export function initialsOf(name: string): string {
  return name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}
