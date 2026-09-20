"use client";
import { useEffect, useState } from "react";
import { displayModelName } from "../models";
import { useNow } from "./use-now";
import {
  ATOMIK_RULES,
  creditsCard,
  teamRows,
  topupAction,
  workspaceRows,
  type CreditsCard,
  type LimitsRead,
  type MeRead,
  type SettingsRead,
  type SettingsRow,
  type TeamRead,
  type TeamRow,
  type TopupsRead,
  type UsageRead,
} from "./settings-data";

/**
 * The Settings screen's live read. Six existing routes, each optional: a route
 * that refuses (the roster and the packs are an admin's to read) drops its
 * section rather than blocking the screen, and nothing here writes — Top up
 * and Invite link into the flows that own them.
 */

export type SettingsData = {
  loading: boolean;
  credits: CreditsCard | null;
  rows: SettingsRow[];
  /** Null when the roster could not be read at all; then the section is absent. */
  team: TeamRow[] | null;
  topup: { label: string; href: string } | null;
  /** The existing invite flow, for an admin who can use it. */
  inviteHref: string | null;
  rules: typeof ATOMIK_RULES;
  /** One line naming what could not be read, when something could not. */
  unavailable: string | null;
};

async function read<T>(url: string, signal: AbortSignal): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store", signal });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function useSettingsData(): SettingsData {
  const now = useNow();
  const [reads, setReads] = useState<{
    loading: boolean;
    me: MeRead | null;
    settings: SettingsRead | null;
    limits: LimitsRead | null;
    usage: UsageRead | null;
    topups: TopupsRead | null;
    team: TeamRead | null;
  }>({ loading: true, me: null, settings: null, limits: null, usage: null, topups: null, team: null });

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    void Promise.all([
      read<MeRead>("/api/me", signal),
      read<SettingsRead>("/api/settings", signal),
      read<LimitsRead>("/api/limits", signal),
      read<UsageRead>("/api/usage", signal),
      read<TopupsRead>("/api/workspaces/topups", signal),
      read<TeamRead>("/api/team", signal),
    ]).then(([me, settings, limits, usage, topups, team]) => {
      if (signal.aborted) return;
      setReads({ loading: false, me, settings, limits, usage, topups, team });
    });
    return () => controller.abort();
  }, []);

  const rows = workspaceRows({ me: reads.me, settings: reads.settings, limits: reads.limits, modelName: displayModelName });
  const team = reads.team ? teamRows(reads.team) : null;
  const canInvite = reads.me?.owner === true || reads.me?.role === "admin";
  const missing = [
    reads.loading ? null : reads.me ? null : "the account",
    reads.loading || reads.usage ? null : "this month’s usage",
    reads.loading || reads.team ? null : "the team roster",
  ].filter((part): part is string => Boolean(part));

  return {
    loading: reads.loading,
    credits: creditsCard(reads.me, reads.usage, now),
    rows,
    team,
    topup: topupAction(reads.topups),
    inviteHref: team && canInvite ? "/team" : null,
    rules: ATOMIK_RULES,
    unavailable: missing.length ? `This account cannot read ${missing.join(" or ")}, so it is not shown.` : null,
  };
}
