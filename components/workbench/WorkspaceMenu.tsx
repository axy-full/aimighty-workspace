"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useSignInHref } from "@/lib/session";
import {
  ChevronDown,
  Check,
  Users,
  CreditCard,
  ChartNoAxesColumn,
  LogOut,
  Settings2,
  Plus,
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
  mfaRequired?: boolean;
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
  const pathname = usePathname();
  /* Back to this stage and project after signing in, not to the front page. */
  const signIn = useSignInHref();
  const [account, setAccount] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const busyRef = useRef(false);
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
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your account could not be changed. Please try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  if (!account) return <div className="studio-account-entry">
    <a className="studio-account-signin" href={signIn}>Sign in</a>
    <a href="/pricing">Create workspace</a>
  </div>;
  const initials = account.name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase() || "P";
  return (
    <div className="studio-account">
      {error && <span className="studio-navigation-error" role="alert">{error}</span>}
      {account.mfaRequired && pathname !== "/account/security" ? <a
        className="studio-account-signin"
        href="/account/security"
        target="_blank"
        rel="noopener"
        title="Set up two-step sign-in in a new tab, then return to your unsaved work."
      >Set up sign-in</a> : <button
        type="button"
        className="studio-credit"
        disabled={busy}
        onClick={() => void run(() => onNavigate("/billing"))}
        aria-label="Workspace credits and billing"
      >
        <span className="studio-credit-label">Credits</span>
        {typeof account.credits?.balance === "number"
          ? `${Math.round(account.credits.balance).toLocaleString()} cr`
          : "Billing"}
      </button>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="studio-workspace-trigger"
            aria-label="Workspace menu"
            disabled={busy}
          >
            <span className="studio-account-avatar" aria-hidden="true">{initials}</span>
            <span className="studio-workspace-name">{account.workspace?.name || account.name}</span>
            <ChevronDown size={13} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="studio-account-menu" align="end">
          <div className="studio-account-identity">
            <span className="studio-account-avatar" aria-hidden="true">{initials}</span>
            <div><strong>{account.name}</strong><small>{account.workspace?.name || "Workspace setup"}</small></div>
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
            Credits & plan
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
            Workspace & account
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="studio-menu-label">Switch workspace</div>
          {account.workspaces.map((workspace) => (
            <DropdownMenuItem
              key={workspace.id}
              aria-label={workspace.name}
              disabled={busy || workspace.id === account.workspace?.id}
              onSelect={() => void run(() => onSwitch(workspace.id))}
            >
              <span className="studio-account-workspace-item"><span>{workspace.name}</span><small>{workspace.role}</small></span>
              {workspace.id === account.workspace?.id && <Check size={13} />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem
            onSelect={() =>
              void run(() => onNavigate("/billing?workspace=new"))
            }
          >
            <Plus size={15} />Create a workspace
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
