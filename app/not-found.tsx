import { NotFoundView } from "@/components/graphite/NotFoundView";

/**
 * A link to nothing. Usually an old bookmark, or a project or take that has
 * since been archived — both ordinary here, so this says so plainly rather
 * than treating it as a fault, keeps the Suites header, and offers the three
 * ways back in: Studio, Takes and ⌘K search.
 *
 * It is also the whole site's 404, so a visitor on a dead public link gets
 * the front page and Sign in instead (FaultPage asks /api/me once it loads).
 * Next renders this file into every page's tree, so it stays light: nothing
 * here may read the request — one cookies(), headers() or connection() call
 * would make every static route (/login, /pricing, /signup, the 404 itself)
 * render on demand — and the page itself loads only with a 404 (NotFoundView).
 */
export default function NotFound() {
  return <NotFoundView />;
}
