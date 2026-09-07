"use client";

import Link from "next/link";
import { PolicyPage, P } from "@/components/PolicyPage";

export default function TermsPage() {
  return (
    <PolicyPage title="Terms" updated="6 September 2026"
      intro="The working terms between a workspace and the platform, in plain sentences.">
      <P title="Your account and workspace">
        <p>Sign-up is by invitation. Your workspace is yours: its own database, its own team, its own settings. You may delete it at any time from Settings › Account, and everything in it is purged.</p>
      </P>
      <P title="Credits">
        <p>Renders, stills, sound, training and the prompt writer are paid for in credits, bought in packs. A take&rsquo;s price is shown in credits before you press, and that is what it costs; a refused take costs nothing. Spent credits are spent. Unspent credits stay on the workspace; ask the platform about returning them.</p>
      </P>
      <P title="Your work">
        <p>What you make is yours. The platform claims no rights in your prompts, references or takes, and does not train on them. What an engine&rsquo;s own terms say about what it generates applies to that engine&rsquo;s output.</p>
      </P>
      <P title="Acceptable use">
        <p>The <Link href="/policy" className="text-ink">content policy</Link> is part of these terms. Breaking it can suspend or end the workspace.</p>
      </P>
      <P title="Availability">
        <p>The engines are third parties, and so is the storage. The platform does its best to keep everything reachable and says on the Usage page what each engine is doing; it cannot promise a vendor stays up. A take that fails for a vendor&rsquo;s reason says so and is not billed for what the vendor did not deliver.</p>
      </P>
      <P title="Changes">
        <p>These terms change here, on this page, with the date at the bottom. A change that matters is announced in the product before it applies.</p>
      </P>
    </PolicyPage>
  );
}
