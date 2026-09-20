import AtomikSuite from "@/components/suites/AtomikSuite";
import SwitchoverGate from "@/components/switchover/SwitchoverGate";
import { switchoverTargetFor, type RawSearch } from "@/lib/workspace/switchover.server";

export default async function AtomikIndex({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const { target, search } = await switchoverTargetFor("/atomik", await searchParams);
  return (
    <SwitchoverGate target={target} search={search}>
      <AtomikSuite />
    </SwitchoverGate>
  );
}
