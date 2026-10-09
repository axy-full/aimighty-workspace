import SubatomikWorkspace from "@/components/suites/SubatomikWorkspace";
import SwitchoverGate from "@/components/switchover/SwitchoverGate";
import { switchNowOrGate, type RawSearch } from "@/lib/workspace/switchover.server";

export const metadata = { title: "Social · Particl", description: "Social" };
export default async function Page({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const { target, search } = await switchNowOrGate("/subatomik", await searchParams);
  return (
    <SwitchoverGate target={target} search={search}>
      <SubatomikWorkspace />
    </SwitchoverGate>
  );
}
