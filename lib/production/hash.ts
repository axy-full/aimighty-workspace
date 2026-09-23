/** SHA-256 of a text, hex — the identity an approval or a breakdown is pinned to. */
export async function sha256Hex(text: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, "0")).join("");
}
