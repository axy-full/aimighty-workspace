import { redirect } from "next/navigation";

/** The old address of a project's recipe. Recipes are one list now (SOW surfaces 12d); the project rides along as context. */
export default async function ProjectRecipes({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  redirect(`/rig/recipes?project=${encodeURIComponent(projectId)}`);
}
