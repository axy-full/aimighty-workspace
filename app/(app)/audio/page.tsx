import { redirect } from "next/navigation";
import { generationHref, type GenRouteSearch } from "@/lib/genRoute";

export default async function Moved({ searchParams }: { searchParams: Promise<GenRouteSearch> }) {
  redirect(generationHref("audio", await searchParams)!);
}
