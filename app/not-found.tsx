import { cookies } from "next/headers";
import { FaultPage } from "@/components/graphite/FaultPage";
import { SESSION_COOKIE } from "@/lib/sessionCookie";

/**
 * A link to nothing. Usually an old bookmark, or a project or take that has
 * since been archived — both ordinary here, so this says so plainly rather
 * than treating it as a fault, keeps the Suites header, and offers the three
 * ways back in: Studio, Takes and ⌘K search.
 *
 * It is also the whole site's 404, so a visitor on a dead public link gets
 * the front page and Sign in instead — the suites would only send them to
 * sign in. Member or visitor is read the way proxy.ts reads it: the session
 * cookie is there or it is not.
 */
export default async function NotFound() {
  const member = (await cookies()).has(SESSION_COOKIE);
  return <FaultPage kind="missing" member={member} />;
}
