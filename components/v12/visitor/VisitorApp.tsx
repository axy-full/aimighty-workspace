"use client";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { GuestBoard } from "@/lib/guest/board";
import { useCompact } from "@/lib/shell/use-compact";
import { visitorAsk, type VisitorAsk, type VisitorScreen } from "@/lib/v12/visitor";
import { OverlayProvider, ToastProvider } from "@/components/v12/ui";
import { JoinProvider, useJoin } from "@/components/v12/join/JoinProvider";
import { readCode } from "@/components/v12/join/read-code";
import { VisitorHeader } from "./VisitorHeader";
import { InviteBanner } from "./InviteBanner";
import { VisitorHome } from "./VisitorHome";
import { VisitorMake } from "./VisitorMake";
import { VisitorBoard } from "./VisitorBoard";
import { NoAccess } from "./NoAccess";
import "@/components/v12/v12.css";
import "@/components/v12/shell/header.css";
import "@/components/v12/home/home.css";
import "@/components/v12/board/board.css";
import "./visitor.css";

/**
 * The new interface for a signed-out visitor (docs/redesign/inventory.md § 8; prototype `?guest=1`), at `/?guest=1` while
 * the platform owner has Guest Home on. The same app, laid out the same way: Particl's own showcase, Make, and the sample
 * board, with a join sheet behind every action that would think, spend, keep or send work. Nothing here reads a workspace:
 * a visitor has no session, and the only requests are the two invite checks and Request access (components/v12/join).
 */
export type VisitorAppProps = {
  /** The sample's own title (lib/guest/sample.server.ts), or the design's default. */
  sampleTitle: string;
  /** The public sample production as words (no media, no ids), or null while none is marked. */
  sampleBoard: GuestBoard | null;
  ask: VisitorAsk;
};

const subscribe = () => () => {};
const snapshot = () => "ready";
const serverSnapshot = () => "pending";

export function VisitorApp(props: VisitorAppProps) {
  /* The viewport is the browser's: nothing is drawn until it is known, so neither layout flashes first. */
  const phase = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  if (phase === "pending") return null;
  return (
    <OverlayProvider>
      <ToastProvider bottom={24}>
        <Inside {...props} />
      </ToastProvider>
    </OverlayProvider>
  );
}

function Inside(props: VisitorAppProps) {
  const compact = useCompact();
  const { ask } = props;
  const back = typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`;
  return (
    <JoinProvider compact={compact} back={back} initial={{ open: Boolean(ask.join), reason: ask.join ?? "start", requested: ask.requested, step: ask.step === "plan" ? "plan" : "name" }}>
      <Screens {...props} compact={compact} />
    </JoinProvider>
  );
}

/** The address follows the screen, so a reload or a link lands on the same one; the visitor's other params stay. */
function useScreen(initial: VisitorScreen): [VisitorScreen, (next: VisitorScreen) => void] {
  const [screen, setScreen] = useState(initial);
  const go = useCallback((next: VisitorScreen) => {
    setScreen(next);
    const url = new URL(window.location.href);
    if (next === "home") url.searchParams.delete("screen"); else url.searchParams.set("screen", next);
    window.history.replaceState(window.history.state, "", url);
  }, []);
  useEffect(() => {
    const onPop = () => setScreen(visitorAsk(Object.fromEntries(new URL(window.location.href).searchParams)).screen);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return [screen, go];
}

function Screens({ sampleTitle, sampleBoard, ask, compact }: VisitorAppProps & { compact: boolean }) {
  const join = useJoin()!;
  const [screen, go] = useScreen(ask.screen);
  const { setInvite, openJoin } = join;

  /* An invite link: its code is read by today's routes, the sheet opens with it filled in, and a banner says what it is. */
  useEffect(() => {
    if (!ask.invite) return;
    let live = true;
    void readCode(ask.invite).then((kind) => {
      if (!live) return;
      setInvite(kind);
      if (kind.kind !== "invalid") openJoin("start", { requested: false });
    }).catch(() => { /* the code could not be checked: the banner stays away and the sheet takes a code by hand */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once, for the link the visitor arrived by
  }, [ask.invite]);

  /* ⌘K and ⌘J are a member's search and Atomik: for a visitor, the sheet. */
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && (k === "k" || k === "j" || k === "/")) { e.preventDefault(); openJoin("ask"); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [openJoin]);

  const body = useMemo(() => {
    if (ask.board) return <NoAccess />;
    if (screen === "make") return <VisitorMake compact={compact} />;
    if (screen === "board") return <VisitorBoard title={sampleTitle} board={sampleBoard} />;
    return <VisitorHome compact={compact} />;
  }, [ask.board, screen, compact, sampleTitle, sampleBoard]);

  return (
    <div className="v12 v12-frame v12-visitor" data-testid="v12-visitor" data-screen={ask.board ? "no-access" : screen} data-compact={compact ? "" : undefined}>
      {ask.board ? null : <InviteBanner compact={compact} />}
      <div className="v12-head" data-testid="v12-head"><VisitorHeader screen={ask.board ? null : screen} sampleTitle={sampleTitle} compact={compact} onGo={go} /></div>
      <div className="v12-body" data-testid="v12-body">{body}</div>
    </div>
  );
}
