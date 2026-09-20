import SuiteHome from "@/components/suites/SuiteHome";
import SwitchoverGate from "@/components/switchover/SwitchoverGate";
import { switchoverTargetFor, type RawSearch } from "@/lib/workspace/switchover.server";

export default async function Home({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const { target, search } = await switchoverTargetFor("/", await searchParams);
  return (
    <SwitchoverGate target={target} search={search}>
      <SuiteHome />
    </SwitchoverGate>
  );
}
