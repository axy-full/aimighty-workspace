/**
 * The face a consent record is checked against: ONE swappable function.
 *
 * A consent record today holds the person's name, what it covers, the uses, an end date and a recording of them agreeing (audio from the
 * Cast card's recorder), and no face image (lib/security/consent.ts). Until the owner decides where the reference face comes from
 * (a photo taken at consent time, the cast member's master, or a frame of a video recording; docs: the owner's question of 15 Oct 2026),
 * this returns null, and the gate (lib/consentMatch.ts) REFUSES every check: it fails closed, with "This person's consent has no face
 * reference yet". Changing the source is a change to this one function; nothing else in the gate moves.
 *
 * It returns the image bytes (PNG or JPEG, at most 5 MB) or null. It must read only this workspace's own storage, and it keeps nothing.
 */
export async function consentReferenceImage(consentId: string): Promise<Buffer | null> {
  void consentId;
  return null;
}
