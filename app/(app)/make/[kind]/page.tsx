import { notFound, redirect } from "next/navigation";
import { generationHref, type GenRouteSearch } from "@/lib/genRoute";

export const metadata = { title: "Gen · Particl" };

/** Enter the canonical workspace before any client-side prompt or asset handoff. */
export default async function MakePage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string }>;
  searchParams: Promise<GenRouteSearch>;
}) {
  const [{ kind }, search] = await Promise.all([params, searchParams]);
  const href = generationHref(kind, search);
  if (!href) notFound();
  redirect(href);
}
