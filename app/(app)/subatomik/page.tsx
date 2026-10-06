import { redirect } from "next/navigation";
import { suiteHref } from "@/lib/suites";
import SubatomikWorkspace from "@/components/suites/SubatomikWorkspace";
import SwitchoverGate from "@/components/switchover/SwitchoverGate";
import { switchNowOrGate, type RawSearch } from "@/lib/workspace/switchover.server";

export const metadata = { title: "Social · Particl", description: "Social" };
export default async function Page({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const params = await searchParams;
  /* Shorts ran only on a signed-in Higgsfield account: off for Release 1 (lib/higgsfield-consumer/retired.ts).
     Its old address lands on the suite's first page, for the same project. */
  if (params.page === "shorts") {
    const project = typeof params.project === "string" ? params.project : undefined;
    redirect(suiteHref("subatomik", project));
  }
  const { target, search } = await switchNowOrGate("/subatomik", params);
  return (
    <SwitchoverGate target={target} search={search}>
      <SubatomikWorkspace />
    </SwitchoverGate>
  );
}
