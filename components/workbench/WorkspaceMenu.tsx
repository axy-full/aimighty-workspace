"use client";
import { useEffect, useState } from "react";
import {
  ChevronDown,
  Check,
  Users,
  CreditCard,
  ChartNoAxesColumn,
  LogOut,
  Settings2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
export type WorkbenchAccount = {
  name: string;
  workspace: { id: string; name: string } | null;
  workspaces: { id: string; name: string; role: string }[];
  credits?: { balance: number } | null;
};
export default function WorkspaceMenu({
  initial,
  onNavigate,
  onSwitch,
  onSignOut,
}: {
  initial: WorkbenchAccount | null;
  onNavigate: (path: string) => Promise<void>;
  onSwitch: (id: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [account, setAccount] = useState(initial),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!initial?.workspace?.id) return;
    const controller = new AbortController();
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void fetch("/api/me", { signal: controller.signal })
        .then(async (response) => {
          if (response.ok) {
            const data = await response.json();
            setAccount(data);
          }
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [initial?.workspace?.id]);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }
  if (!account)
    return (
      <a className="workbench-account-entry" href="/pricing">
        Create workspace
      </a>
    );
  return (
    <div className="workbench-account">
      <button
        type="button"
        className="workbench-credit"
        disabled={busy}
        onClick={() => void run(() => onNavigate("/billing"))}
        aria-label="Workspace credits and billing"
      >
        {typeof account.credits?.balance === "number"
          ? `${Math.round(account.credits.balance).toLocaleString()} cr`
          : "Billing"}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="workbench-workspace"
            aria-label="Workspace menu"
            disabled={busy}
          >
            <span>{account.workspace?.name || account.name}</span>
            <ChevronDown size={13} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="ps workbench-account-menu" align="end">
          <div className="workbench-account-identity">
            <strong>{account.name}</strong>
            <span>{account.workspace?.name || "Workspace setup"}</span>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => void run(() => onNavigate("/team"))}
          >
            <Users size={15} />
            Team
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void run(() => onNavigate("/billing"))}
          >
            <CreditCard size={15} />
            Billing
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void run(() => onNavigate("/usage"))}
          >
            <ChartNoAxesColumn size={15} />
            Usage
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void run(() => onNavigate("/settings"))}
          >
            <Settings2 size={15} />
            Account & settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="workbench-menu-label">Switch workspace</div>
          {account.workspaces.map((workspace) => (
            <DropdownMenuItem
              key={workspace.id}
              disabled={busy || workspace.id === account.workspace?.id}
              onSelect={() => void run(() => onSwitch(workspace.id))}
            >
              {workspace.name}
              {workspace.id === account.workspace?.id && <Check size={13} />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem
            onSelect={() =>
              void run(() => onNavigate("/billing?workspace=new"))
            }
          >
            Create a workspace
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void run(onSignOut)}>
            <LogOut size={15} />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
