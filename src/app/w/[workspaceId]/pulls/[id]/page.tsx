import { notFound } from "next/navigation";
import Link from "next/link";
import { ObjectId } from "mongodb";
import {
  getPullsCollection,
  getFindingsCollection,
} from "@/lib/db/collections";
import { requireWorkspacePage } from "@/lib/auth/guards";
import { PR_STATUS_LABELS } from "@/lib/ui/format";
import type { PRStatus, FindingSeverity } from "@/types";
import styles from "./page.module.css";

const STATUS_CLASS: Record<PRStatus, string> = {
  pending: styles.statusPending,
  needs_setup: styles.statusPending,
  reviewing: styles.statusReviewing,
  reviewed: styles.statusReviewed,
  approved: styles.statusApproved,
  closed: styles.statusClosed,
  cancelled: styles.statusClosed,
};

const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  blocker: "Blocker",
  minor: "Minor",
  improvement: "Improvement",
};

const SEVERITY_TAG: Record<FindingSeverity, string> = {
  blocker: styles.tagBlocker,
  minor: styles.tagMinor,
  improvement: styles.tagImprovement,
};

const SEVERITY_ORDER: FindingSeverity[] = ["blocker", "minor", "improvement"];

export default async function PRDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; id: string }>;
}) {
  const { workspaceId, id } = await params;
  const { workspace } = await requireWorkspacePage(workspaceId);
  if (!ObjectId.isValid(id)) notFound();
  const objectId = new ObjectId(id);

  const [pullsCol, findingsCol] = await Promise.all([
    getPullsCollection(),
    getFindingsCollection(),
  ]);

  const [pr, findings] = await Promise.all([
    pullsCol.findOne({ _id: objectId, workspaceId: workspace._id }),
    findingsCol
      .find({ prId: objectId, workspaceId: workspace._id })
      .sort({ createdAt: 1 })
      .toArray(),
  ]);

  if (!pr) notFound();
  const review = pr.lastReview;

  const grouped = SEVERITY_ORDER.map((sev) => ({
    severity: sev,
    items: findings.filter((f) => f.severity === sev),
  })).filter((g) => g.items.length > 0);

  return (
    <div>
      <Link href={`/w/${workspaceId}/pulls`} className={styles.back}>
        ← Pull Requests
      </Link>

      <div className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{pr.title}</h1>
          <span className={`${styles.statusBadge} ${STATUS_CLASS[pr.status]}`}>
            {PR_STATUS_LABELS[pr.status]}
          </span>
        </div>
        <div className={styles.meta}>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>Repo:</span>
            {pr.repoFullName}
          </span>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>PR:</span>
            #{pr.githubPrNumber}
          </span>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>Author:</span>
            {pr.author}
          </span>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>Branch:</span>
            {pr.headBranch} → {pr.baseBranch}
          </span>
          {review && (
            <span className={styles.metaItem} data-testid="review-mode">
              <span className={styles.metaLabel}>Review:</span>
              {review.mode === "dive" ? "🤿 Dive" : "🔭 Lookout"}
            </span>
          )}
          <span className={styles.metaItem}>
            <a
              href={pr.githubPrUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.githubLink}
            >
              Open on GitHub ↗
            </a>
          </span>
        </div>
      </div>

      <div className={styles.grid}>
        <div>
          {review?.cancelledReason && pr.status === "cancelled" && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Review cancelled</div>
              <div className={styles.summaryBox} data-testid="cancel-reason">{review.cancelledReason}</div>
            </div>
          )}

          {pr.summary && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>AI summary</div>
              <div className={styles.summaryBox}>{pr.summary}</div>
            </div>
          )}

          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              Findings ({findings.length})
            </div>
            {findings.length === 0 ? (
              <div className={styles.empty}>
                No findings on this PR.
              </div>
            ) : (
              <div className={styles.findingsList}>
                {grouped.map(({ severity, items }) =>
                  items.map((finding) => (
                    <div key={finding._id.toString()} className={styles.finding}>
                      <div className={styles.findingHeader}>
                        <span
                          className={`${styles.severityTag} ${SEVERITY_TAG[severity]}`}
                        >
                          {SEVERITY_LABELS[severity]}
                        </span>
                        <span className={styles.findingFile}>
                          {finding.file}
                        </span>
                        <span className={styles.findingLine}>
                          L{finding.startLine}
                          {finding.endLine !== finding.startLine
                            ? `–${finding.endLine}`
                            : ""}
                        </span>
                        {finding.status !== "open" && (
                          <span className={styles.findingResolved}>
                            {finding.status === "fixed" ? "✅ Fixed" : "✅ Resolved"}
                          </span>
                        )}
                      </div>
                      <div className={styles.findingBody}>
                        <div className={styles.findingDesc}>
                          {finding.description}
                        </div>
                        <div className={styles.findingSuggestion}>
                          {finding.suggestion}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        <aside>
          <div className={styles.statsCard}>
            <div className={styles.statsTitle}>Review summary</div>
            <div className={styles.statRow}>
              <span className={styles.statLabel}>🔴 Blocker</span>
              <span className={`${styles.statNum} ${styles.statBlocker}`}>
                {pr.reviewStats.blockers}
              </span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statLabel}>🟡 Minor</span>
              <span className={`${styles.statNum} ${styles.statMinor}`}>
                {pr.reviewStats.minors}
              </span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statLabel}>💡 Improvement</span>
              <span className={`${styles.statNum} ${styles.statImprovement}`}>
                {pr.reviewStats.improvements}
              </span>
            </div>
            {pr.reviewStats.resolvedBlockers > 0 && (
              <div className={styles.statRow}>
                <span className={styles.statLabel}>✅ Resolved</span>
                <span className={`${styles.statNum} ${styles.statGreen}`}>
                  {pr.reviewStats.resolvedBlockers}
                </span>
              </div>
            )}
            {review?.usage && (
              <>
                {review.mode === "dive" && (
                  <>
                    <div className={styles.statRow}>
                      <span className={styles.statLabel}>Tool calls</span>
                      <span className={styles.statNum} data-testid="usage-tool-calls">{review.usage.toolCalls ?? 0}</span>
                    </div>
                    <div className={styles.statRow}>
                      <span className={styles.statLabel}>Files read</span>
                      <span className={styles.statNum} data-testid="usage-files-read">{review.usage.filesRead ?? 0}</span>
                    </div>
                  </>
                )}
                <div className={styles.statRow}>
                  <span className={styles.statLabel}>Input tokens</span>
                  <span className={styles.statNum} data-testid="usage-input-tokens">
                    {review.usage.inputTokens.toLocaleString("en-US")}
                  </span>
                </div>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
