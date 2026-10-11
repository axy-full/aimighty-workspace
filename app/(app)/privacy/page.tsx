"use client";

import Link from "next/link";
import { PolicyPage, P } from "@/components/PolicyPage";

export default function PrivacyPage() {
  return (
    <PolicyPage
      title="Privacy & retention"
      updated="11 October 2026"
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
          Particl runs on its own server. Each workspace has a database of its
          own, at Turso, holding everything but the files. New masters, uploads
          and identity photos are objects in private storage on Cloudflare R2,
          under a prefix that is the workspace&rsquo;s alone, reachable only by
          short-lived signed links. Some older files are still in Vercel Blob
          until they are moved. Cloudflare also runs our DNS.
          Accounts, workspace
          membership, verification requests, credit grants and billing records
          are held in the platform record. Each customer workspace has a
          separate content database.
        </p>
        <p>
          Other services handle personal data for us: Resend sends email (your
          address, for sign-in and invites); Inngest runs background jobs (it
          receives the identifiers of the work to run, not prompts); and
          Liveblocks carries live team editing on a shared board.
        </p>
      </P>
      <P title="AI services">
        <p>
          To make a take or answer Atomik, the work you send goes to the service
          that runs it, under its own terms, and nothing else does:
        </p>
        <ul className="flex flex-col gap-1">
          <li><span className="text-ink">Anthropic</span>: your words to Atomik, and files attached to them.</li>
          <li><span className="text-ink">OpenAI</span>: prompts and reference images, for stills and some of Atomik&rsquo;s writing.</li>
          <li><span className="text-ink">Google</span>: prompts and reference images, for stills and some of Atomik&rsquo;s writing.</li>
          <li><span className="text-ink">xAI</span>: prompts and reference images, for stills, video, voice and some of Atomik&rsquo;s writing.</li>
          <li><span className="text-ink">BytePlus</span>: prompts, reference images and clips, for video.</li>
          <li><span className="text-ink">fal</span>: prompts, reference images and clips, for video, identity renders and upscales.</li>
          <li><span className="text-ink">Luma, through fal</span>: a finished clip, to re-cut to another shape.</li>
          <li><span className="text-ink">Higgsfield, by its API</span>: prompts and photos, for identities and stills.</li>
          <li><span className="text-ink">ElevenLabs</span>: scripts and audio, for speech, sound effects, music and dubbing.</li>
        </ul>
      </P>
      <P title="Who sees it">
        <p>
          Published project bibles and shared workspace assets are visible to
          your team. Private workbench drafts are scoped to their author. Access
          also depends on role: members render, pick and approve; admins run the
          team and the ledger; the owner alone deletes the workspace or exports
          it. The platform&rsquo;s desk sees each workspace&rsquo;s spend,
          balance, engine health and any report about it, and can suspend a
          workspace; it does not browse a workspace&rsquo;s takes.
        </p>
      </P>
      <P title="How long">
        <p>
          Nothing is erased. Masters are kept in storage: Cloudflare R2, or Vercel Blob for older ones. A take,
          upload or project you delete is hidden from every screen and kept,
          so it can be restored. Deleting a workspace immediately disables
          access and retires its key; its files and database are kept.
          Platform account and billing
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
