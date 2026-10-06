import { redirect } from "next/navigation";
import { suiteHref } from "@/lib/suites";
import { redirectToSuites, type RawSearch } from "@/lib/workspace/switchover.server";

export default async function Page({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const params = await searchParams;
  /* Shorts ran only on a signed-in Higgsfield account: off for Release 1 (lib/higgsfield-consumer/retired.ts).
     Its old address lands on the suite's first page, for the same project. */
  if (params.page === "shorts") {
    const project = typeof params.project === "string" ? params.project : undefined;
    redirect(suiteHref("subatomik", project));
  }
  redirectToSuites("/subatomik", params);
}
