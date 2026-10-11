import type { Metadata } from "next";
import Link from "next/link";
import SitePage, { sitePrices } from "@/components/marketing/SitePage";
import { Fact, Grid, Group, Section, SuiteHeader, Window } from "@/components/marketing/ui";
import { ACCESS_HREF, SITE_SUITES, shot } from "@/lib/marketing/site";

export const metadata: Metadata = {
  title: "Settings",
  description: "Settings: your team and its roles, plan and credits, spending rules, connections and export.",
};

/* Sources: lib/shell/settings.ts (the five sections) and components/graphite/settings (what each holds),
   app/api/team (INVITE_DAYS), lib/plans.ts (members), app/api/export (JSON and CSV), app/api/tokens. */

const settings = SITE_SUITES.find((s) => s.id === "settings")!;

export default async function SettingsPage() {
  const { plans } = await sitePrices();
  const paid = plans.filter((plan) => plan.priceUsd > 0);
  const members = paid.length > 0 && paid.every((plan) => plan.maxMembers == null) ? "Unlimited on paid plans" : "Set per plan";

  const FACTS: [string, string][] = [
    ["Members", members],
    ["Invites", "One-time links · 7 days"],
    ["Roles", "Owner · admin · member"],
    ["Sign-in", "Authenticator + recovery codes"],
    ["Export", "JSON and a takes CSV"],
  ];

  return (
    <SitePage active="settings">
      <SuiteHeader
        eyebrow="06 · Settings"
        title="Your team, plan and spending rules."
        lead="Who is on the team, what it can spend, and what it has used."
        pages={settings.pages}
        cta={(
          <>
            <a href={ACCESS_HREF} className="mk-btn gx-primary">Request access</a>
            <Link href="/" className="mk-btn mk-btn--secondary">Open Make</Link>
          </>
        )}
      />

      {/* The header already draws the hairline above this section. */}
      <Section id="settings-sections" panel label="Settings" style={{ borderTop: 0 }}>
        <Grid col={180} style={{ gap: 10 }}>
          {FACTS.map(([k, v]) => <Fact key={k} k={k} v={v} />)}
        </Grid>

        <Grid col={300} style={{ gap: 20 }}>
          <Window path="particl.si / settings / plan & credits" src={shot("settings-plan-credits")} alt="Settings, Plan & credits: the balance, this month, Top up and the plan" width={924} height={540} />
        </Grid>

        <Grid col={270} style={{ alignItems: "start" }}>
          <Group tag="Team" rows={[
            { name: "Invites", chip: "7 days", desc: "One-time links an owner or admin creates. Each expires after seven days." },
            { name: "Roles", chip: "owner · admin · member", desc: "Admins invite and manage members; members work on the board." },
            { name: "Two-step sign-in", chip: "optional", desc: "The owner can ask the whole team for an authenticator code at sign-in." },
          ]} />
          <Group tag="Plan & credits" rows={[
            { name: "Balance", chip: "credits", desc: "The balance, what this month used, and the plan." },
            { name: "Top up", chip: "request", desc: "An owner or admin asks for a pack; it is added once approved." },
            { name: "Usage and statements", chip: "CSV", desc: "Credit history, usage by engine, and a printable statement for each month." },
          ]} />
          <Group tag="Spending rules" rows={[
            { name: "Who may approve", chip: "by role", desc: "Members approve up to a cap per shot; an admin approves above it." },
            { name: "Budget", chip: "per production", desc: "A budget for each production, with a warning before it is reached." },
          ]} />
          <Group tag="Connections" rows={[
            { name: "Tokens", chip: "shown once", desc: "Connect Particl to Claude, ChatGPT or any MCP client. A token can be read-only, or allowed to make takes." },
          ]} />
          <Group tag="Advanced" rows={[
            { name: "Defaults", chip: "admin", desc: "The default video and still engines, and the prompt enhancer." },
            { name: "Export", chip: "owner", desc: "Everything the team has made, as JSON, and a CSV of its takes." },
          ]} />
        </Grid>

      </Section>
    </SitePage>
  );
}
