import SubatomikWorkspace from "@/components/suites/SubatomikWorkspace";
import SwitchoverGate from "@/components/switchover/SwitchoverGate";
import { switchoverTargetFor, type RawSearch } from "@/lib/workspace/switchover.server";

export const metadata = { title: "Subatomik Viral Studio · Particl", description: "Subatomik Viral Studio" };
export default async function Page({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const { target, search } = await switchoverTargetFor("/subatomik", await searchParams);
  return (
    <SwitchoverGate target={target} search={search}>
      <SubatomikWorkspace />
    </SwitchoverGate>
  );
}
