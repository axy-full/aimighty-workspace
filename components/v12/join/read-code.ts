import { inviteKind, type InviteKind } from "./join-model";

/**
 * Reads an invite code with today's two public routes, as the join sheet and an invite link do: a team invite
 * (GET /api/auth/accept?code=), else a new-workspace invite (GET /api/auth/signup?code=). Both answer a visitor with the
 * invite's own facts only (the workspace's name, the invited email and name), and a bad, used or expired code with an error.
 */
export async function readCode(code: string): Promise<InviteKind> {
  const read = async (url: string) => {
    const res = await fetch(url, { cache: "no-store" });
    return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  };
  const team = await read(`/api/auth/accept?code=${encodeURIComponent(code)}`);
  if (team.status === 200 || team.status === 409 || team.status === 410) return inviteKind(code, team, null);
  return inviteKind(code, team, await read(`/api/auth/signup?code=${encodeURIComponent(code)}`));
}
