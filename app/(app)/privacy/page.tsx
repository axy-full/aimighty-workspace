"use client";

import Link from "next/link";
import { PolicyPage, P } from "@/components/PolicyPage";

export default function PrivacyPage() {
  return (
    <PolicyPage
      title="Privacy & retention"
      updated="13 September 2026"
      intro="What the platform keeps about a workspace, where, for how long, and who can see it."
    >
      <P title="What is kept">
        <p>
          Your account: name, email and password hash. Your workspace&rsquo;s
          work: prompts, references, takes and their masters, cast and
          identities, shots and projects. Its records: what was billed, in
          credits, and the engine&rsquo;s cost behind it, for the
          platform&rsquo;s own books. Technical logs for a short while, to find
          faults.
        </p>
      </P>
      <P title="Where">
        <p>
          Each workspace has a database of its own, at Turso, holding everything
          but the files. Masters, uploads and identity photos are objects in
          private storage on Vercel, under a prefix that is the
          workspace&rsquo;s alone, reachable only by short-lived signed links.
          Accounts, workspace membership, verification requests, credit grants
          and billing records are held in the platform record. Each customer
          workspace has a separate content database.
        </p>
      </P>
      <P title="Who sees it">
        <p>
          Published project bibles and shared workspace assets are visible to
          your team. Private workbench drafts are scoped to their author. Access
          also depends on role: members render, pick and approve; admins run the
          team and the ledger; the owner alone deletes the workspace or exports
          it. The platform&rsquo;s desk sees each workspace&rsquo;s spend,
          balance, engine health and any report about it, and can suspend a
          workspace; it does not browse a workspace&rsquo;s takes. The engines
          receive the prompt and the references needed to render one take, under
          their own terms, and nothing else.
        </p>
      </P>
      <P title="How long">
        <p>
          Masters are kept as long as the workspace keeps them. A take you
          delete is pruned after the workspace&rsquo;s retention setting, or
          kept if that is set to keep everything. Deleting a workspace
          immediately disables access. Cleanup then removes its files and
          database; failed stages are retried. Platform account and billing
          records remain. The owner can export shared workspace records and
          their own private drafts from Settings › Account. Collaborators&rsquo;
          private drafts are excluded. Media files are available through a
          separate authorized master manifest.
        </p>
      </P>
      <P title="Keys and links">
        <p>
          Vendor keys a workspace adds are sealed on the server and shown back
          masked, never in full. Every link to a master expires. Nothing here is
          used to train a model.
        </p>
      </P>
      <P title="Questions">
        <p>
          Contact the platform about your account or data, or{" "}
          <Link href="/report" className="text-ink">
            report
          </Link>{" "}
          something that should not be here.
        </p>
      </P>
    </PolicyPage>
  );
}
