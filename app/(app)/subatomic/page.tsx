import { redirect } from "next/navigation";
import { suiteHref } from "@/lib/suites";
export default async function Page({ searchParams }: { searchParams: Promise<{ project?: string | string[]; page?: string | string[] }> }) {
  const query = await searchParams;
  const project = typeof query.project === "string" ? query.project : undefined;
  redirect(suiteHref("subatomik", project, typeof query.page === "string" ? query.page : undefined));
}
