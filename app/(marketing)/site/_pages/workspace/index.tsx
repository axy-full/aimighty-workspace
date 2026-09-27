import type { Metadata } from "next";
import Link from "next/link";
import SitePage, { sitePrices } from "@/components/marketing/SitePage";
import { Fact, Grid, Group, Note, Section, SuiteHeader, Window } from "@/components/marketing/ui";
import { cr, usd } from "@/lib/marketing/format";
import { ACCESS_HREF, shot } from "@/lib/marketing/site";
import { BONUS_CAP } from "@/lib/packs";
import { WORKSPACE_TABS } from "@/lib/shell/ia";

export const metadata: Metadata = {
  title: "Workspace",
  description: "One isolated database per workspace, one shared credit balance, and every account, session and policy change on an append-only audit trail.",
};

/* Sources: lib/shell/ia.ts (the tabs), components/graphite/WorkspaceView.tsx,
   app/(app)/settings/page.tsx, lib/settings.ts, lib/approvalRule.ts,
   app/api/team (INVITE_DAYS), lib/teamInvitations.ts, lib/plans.ts,
   lib/packs.ts, lib/billingLedger.ts, lib/statements.ts, lib/creditUsage.ts,
   app/api/workspaces/keys, lib/meter.ts, app/api/tokens, app/api/export,
   lib/purge.ts, docs/account-security.md, docs/workspace-security-policy.md,
   docs/subscribed-workspaces.md, docs/enterprise-readiness.md. */

export default async function WorkspacePage() {
  const { perCredit, plans, packs, rateCard } = await sitePrices();
  const enhancer = rateCard.find((row) => row.action === "Prompt enhancement")?.credits ?? null;
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
        title="One workspace. One balance. Every action attributed."
        lead="A production house gets its own isolated database and private storage. Members share one credit balance, every generation is quoted before it runs and settled at the rate it was charged, and every account and session change writes an audit receipt."
        pages={WORKSPACE_TABS.map((tab) => tab.label)}
        cta={(
          <>
            <a href={ACCESS_HREF} className="mk-btn gx-primary">Request access</a>
            <Link href="/" className="mk-btn mk-btn--secondary">Open Gen</Link>
          </>
        )}
      />

      {/* The suite header already draws the hairline above this section. */}
      <Section id="workspace-management" panel label="Workspace management" style={{ borderTop: 0 }}>
        <Grid col={180} style={{ gap: 10 }}>
          {FACTS.map(([k, v]) => <Fact key={k} k={k} v={v} />)}
        </Grid>

        <Grid col={300} style={{ gap: 20 }}>
          <Window path="particl.app / workspace / plans" src={shot("workspace-plans-credits")} alt="Workspace, Plans and credits: the balance, the plan, credit packs and monthly statements" width={924} height={540} />
          <Window path="particl.app / workspace / engines" src={shot("workspace-engines")} alt="Workspace, Engines: each engine connection and its state" width={924} height={540} />
        </Grid>

        <Grid col={270} style={{ alignItems: "start" }}>
          <Group tag="General" note="workspace-wide defaults" rows={[
            { name: "Workspace identity", chip: "owner", desc: "The name your team sees everywhere; only the owner renames it." },
            { name: "Production defaults", chip: "workspace-wide", desc: "Default video and still engine, take approvals, the per-shot credit cap, when to warn and what happens at a project’s cap." },
            { name: "Cost approval", chip: "per-shot cap", desc: "Anyone renders, or a shot over its credit cap needs an admin to press." },
            { name: "Prompt enhancer", chip: "workspace-wide", desc: `One provider for every suite, chosen here. ${cr(enhancer)} per enhancement; never applied to raw: prompts.` },
          ]} />
          <Group tag="People" note="no seat fees" rows={[
            { name: "Invite", chip: "7 days", desc: "One-time links an admin creates; they expire after seven days and are consumed in the same transaction as the seat." },
            { name: "Roles", chip: "owner · admin · member", desc: "Only the owner changes roles; admins invite, disable and unlock from the member row." },
            { name: "Access requests", chip: "reviewed", desc: "Requests from this site wait for the platform administrator; nothing is granted automatically." },
            { name: "Sign-in policy", chip: "optional by default", desc: "The owner can require an authenticator for everyone; until they enrol, members keep only account security, onboarding and workspace switching." },
          ]} />
          <Group tag="Plans & credits" note={`1 credit = US${usd(perCredit)}`} rows={[
            { name: "One balance", chip: "shared", desc: "Included, purchased and bonus credits in one ledger; included credits are drawn first." },
            { name: "Packs", chip: `${packs.length} packs`, desc: `${packs.map((pack) => `${pack.label} ${usd(pack.usd)}`).join(" · ")}, bonus credits capped at ${Math.round(BONUS_CAP * 100)}%. An owner or admin asks; credits land once payment is confirmed.` },
            { name: "Windows", chip: "no rollover", desc: "Included credits expire at cycle end; annual plans open monthly windows. Packs last 12 months of time off a plan." },
            { name: "Statements", chip: "monthly · CSV", desc: "Owners and admins read each month by production, shot and take, split into included, purchased and bonus credits." },
          ]} />
          <Group tag="Usage" note="settled only" rows={[
            { name: "By project · person · month", chip: "CSV", desc: "Credits used, completed generations, attempts and failures, with a CSV export." },
            { name: "Dashboard", chip: "by period", desc: "Spend by project, person and model, revisions per shot and where generations stall; filter and export." },
            { name: "Rate snapshot", chip: "immutable", desc: "Every generation keeps the rate it was charged at; changing a rate never rewrites history." },
            { name: "Failed renders", chip: "0 cr", desc: "Never billed, shown as such." },
          ]} />
          <Group tag="Engines" note="the owner’s keys" rows={[
            { name: "Connections", chip: "sealed", desc: "Each key is encrypted, shown only by its last four characters and never sent back." },
            { name: "Verify", chip: "free read", desc: "A connection check reads access and quotes only; nothing is trained, generated or spent." },
            { name: "Connected account", chip: "live quote", desc: "Quoted per call in its own credits and checked against the model’s declared settings before any paid call; every approval names the wallet it charges." },
            { name: "Bring your own key", chip: "BYOK", desc: "A key the workspace adds takes over for that vendor and is metered at zero credits." },
            { name: "Atomik allowlist", chip: "per engine", desc: "Choose which engines Atomik may propose; every paid step is still confirmed." },
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

        <Note lead="Not claimed yet:">SSO, SCIM, passkeys, online checkout and independently retained audit archives are open work. Uploads keep their original bytes and stay private; a deleted take is hidden, never erased, and can be restored.</Note>
      </Section>
    </SitePage>
  );
}
