import AtomikSuite from "@/components/suites/AtomikSuite";
import SwitchoverGate from "@/components/switchover/SwitchoverGate";
import { switchNowOrGate, type RawSearch } from "@/lib/workspace/switchover.server";

export default async function AtomikIndex({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const { target, search } = await switchNowOrGate("/atomik", await searchParams);
  return (
    <SwitchoverGate target={target} search={search}>
      <AtomikSuite />
    </SwitchoverGate>
  );
}
