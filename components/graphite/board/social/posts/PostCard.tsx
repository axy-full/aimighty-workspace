"use client";
import { useState } from "react";
import { Price } from "@/components/graphite/Price";
import { useShell } from "@/lib/shell/state";
import { FREE } from "@/lib/shell/price-words";
import { PLATFORM_NAME, actionsOf, stateLine, type PostAction, type PostState } from "@/lib/social/posts";
import { Actions, Btn, Meta, Note, Title, Well } from "../../ads/cards/common";
import type { CardProps } from "../../cards/types";
import { usePostActions, usePosts } from "./posts-store";
import "./posts.css";

/*
 * One post on the Social board (Gaps B frames, "Ads and Social", posts): its platform and format, the clip it carries, and where it
 * stands, with the one or two free actions that stand-in has. Waiting for approval is the card's one filled button, "Approve post",
 * and it is a person's: the rule (lib/social/posts.ts) refuses an agent, a token and anybody not signed in, and this card never
 * offers it to them. A failed post says nothing posted, and offers Reconnect (Settings › Connections) and Retry · free.
 */
const DOT: Record<PostState, string> = { draft: "idle", waiting: "needs", scheduled: "done", posted: "done", failed: "bad" };
export type PostCardData = { id: string };
/** The schedule: this hour tomorrow is a person's default; a time picker is a later step. */
function tomorrow(): number { const d = new Date(Date.now() + 24 * 3_600_000); d.setMinutes(0, 0, 0); return d.getTime(); }

export function PostCard({ data }: CardProps<PostCardData>) {
  const post = usePosts().find((p) => p.id === data.id);
  const act = usePostActions();
  const shell = useShell();
  const [said, setSaid] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  if (!post) return null;
  const person = act.actor !== null;
  const press = (a: PostAction) => {
    setSaid(null);
    const refusal = a === "send" ? act.send(post) : a === "approve" ? act.approve(post, tomorrow()) : a === "unschedule" ? act.unschedule(post) : a === "retry" ? act.retry(post, tomorrow()) : (shell.goWorkspace("connections"), null);
    if (refusal) setSaid(refusal);
  };
  return (
    <article className="bd-card ab-card sb-post" data-state={post.state} data-testid="social-post" data-post-state={post.state}>
      <Well url={null} height={190} tag={post.aspect} empty={post.clip} />
      <span className="ab-body">
        <Title>{PLATFORM_NAME[post.platform]} · {post.format}</Title>
        <Meta>{post.clip}</Meta>
        <span className="sb-post-state" data-tone={DOT[post.state]} data-testid="social-post-state"><span className="sb-dot" aria-hidden="true" />{stateLine(post, now)}</span>
        <Actions>
          {actionsOf(post).map((a) => {
            if (a === "approve") return <Btn key={a} primary disabled={!person} title={person ? undefined : "Only a signed-in person approves a post"} onClick={() => press(a)} data-testid="social-post-approve">Approve post</Btn>;
            if (a === "send") return <Btn key={a} onClick={() => press(a)} data-testid="social-post-send">Send for approval</Btn>;
            if (a === "unschedule") return <Btn key={a} disabled={!person} onClick={() => press(a)} data-testid="social-post-unschedule">Unschedule</Btn>;
            if (a === "reconnect") return <Btn key={a} onClick={() => press(a)} data-testid="social-post-reconnect">Reconnect</Btn>;
            return <Btn key={a} disabled={!person || post.failure?.reconnect === true} title={post.failure?.reconnect ? "Reconnect the account first" : undefined} onClick={() => press(a)} data-testid="social-post-retry">Retry · <Price value={FREE} /></Btn>;
          })}
        </Actions>
        {said ? <Note tone="bad" role="alert">{said}</Note> : null}
      </span>
    </article>
  );
}
