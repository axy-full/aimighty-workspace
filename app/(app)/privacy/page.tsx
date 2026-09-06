"use client";

import Link from "next/link";
import { PolicyPage, P } from "@/components/PolicyPage";

export default function PrivacyPage() {
  return (
    <PolicyPage title="Privacy & retention" updated="6 September 2026"
      intro="What the platform keeps about a workspace, where, for how long, and who can see it.">
      <P title="What is kept">
        <p>Your account: name, email and password hash. Your workspace&rsquo;s work: prompts, references, takes and their masters, cast and identities, shots and productions. Its records: what was billed, in credits, and the engine&rsquo;s cost behind it, for the platform&rsquo;s own books. Technical logs for a short while, to find faults.</p>
      </P>
      <P title="Where">
        <p>Each workspace has a database of its own, at Turso, holding everything but the files. Masters, uploads and identity photos are objects in private storage on Vercel, under a prefix that is the workspace&rsquo;s alone, reachable only by short-lived signed links. The platform record — accounts, workspaces, credits, meter — is a separate database.</p>
      </P>
      <P title="Who sees it">
        <p>Your team, by role: members render, pick and approve; admins run the team and the ledger; the owner alone deletes the workspace or exports it. The platform&rsquo;s desk sees each workspace&rsquo;s spend, balance, engine health and any report about it, and can suspend a workspace; it does not browse a workspace&rsquo;s takes. The engines receive the prompt and the references needed to render one take, under their own terms, and nothing else.</p>
      </P>
      <P title="How long">
        <p>Masters are kept as long as the workspace keeps them. A take you delete is pruned after the workspace&rsquo;s retention setting, or kept if that is set to keep everything. Deleting the workspace purges every file and its database; the platform keeps only its billing record. An export of every take, prompt, cost and master is available to the owner at any time from Settings › Account.</p>
      </P>
      <P title="Keys and links">
        <p>Vendor keys a workspace adds are sealed on the server and shown back masked, never in full. Every link to a master expires. Nothing here is used to train a model.</p>
      </P>
      <P title="Questions">
        <p>Ask the platform, from the same place you request an invitation, or <Link href="/report" className="text-ink">report</Link> something that should not be here.</p>
      </P>
    </PolicyPage>
  );
}
