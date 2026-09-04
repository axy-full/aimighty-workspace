"use client";

import { usePathname } from "next/navigation";
import ProjectRail from "./ProjectRail";
import AtomikRail from "./AtomikRail";

/**
 * Which column the left rail is.
 *
 * The layout is a server component, so the decision has to be made by a
 * client one — and it is one decision, made once, rather than each rail
 * knowing about the other. On Atomik the unit of work is a conversation;
 * everywhere else it is a project.
 */
export default function Rail() {
  const path = usePathname();
  return path.startsWith("/atomik") ? <AtomikRail /> : <ProjectRail />;
}
