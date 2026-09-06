"use client";

import Link from "next/link";
import { PolicyPage, P } from "@/components/PolicyPage";

export default function ContentPolicyPage() {
  return (
    <PolicyPage title="Content policy" updated="6 September 2026"
      intro="particl is for film made with generative engines by working teams. This is what may not be made with it, what the engines refuse on their own, and what happens when something is reported.">
      <P title="Not allowed">
        <p>Sexual content involving anyone under 18, in any form, real or generated.</p>
        <p>Sexual content of a real person who has not agreed to it.</p>
        <p>A real person&rsquo;s likeness used to deceive: putting words in their mouth, showing them doing what they did not do, or passing generated footage off as real. An identity trained from photos needs the consent of the person in them, and you confirm that when you train one.</p>
        <p>Content that harasses, threatens or dehumanises people for who they are, or that incites violence.</p>
        <p>Anything unlawful where you or the platform operate, and anything that tries to defeat an engine&rsquo;s own safety rules.</p>
      </P>
      <P title="What the engines refuse">
        <p>Every engine has rules of its own and refuses some prompts, sometimes ones that break none of the above. A refused take says so plainly on its card; a refusal before the render starts costs nothing.</p>
      </P>
      <P title="What happens">
        <p>A report is read by the platform&rsquo;s desk. A workspace can be flagged for review, and for abuse it is suspended: rendering stops, everything already made stays readable, and the workspace is told why. Repeated or serious abuse ends the workspace.</p>
        <p>The platform does not train anything on a workspace&rsquo;s work. The engines receive prompts and references to render under their own terms.</p>
      </P>
      <P title="To report something">
        <p>Use the <Link href="/report" className="text-ink">report form</Link>: a link or a take id, what is wrong, and a way to reach you if you want one.</p>
      </P>
    </PolicyPage>
  );
}
