import { redirectToSuites, type RawSearch } from "@/lib/workspace/switchover.server";

/** The old app home. Visitors never reach it without app params (proxy.ts shows them the public site). */
export default async function Home({ searchParams }: { searchParams: Promise<RawSearch> }) {
  redirectToSuites("/", await searchParams);
}
