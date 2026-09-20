import AtomikSuite from "@/components/suites/AtomikSuite";
import DeviceProbe from "@/components/switchover/DeviceProbe";
import SwitchoverGate from "@/components/switchover/SwitchoverGate";
import { switchoverTargetFor, type RawSearch } from "@/lib/workspace/switchover.server";

export default async function AtomikIndex({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const { target, search } = await switchoverTargetFor("/atomik", await searchParams);
  return (
    <>
      {/* The device decision, taken while the document parses (DeviceProbe). */}
      <DeviceProbe />
      <SwitchoverGate target={target} search={search}>
        <AtomikSuite />
      </SwitchoverGate>
    </>
  );
}
