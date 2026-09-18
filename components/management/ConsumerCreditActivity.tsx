"use client";

import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import type {
  ConsumerActivityState,
  ConsumerCreditActivity as Activity,
} from "@/lib/higgsfield-consumer/activity-types";
import {
  ManagementCard,
  ManagementNotice,
  ManagementStat,
} from "./ManagementPage";

const states: { id: ConsumerActivityState; label: string; note: string }[] = [
  { id: "completed", label: "Completed", note: "Output recorded" },
  { id: "pending", label: "Pending", note: "Dispatching or accepted" },
  {
    id: "uncertain",
    label: "Uncertain",
    note: "Submission needs reconciliation",
  },
  {
    id: "failed",
    label: "Failed",
    note: "Recorded failure; refund not inferred",
  },
];
const credits = (amount: number) =>
  `${amount.toLocaleString(undefined, { maximumFractionDigits: 20 })} Higgsfield credits`;

export default function ConsumerCreditActivity() {
  const session = useSession();
  const scope = session.requestScope;
  const { data, error, refresh } = useApi<Activity>(
    scope ? "/api/higgsfield/consumer/activity" : null,
    0,
    scope,
  );
  return (
    <section aria-label="My Higgsfield activity">
      <ManagementCard
        title="My Higgsfield activity"
        description="Approved quote commitments for your own account in this workspace."
      >
        <p className="management-muted">
          These are the saved quotes you approved for submitted work, not a
          provider invoice or live balance. Failed and uncertain jobs may
          require reconciliation in Higgsfield. Unused quotes are excluded.
          Higgsfield credits are separate from Particl credits and USD.
        </p>
        <button
          className="management-button small"
          style={{ marginTop: 12, whiteSpace: "nowrap" }}
          disabled={!scope}
          onClick={() => void refresh()}
        >
          Refresh activity
        </button>
      </ManagementCard>
      {!scope ? (
        <ManagementNotice>
          Reload this page in your signed-in workspace to read your account
          activity.
        </ManagementNotice>
      ) : error ? (
        <ManagementNotice error>
          {error}{" "}
          <button
            className="management-button small"
            onClick={() => void refresh()}
          >
            Retry activity
          </button>
        </ManagementNotice>
      ) : !data ? (
        <ManagementNotice>
          Reading your Higgsfield credit activity…
        </ManagementNotice>
      ) : (
        <>
          <div className="management-grid four" style={{ marginTop: 16 }}>
            {states.map((state) => (
              <ManagementStat
                key={state.id}
                label={state.label}
                value={credits(data.totals[state.id].quoteCredits)}
                note={`${data.totals[state.id].jobs.toLocaleString()} jobs · ${state.note}`}
              />
            ))}
          </div>
          <ManagementCard
            title="Approved quotes by project"
            description="Only your submitted jobs appear here. Project totals remain after a draft is deleted."
          >
            {data.projects.length ? (
              data.projects.map((project) => (
                <div
                  key={project.draftId}
                  style={{
                    padding: "16px 0",
                    borderTop: "1px solid var(--line)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {project.available ? (
                    <Link
                      className="management-link"
                      href={`/workbench?project=${encodeURIComponent(project.draftId)}&suite=moleculr&page=variants`}
                    >
                      {project.name || "Untitled project"}
                    </Link>
                  ) : (
                    <strong>Deleted or unavailable project</strong>
                  )}
                  {!project.available && (
                    <p className="management-muted">{project.draftId}</p>
                  )}
                  <div
                    className="management-grid four"
                    style={{ marginTop: 12 }}
                  >
                    {states.map((state) => (
                      <div key={state.id}>
                        <span className="management-muted">{state.label}</span>
                        <p className="management-amount">
                          {credits(project.totals[state.id].quoteCredits)}
                        </p>
                        <small className="management-muted">
                          {project.totals[state.id].jobs.toLocaleString()} jobs
                        </small>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <p className="management-muted">
                No submitted Higgsfield jobs for your account in this workspace
                yet.
              </p>
            )}
            {data.projectsTruncated && (
              <p className="management-muted">
                Showing the {data.projectLimit} most recently active projects.
                The totals above include all projects.
              </p>
            )}
          </ManagementCard>
        </>
      )}
    </section>
  );
}
