import { Suspense } from "react";
import PipelineWorkspace from "@/components/pipeline/PipelineWorkspace";
export const metadata = { title: "Pipelines · Particl" };
export default function PipelinesPage() {
  return (
    <Suspense fallback={<p role="status">Loading production pipelines…</p>}>
      <PipelineWorkspace />
    </Suspense>
  );
}
