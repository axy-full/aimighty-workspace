"use client";
import { useCallback, useSyncExternalStore } from "react";
import { useSession } from "@/lib/session";
import { approve, postsPreview, prepare, retry, sendForApproval, settle, unschedule, type Actor, type SocialPost } from "@/lib/social/posts";

/*
 * Where the Social board's posts come from. Posting is not in Particl yet, so there is no store of posts: in a real build the
 * list is empty and the Posts section reads "Not in Particl yet". In a development build, asked for with the browser's
 * sessionStorage key `particl-posts-preview` = 1 (lib/social/posts.ts › postsPreview), five sample posts, one in each state,
 * live in this tab's memory so the screen can be seen and tested. A publisher, when there is one, replaces this module's
 * `readPosts` and `writePost`; the card and the rule that governs it (approving is people-only) stay as they are.
 */
const HOUR = 3_600_000;
function sample(now: number): SocialPost[] {
  const base = { aspect: "9:16" as const, clip: "Clip 1 · 0:14" };
  const settled = (id: string, platform: SocialPost["platform"], format: string, out: Parameters<typeof settle>[1], at: number) =>
    settle(approve(sendForApproval(prepare({ id, platform, format, ...base })), { kind: "person", userId: "preview-person" }, at), out);
  return [
    prepare({ id: "post-1", platform: "instagram", format: "Reel", ...base }),
    sendForApproval(prepare({ id: "post-2", platform: "tiktok", format: "clip", ...base })),
    approve(sendForApproval(prepare({ id: "post-3", platform: "youtube", format: "Shorts", ...base })), { kind: "person", userId: "preview-person" }, now + 2 * 24 * HOUR),
    settled("post-4", "instagram", "Story", { ok: true, at: now - 2 * HOUR }, now - 3 * HOUR),
    settled("post-5", "tiktok", "clip 2", { ok: false, reason: "the account needs reconnecting", reconnect: true }, now - HOUR),
  ];
}

let posts: SocialPost[] | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const EMPTY: SocialPost[] = [];
function readPosts(): SocialPost[] {
  if (!postsPreview()) return EMPTY;
  posts ??= sample(Date.now());
  return posts;
}
function writePost(next: SocialPost) {
  if (!posts) return;
  posts = posts.map((p) => (p.id === next.id ? next : p));
  listeners.forEach((l) => l());
}

/** The ids of the posts the board draws cards for (the cards read each post's own state). */
export const postIds = (): string[] => readPosts().map((p) => p.id);
export function usePosts(): readonly SocialPost[] { return useSyncExternalStore(subscribe, readPosts, () => EMPTY); }

export type PostActions = {
  /** The caller, as the rule sees it: a signed-in person, or nobody. */
  actor: Actor | null;
  send: (post: SocialPost) => string | null;
  approve: (post: SocialPost, at: number) => string | null;
  unschedule: (post: SocialPost) => string | null;
  retry: (post: SocialPost, at: number) => string | null;
};

/** Every action answers why it did not happen, or null. Each is free. */
export function usePostActions(): PostActions {
  const { signedIn, userId } = useSession();
  const actor: Actor | null = signedIn && userId ? { kind: "person", userId } : null;
  const run = useCallback((make: () => SocialPost): string | null => {
    try { writePost(make()); return null; } catch (cause) { return cause instanceof Error ? cause.message : "That could not be done."; }
  }, []);
  return {
    actor,
    send: (post) => run(() => sendForApproval(post)),
    approve: (post, at) => run(() => approve(post, actor, at)),
    unschedule: (post) => run(() => unschedule(post, actor)),
    retry: (post, at) => run(() => retry(post, actor, at)),
  };
}
