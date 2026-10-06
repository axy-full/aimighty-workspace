import { redirectToSuites, type RawSearch } from "@/lib/workspace/switchover.server";

export default async function AtomikIndex({ searchParams }: { searchParams: Promise<RawSearch> }) {
  redirectToSuites("/atomik", await searchParams);
}
