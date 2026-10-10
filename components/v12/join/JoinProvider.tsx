"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { saveGuestBrief } from "@/lib/guest/brief";
import { EMPTY_DRAFT } from "@/components/graphite/home/home-model";
import type { InviteKind, JoinReason, RequestFields } from "./join-model";
import { JoinSheet } from "./JoinSheet";

/**
 * The join sheet's state for a visitor's whole visit (docs/redesign/inventory.md § 8.3): why it opened, the typed prompt,
 * the invite code and the request form. Closing the sheet (Esc, ×, the scrim) keeps all of it, so opening it again
 * shows what was typed. `openJoin` is what every gated action calls.
 */
export type JoinOpen = { detail?: string | null; prompt?: string; requested?: boolean };
export type JoinApi = {
  openJoin: (reason: JoinReason, options?: JoinOpen) => void;
  closeJoin: () => void;
  /** The words in the visitor's bar, so the sheet quotes them and pre-fills "What do you want to make?". */
  setPrompt: (prompt: string) => void;
  /** An invite link (`?invite=`): its code, read by today's routes, fills the sheet. */
  setInvite: (invite: InviteKind | null) => void;
  invite: InviteKind | null;
  open: boolean;
};

const JoinContext = createContext<JoinApi | null>(null);

/** The join API; null outside a visitor's page (a signed-in screen never gates). */
export function useJoin(): JoinApi | null {
  return useContext(JoinContext);
}

export const EMPTY_FIELDS: RequestFields = { name: "", email: "", company: "", role: "", size: "", want: "" };

export type JoinState = {
  open: boolean;
  reason: JoinReason;
  detail: string | null;
  prompt: string;
  requested: boolean;
  fields: RequestFields;
  code: string;
  /** A new-workspace invite: the name typed, the step, the plan looked at (display only). */
  workspace: string;
  step: "name" | "plan";
  plan: string;
  /** An expired invite shows the request form on request. */
  showRequest: boolean;
};

export function JoinProvider({ children, initial, compact = false, back = "/" }: {
  children: ReactNode;
  /** The sheet as the address opens it (`?join=…&requested=1`). */
  initial?: Partial<JoinState>;
  /** A phone: the sheet is a one-column bottom sheet. */
  compact?: boolean;
  /** Where "Log in" comes back to. */
  back?: string;
}) {
  const [state, setState] = useState<JoinState>(() => ({
    open: false, reason: "start", detail: null, prompt: "", requested: false, fields: EMPTY_FIELDS, code: "", workspace: "", step: "name", plan: "", showRequest: false, ...initial,
  }));
  const [invite, setInviteState] = useState<InviteKind | null>(null);

  const openJoin = useCallback((reason: JoinReason, options: JoinOpen = {}) => {
    setState((now) => {
      const prompt = options.prompt ?? now.prompt;
      /* "What do you want to make?" starts as the prompt, until the visitor writes something else there. */
      const want = !now.fields.want.trim() || now.fields.want === now.prompt ? prompt : now.fields.want;
      return { ...now, open: true, reason, detail: options.detail ?? null, prompt, requested: options.requested ?? now.requested, fields: { ...now.fields, want } };
    });
  }, []);
  const closeJoin = useCallback(() => setState((now) => ({ ...now, open: false })), []);
  const setPrompt = useCallback((prompt: string) => {
    setState((now) => (now.prompt === prompt ? now : { ...now, prompt }));
    /* Kept in this browser for after joining (lib/guest/brief.ts): the first board, and Home's bar with `?joined=1`. */
    saveGuestBrief({ ...EMPTY_DRAFT, text: prompt });
  }, []);
  const setInvite = useCallback((next: InviteKind | null) => {
    setInviteState(next);
    if (next && next.kind !== "invalid") setState((now) => ({ ...now, code: next.code }));
  }, []);

  const api = useMemo<JoinApi>(() => ({ openJoin, closeJoin, setPrompt, setInvite, invite, open: state.open }), [openJoin, closeJoin, setPrompt, setInvite, invite, state.open]);
  return (
    <JoinContext.Provider value={api}>
      {children}
      <JoinSheet state={state} setState={setState} invite={invite} compact={compact} back={back} onClose={closeJoin} />
    </JoinContext.Provider>
  );
}
