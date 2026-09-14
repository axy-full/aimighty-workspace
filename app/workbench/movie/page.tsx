import { currentContext } from "@/lib/auth";
import { MoviePage } from "@/components/workbench/MoviePage";
import "../workbench.css";
import "../desk.css";
export const dynamic = "force-dynamic";
export const metadata = { title: "Particl — Final movie" };
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};
export default async function Movie({
  searchParams,
}: {
  searchParams: Promise<{ snapshot?: string }>;
}) {
  const [ctx, params] = await Promise.all([currentContext(), searchParams]);
  const scope = `particl-active-${ctx?.workspace?.id || "visitor"}-${ctx?.user.id || "visitor"}`;
  return (
    <MoviePage
      token={params.snapshot || ""}
      scope={scope}
      workspace={ctx?.workspace?.name || "Sample workspace"}
    />
  );
}
