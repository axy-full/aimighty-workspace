import { currentContext } from "@/lib/auth";
import { redirect } from "next/navigation";
import { MoviePage } from "@/components/workbench/MoviePage";
import { movieScopeFor } from "@/lib/workbench/movie-handoff";
import "../workbench.css";
import "../desk.css";
import "../mobile-handoff-stages.css";
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
  if (ctx?.mfaRequired) redirect("/account/security");
  const scope = movieScopeFor(ctx ? { id: ctx.user.id, workspaceId: ctx.workspace?.id } : null);
  return (
    <MoviePage
      token={params.snapshot || ""}
      scope={scope}
      workspace={ctx?.workspace?.name || "Sample workspace"}
    />
  );
}
