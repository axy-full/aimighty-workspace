"use client";

import { useSession } from "@/lib/session";
import StudioNavigation from "@/components/studio/StudioNavigation";

export default function Header() {
  const { signedIn, name, workspace, workspaces, credits } = useSession();
  return <StudioNavigation initialAccount={signedIn ? {
    name: name ?? "Your account", workspace, workspaces, credits,
  } : null} />;
}
