import Link from "next/link";
import { getPullsCollection } from "@/lib/db/collections";
import { requireWorkspacePage } from "@/lib/auth/guards";
import { PR_STATUS_LABELS, timeAgo } from "@/lib/ui/format";
import type { PRStatus } from "@/types";
import styles from "./page.module.css";

const DOT_CLASS: Record<PRStatus, string> = {
  pending: styles.dotPending,
  needs_setup: styles.dotReviewed,
  reviewing: styles.dotReviewing,
  reviewed: styles.dotReviewed,
  approved: styles.dotApproved,
  closed: styles.dotClosed,
  cancelled: styles.dotClosed,
};

const FILTER_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "All", value: "" },
  { label: "Reviewed", value: "reviewed" },
  { label: "Needs AI key", value: "needs_setup" },
  { label: "Approved", value: "approved" },
  { label: "Closed", value: "closed" },
  { label: "Cancelled", value: "cancelled" },
];

const VALID_STATUSES = new Set(Object.keys(PR_STATUS_LABELS));

export default async function PullsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { workspaceId } = await params;
  const { workspace } = await requireWorkspacePage(workspaceId);
  const { status } = await searchParams;
  const pulls = await getPullsCollection();
  const base = `/w/${workspaceId}`;

  const query: Record<string, unknown> = { workspaceId: workspace._id };
  if (status && VALID_STATUSES.has(status)) query.status = status;

  const items = await pulls
    .find(query)
    .sort({ updatedAt: -1 })
    .limit(50)
    .toArray();

  return (
    <div>
      <h1 className={styles.heading}>Pull Requests</h1>

      <div className={styles.filters}>
        {FILTER_OPTIONS.map((opt) => (
          <Link
            key={opt.value}
            href={opt.value ? `${base}/pulls?status=${opt.value}` : `${base}/pulls`}
            className={`${styles.filterBtn} ${status === opt.value || (!status && !opt.value) ? styles.filterBtnActive : ""}`}
          >
            {opt.label}
          </Link>
        ))}
      </div>

      {items.length === 0 ? (
        <div className={styles.empty}>
          No pull requests match this filter.
        </div>
      ) : (
        <table className={styles.table} data-testid="pulls-table">
          <thead>
            <tr>
              <th>PR</th>
              <th>Repo</th>
              <th>Status</th>
              <th>Findings</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((pr) => (
              <tr key={pr._id.toString()}>
                <td>
                  <Link
                    href={`${base}/pulls/${pr._id}`}
                    className={styles.prLink}
                  >
                    {pr.title}
                  </Link>
                  <div className={styles.prMeta}>
                    #{pr.githubPrNumber} · {pr.author}
                  </div>
                </td>
                <td>
                  <span style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
                    {pr.repoFullName}
                  </span>
                </td>
                <td>
                  <div className={styles.statusCell}>
                    <span
                      className={`${styles.statusDot} ${DOT_CLASS[pr.status]}`}
                    />
                    {PR_STATUS_LABELS[pr.status]}
                  </div>
                </td>
                <td>
                  {pr.reviewStats.blockers > 0 && (
                    <span className={`${styles.badge} ${styles.badgeBlocker}`}>
                      {pr.reviewStats.blockers}B
                    </span>
                  )}
                  {pr.reviewStats.minors > 0 && (
                    <span className={`${styles.badge} ${styles.badgeMinor}`}>
                      {pr.reviewStats.minors}M
                    </span>
                  )}
                  {pr.reviewStats.blockers === 0 &&
                    pr.reviewStats.minors === 0 && (
                      <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>
                        —
                      </span>
                    )}
                </td>
                <td style={{ color: "var(--text-muted)", fontSize: "12px" }}>
                  {timeAgo(pr.updatedAt)}
                </td>
                <td>
                  <a
                    href={pr.githubPrUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.externalLink}
                  >
                    GitHub ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
