/** Live team editing needs the owner's Liveblocks secret on the server; without it the team canvas still saves and opens, just not live. */
export const collabConfigured = () => /^sk_/.test(process.env.LIVEBLOCKS_SECRET_KEY ?? "");

/** A person's colour in a shared room: stable per person, readable on the dark canvas. */
export function collabColor(userId: string) {
  const palette = ["#0A84FF", "#30D158", "#FF9F0A", "#BF5AF2", "#FF375F", "#64D2FF", "#FFD60A", "#5E5CE6"];
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

/**
 * The id a person has in a live room. Liveblocks shows every person's user id to the others in the room, so in a client workspace the platform owner's is the opaque
 * support id the Team page gives them (owner, 14 Oct: "hide my account id in client workspaces"); everyone else's, and everyone's in the house, is their own.
 * Nothing reads it back: the window knows its teammates by connection (roomPeer), and what the room records of a made card is only whether the server made it.
 */
export async function roomUserId(workspace: { id: string }, accountId: string): Promise<string> {
  const { isHouseWorkspace } = await import("./houseWorkspace");
  if (isHouseWorkspace(workspace)) return accountId;
  const { platformOwnerIdentity, supportMemberId } = await import("./platformOwnerPrivacy");
  return (await platformOwnerIdentity()).accountIds.includes(accountId) ? supportMemberId(workspace.id, accountId) : accountId;
}
