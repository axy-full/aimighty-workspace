/** Live team editing needs the owner's Liveblocks secret on the server; without it the team canvas still saves and opens, just not live. */
export const collabConfigured = () => /^sk_/.test(process.env.LIVEBLOCKS_SECRET_KEY ?? "");

/** A person's colour in a shared room: stable per person, readable on the dark canvas. */
export function collabColor(userId: string) {
  const palette = ["#0A84FF", "#30D158", "#FF9F0A", "#BF5AF2", "#FF375F", "#64D2FF", "#FFD60A", "#5E5CE6"];
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}
