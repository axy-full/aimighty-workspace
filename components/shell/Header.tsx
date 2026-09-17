"use client";

import {Suspense} from "react";
import {usePathname} from "next/navigation";
import Link from "next/link";
import ProjectStudioHeader from "@/components/studio/ProjectStudioHeader";
import { useSession } from "@/lib/session";
import StudioNavigation from "@/components/studio/StudioNavigation";

export default function Header() {
  const { signedIn, name, workspace, workspaces, credits } = useSession();
  const path=usePathname();
  if(/^\/(generate|make|library)(\/|$)/.test(path))return <Suspense fallback={<div className="project-header-loading">Loading Studio…</div>}><ProjectStudioHeader/></Suspense>;
  return <StudioNavigation hideSections initialAccount={signedIn ? {
    name: name ?? "Your account", workspace, workspaces, credits,
  } : null}><Link href="/workbench">Back to Studio</Link></StudioNavigation>;
}
