import { FaultPage } from "@/components/graphite/FaultPage";

/**
 * A link to nothing. Usually an old bookmark, or a project or take that has
 * since been archived — both ordinary here, so this says so plainly rather
 * than treating it as a fault, keeps the Suites header, and offers the three
 * ways back in: Studio, Takes and ⌘K search.
 */
export default function NotFound() {
  return <FaultPage kind="missing" />;
}
