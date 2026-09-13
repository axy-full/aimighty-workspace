"use client";

import Link from "next/link";
import { PolicyPage, P } from "@/components/PolicyPage";

export default function TermsPage() {
  return (
    <PolicyPage
      title="Terms"
      updated="13 September 2026"
      intro="The working terms between a workspace and the platform, in plain sentences."
    >
      <P title="Your account and workspace">
        <p>
          Registration requires a verified email address. Each production house
          has its own workspace, team and settings. The owner can export or
          delete the workspace from Settings › Account. Deletion removes access
          immediately; file and database cleanup follows and is retried if a
          storage service is unavailable.
        </p>
      </P>
      <P title="Credits">
        <p>
          Renders, stills, sound, training and assistant requests spend
          workspace credits. Review the quoted cost before submitting. Confirmed
          provider rejections release their reservation. If a request times out
          after submission, its outcome and reserved credits may need
          reconciliation before they can be released.
        </p>
      </P>
      <P title="Plans and credit lifetime">
        <p>
          When online subscriptions are available, the billing page shows the
          plan, billing interval and amount before checkout. Monthly included
          credits expire at the end of their monthly window and do not roll
          over. Annual plans are billed annually, with a 20% discount and
          monthly credit windows. Selecting a plan at signup does not activate
          it or grant credits.
        </p>
        <p>
          New credit packs and their bonuses have a twelve-month lifetime
          measured while the workspace is off a paid plan. That clock pauses
          during confirmed paid coverage and resumes when coverage ends.
          Existing credits are not given a retroactive expiry. Contact the
          platform about disputed charges or refunds.
        </p>
      </P>
      <P title="Your work">
        <p>
          What you make is yours. The platform claims no rights in your prompts,
          references or takes, and does not train on them. What an
          engine&rsquo;s own terms say about what it generates applies to that
          engine&rsquo;s output.
        </p>
      </P>
      <P title="Acceptable use">
        <p>
          The{" "}
          <Link href="/policy" className="text-ink">
            content policy
          </Link>{" "}
          is part of these terms. Breaking it can suspend or end the workspace.
        </p>
      </P>
      <P title="Availability">
        <p>
          The engines are third parties, and so is the storage. The platform
          does its best to keep everything reachable and says on the Usage page
          what each engine is doing; it cannot promise a vendor stays up. Failed
          and uncertain requests are shown in their job records. A lost response
          does not prove that a provider did no work; the platform reconciles
          those requests before adjusting the charge.
        </p>
      </P>
      <P title="Changes">
        <p>
          These terms change here, on this page, with the date at the bottom. A
          change that matters is announced in the product before it applies.
        </p>
      </P>
    </PolicyPage>
  );
}
