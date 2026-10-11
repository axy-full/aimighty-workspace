"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { EMPTY_DRAFT, cleanDraft, type HomeDraft } from "../home/home-model";
import { TemplateRow } from "../home/TemplateRow";
import { decodeGuestBrief, guestBriefRaw, saveGuestBrief, subscribeGuestBrief } from "@/lib/guest/brief";
import { GuestBox } from "./GuestBox";
import { GuestHeader } from "./GuestHeader";
import { GuestSample } from "./GuestSample";
import { SignupSheet } from "./SignupSheet";
import type { GuestBoard } from "@/lib/guest/board";
import "../home/home.css";
import "./guest.css";

export type GuestView = "home" | "sample";

/**
 * Home for a signed-out visitor at "/" (lead decisions 35 and 39; design README § 3.7, frames 1, 2, 3a, 3b and
 * P1–P3b). Rendered only while the platform owner has Guest Home on in /admin.
 *
 * What a guest sees: the header with Sign in and Sign up; "What are we making?" with the box, the templates and the
 * sample production. No projects, no Waiting for you, no balance, no price on Start and no thinking line. Every
 * action that would think, spend or keep work (Start, the templates, Make, Atomik, Search, Add references, anything
 * on the sample) opens the sign-up sheet. Nothing here calls a route that thinks, spends or writes a workspace: a
 * guest has no session, and the only requests are the invitation check and Request access.
 *
 * What the guest types is kept in this browser (lib/guest/brief.ts) and becomes their first board after sign-up.
 */
export function GuestHome({ initialView, initialSignup, invite, sampleTitle, sampleBoard = null, welcomeCredits }: {
  initialView: GuestView;
  initialSignup: boolean;
  /** An invitation code from the address (`?invite=`): the sheet opens in its "Create your account" state. */
  invite: string | null;
  sampleTitle: string;
  /** The sample production's board, read from the "Particl sample" workspace; null until one is marked. */
  sampleBoard?: GuestBoard | null;
  welcomeCredits: number | null;
}) {
  const [view, setView] = useState<GuestView>(initialView);
  const [sheet, setSheet] = useState(initialSignup || Boolean(invite));
  /* What this browser kept from an earlier visit (read after hydration, so the server's markup matches), until the
     guest edits the box; from then on the edits are the box. */
  const kept = useSyncExternalStore(subscribeGuestBrief, guestBriefRaw, () => null);
  const [edited, setEdited] = useState<HomeDraft | null>(null);
  const draft = edited ?? decodeGuestBrief(kept) ?? EMPTY_DRAFT;

  const setDraft = useCallback((next: HomeDraft | ((now: HomeDraft) => HomeDraft)) => {
    setEdited((before) => {
      const base = before ?? decodeGuestBrief(guestBriefRaw()) ?? EMPTY_DRAFT;
      const value = cleanDraft(typeof next === "function" ? next(base) : next);
      saveGuestBrief(value);
      return value;
    });
  }, []);

  /* The address follows the screen, so a link or a reload lands on the same frame; the invitation stays on it. */
  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === "sample") url.searchParams.set("sample", "1"); else url.searchParams.delete("sample");
    if (sheet) url.searchParams.set("signup", "1"); else url.searchParams.delete("signup");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [view, sheet]);

  const openSheet = useCallback(() => setSheet(true), []);
  const closeSheet = useCallback(() => setSheet(false), []);

  /* ⌘K, ⌘J and ⌘/ open search, the inspector and Make for a member: for a guest, the sheet. */
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && (k === "k" || k === "j" || k === "/")) { e.preventDefault(); setSheet(true); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const goHome = () => { setView("home"); };

  return (
    <div className="gx-guest" data-testid="guest-home" data-view={view}>
      <GuestHeader mark={view === "sample" ? "BOARD" : "HOME"} view={view} onHome={goHome} onGated={openSheet} onSignup={openSheet} />
      {view === "sample" ? (
        <GuestSample title={sampleTitle} board={sampleBoard} onSignup={openSheet} />
      ) : (
        <div className="gx-hm gx-scroll" data-screen-label="Home">
          <div className="gx-hm-col">
            <section className="gx-hm-make" aria-labelledby="gx-hm-title">
              <h1 className="gx-hm-title" id="gx-hm-title" data-testid="page-title">What are we making?</h1>
              <GuestBox draft={draft} onDraft={setDraft} onGated={openSheet} />
            </section>
            <div className="gx-hm-starts">
              <TemplateRow pending={null} disabled={false} onPick={openSheet} />
            </div>
            <section className="gx-hm-section" aria-labelledby="gx-gh-sample-h">
              <p className="gx-hm-eyebrow" id="gx-gh-sample-h">A sample production · explore without spending</p>
              <button type="button" className="gx-hm-card gx-gh-sample" onClick={() => setView("sample")} data-testid="guest-sample-card">
                <span className="gx-hm-cover gx-gh-cover"><span className="gx-hm-badge">SAMPLE</span></span>
                <span className="gx-hm-card-body">
                  <span className="gx-hm-card-name">{sampleTitle}</span>
                  <span className="gx-hm-card-meta">Looks, storyboard, plan, shots and cut · open it</span>
                </span>
              </button>
            </section>
          </div>
        </div>
      )}
      {sheet ? <SignupSheet invite={invite} brief={draft.text} welcomeCredits={welcomeCredits} onClose={closeSheet} /> : null}
    </div>
  );
}
