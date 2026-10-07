import type { Metadata } from "next";
import Link from "next/link";
import SitePage, { sitePrices } from "@/components/marketing/SitePage";
import { Fact, Grid, Group, Note, Section, SuiteHeader, Window } from "@/components/marketing/ui";
import { ACCESS_HREF, shot } from "@/lib/marketing/site";
import { WORKSPACE_TABS } from "@/lib/shell/ia";

export const metadata: Metadata = {
  title: "Workspace",
  description: "One isolated database per workspace, and every account, session and policy change on an append-only audit trail.",
};

/* Sources: lib/shell/ia.ts (the tabs), components/graphite/WorkspaceView.tsx,
   app/(app)/settings/page.tsx, lib/settings.ts, lib/approvalRule.ts,
   app/api/team (INVITE_DAYS), lib/teamInvitations.ts, lib/plans.ts,
   lib/packs.ts, lib/billingLedger.ts, lib/statements.ts, lib/creditUsage.ts,
   app/api/workspaces/keys, lib/meter.ts, app/api/tokens, app/api/export,
   lib/purge.ts, docs/account-security.md, docs/workspace-security-policy.md,
   docs/subscribed-workspaces.md, docs/enterprise-readiness.md. */

export default async function WorkspacePage() {
  const { plans } = await sitePrices();
  const paid = plans.filter((plan) => plan.priceUsd > 0);
  const members = paid.length > 0 && paid.every((plan) => plan.maxMembers == null) ? "Unlimited on paid plans" : "Set per plan";

  const FACTS: [string, string][] = [
    ["Tenancy", "One database per workspace"],
    ["Members", members],
    ["Invites", "One-time links · 7 days"],
    ["Sign-in", "TOTP + recovery codes"],
    ["Export", "JSON + media manifest"],
  ];

  return (
    <SitePage active="workspace">
      <SuiteHeader
        eyebrow="06 · Workspace"
        title="One workspace. Every action attributed."
        lead="A production house gets its own isolated database and private storage. Every account and session change writes an audit receipt."
        pages={WORKSPACE_TABS.map((tab) => tab.label)}
        cta={(
          <>
            <a href={ACCESS_HREF} className="mk-btn gx-primary">Request access</a>
            <Link href="/" className="mk-btn mk-btn--secondary">Open Make</Link>
          </>
        )}
      />

      {/* The suite header already draws the hairline above this section. */}
      <Section id="workspace-management" panel label="Workspace management" style={{ borderTop: 0 }}>
        <Grid col={180} style={{ gap: 10 }}>
          {FACTS.map(([k, v]) => <Fact key={k} k={k} v={v} />)}
        </Grid>

        <Grid col={300} style={{ gap: 20 }}>
          <Window path="particl.si / settings / plan & credits" src={shot("settings-plan-credits")} alt="Settings, Plan & credits: the balance, this month, Top up and the plan" width={924} height={540} />
        </Grid>

        <Grid col={270} style={{ alignItems: "start" }}>
          <Group tag="General" note="workspace-wide defaults" rows={[
            { name: "Workspace identity", chip: "owner", desc: "The name your team sees everywhere; only the owner renames it." },
            { name: "Production defaults", chip: "workspace-wide", desc: "Default video and still engine, and take approvals." },
            { name: "Prompt enhancer", chip: "workspace-wide", desc: "One provider for every suite, chosen here. Never applied to raw: prompts." },
          ]} />
          <Group tag="People" rows={[
            { name: "Invite", chip: "7 days", desc: "One-time links an admin creates; they expire after seven days and are consumed in the same transaction as the seat." },
            { name: "Roles", chip: "owner · admin · member", desc: "Only the owner changes roles; admins invite, disable and unlock from the member row." },
            { name: "Access requests", chip: "reviewed", desc: "Requests from this site wait for the platform administrator; nothing is granted automatically." },
            { name: "Sign-in policy", chip: "optional by default", desc: "The owner can require an authenticator for everyone; until they enrol, members keep only account security, onboarding and workspace switching." },
          ]} />
          <Group tag="Usage" rows={[
            { name: "By project · person · month", chip: "CSV", desc: "Completed generations, attempts and failures, with a CSV export." },
            { name: "Dashboard", chip: "by period", desc: "Revisions per shot and where generations stall; filter and export." },
          ]} />
          <Group tag="Engines" rows={[
            { name: "Atomik allowlist", chip: "per engine", desc: "Choose which engines Atomik may propose." },
          ]} />
          <Group tag="Security" note="account-wide" rows={[
            { name: "Two-step sign-in", chip: "TOTP", desc: "Authenticator enrolment verifies a code before enabling it, encrypts the secret, rejects replays and replaces earlier sessions." },
            { name: "Recovery codes", chip: "single-use", desc: "Random, hashed, single-use; replacement is staged, so an interrupted swap cannot lock you out." },
            { name: "Sessions", chip: "revocable", desc: "List and revoke browser sessions; a password reset keeps two-step sign-in and signs every other session out." },
            { name: "Audit", chip: "append-only", desc: "Account, session, member and policy changes commit with an append-only security event in the same transaction." },
            { name: "API tokens", chip: "read · render", desc: "Bearer tokens for the CLI and MCP server, shown once and stored hashed. Read tokens cannot mutate; account, team, key and owner operations need a browser session." },
            { name: "Data", chip: "export · keep", desc: "The owner exports JSON, a takes CSV and a media manifest. Deleting a workspace ends access at once; its database and files are kept." },
          ]} />
        </Grid>

        <Note lead="Not claimed yet:">SSO, SCIM, passkeys and independently retained audit archives are open work. Uploads keep their original bytes and stay private; a deleted take is hidden, never erased, and can be restored.</Note>
      </Section>
    </SitePage>
  );
}
