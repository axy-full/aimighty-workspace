import { suiteOfPage } from "@/lib/workspace/pages";
import type { PageId } from "@/lib/workspace/types";
import { pageOfLegacy, suiteOfLegacy, type ShellSuiteId } from "./ia";
import { isStageId } from "./stage-redirects";

type Run = { id: string; page: string; status: string };

/**
 * What the Atomik sheet shows of the engine's one run. A run held on another
 * page stays reachable (an approval never hides): its Suites page opens it,
 * and a run on a page the Suites have no place for has its gate in this
 * sheet instead, since `approve()` resumes the one run there is. Never an
 * Open that leads nowhere.
 */
export function atomikSheetRuns<R extends Run>(here: R | null, current: R | null): {
  elsewhere: { run: R; page: PageId; open: { suite: ShellSuiteId; page: string } | null } | null;
  gate: R | null;
} {
  const other = current && (!here || current.id !== here.id) && (current.status === "running" || current.status === "waiting") ? current : null;
  let elsewhere = null;
  if (other) {
    const page = other.page as PageId;
    const legacy = suiteOfPage(page);
    const target = pageOfLegacy(legacy, page);
    /* A Studio stage's run opens where the stage went: the board (goSuite sends a stage id to its region). */
    const open = legacy === "particl" && isStageId(page) ? { suite: "studio" as const, page } : target ? { suite: suiteOfLegacy(legacy), page: target.id } : null;
    elsewhere = { run: other, page, open };
  }
  const gate = here?.status === "waiting" ? here : elsewhere && !elsewhere.open && elsewhere.run.status === "waiting" ? elsewhere.run : null;
  return { elsewhere, gate };
}
