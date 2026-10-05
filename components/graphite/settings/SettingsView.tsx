"use client";
import type { WorkspaceAccount } from "@/lib/workspace/data";

/**
 * Settings' entry (stream 9): `?view=workspace&tab=<section>&open=<fold>`. STUB seeded by the shell (stream 1); stream 9
 * replaces this file with SettingsView and flips `landed` in lib/shell/settings.ts. Never mounted while `landed` is
 * false: the avatar still opens today's Workspace view.
 */
export function SettingsView(props: { account: WorkspaceAccount | null; section: string; open: string | null }) {
  void props;
  return null;
}
