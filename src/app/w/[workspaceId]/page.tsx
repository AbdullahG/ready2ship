import Link from "next/link";
import { getPullsCollection } from "@/lib/db/collections";
import { requireWorkspacePage } from "@/lib/auth/guards";
import { timeAgo } from "@/lib/ui/format";
import type { PRStatus } from "@/types";
import styles from "./page.module.css";

const statusIcon: Record<PRStatus, string> = {
  pending: "⏳",
  needs_setup: "⚙️",
  reviewing: "👁️",
  reviewed: "🔍",
  approved: "✅",
  closed: "🔒",
  cancelled: "🛑",
};

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { workspace } = await requireWorkspacePage(workspaceId);
  const scope = { workspaceId: workspace._id };
  const pulls = await getPullsCollection();

  const [openCount, approvedCount, blockerCount, recent] = await Promise.all([
    pulls.countDocuments({ ...scope, status: { $in: ["reviewing", "reviewed", "pending", "needs_setup"] } }),
    pulls.countDocuments({ ...scope, status: "approved" }),
    pulls.countDocuments({
      ...scope,
      status: { $in: ["reviewing", "reviewed"] },
      "reviewStats.blockers": { $gt: 0 },
    }),
    pulls.find(scope).sort({ updatedAt: -1 }).limit(10).toArray(),
  ]);

  return (
    <div>
      <h1 className={styles.heading}>Overview</h1>
      <p className={styles.subheading}>
        Review status for {workspace.githubAccountLogin}
      </p>

      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Open PRs</div>
          <div className={styles.statValue}>{openCount}</div>
          <div className={styles.statSub}>in review</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Approved</div>
          <div className={styles.statValue}>{approvedCount}</div>
          <div className={styles.statSub}>ready to merge</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>With blockers</div>
          <div className={styles.statValue}>{blockerCount}</div>
          <div className={styles.statSub}>waiting for a fix</div>
        </div>
      </div>

      <div className={styles.sectionTitle}>Recent pull requests</div>
      <div className={styles.recentList}>
        {recent.length === 0 ? (
          <div className={styles.empty}>
            No pull requests yet. Open one in a repository the app can access and the review starts automatically.
          </div>
        ) : (
          recent.map((pr) => (
            <Link
              key={pr._id.toString()}
              href={`/w/${workspaceId}/pulls/${pr._id}`}
              className={styles.prRow}
            >
              <span className={styles.prStatus}>{statusIcon[pr.status] ?? "•"}</span>
              <div className={styles.prInfo}>
                <div className={styles.prTitle}>{pr.title}</div>
                <div className={styles.prMeta}>
                  {pr.repoFullName} · #{pr.githubPrNumber} · {pr.author} · {timeAgo(pr.updatedAt)}
                </div>
              </div>
              <div className={styles.prStats}>
                {pr.reviewStats.blockers > 0 && (
                  <span className={`${styles.badge} ${styles.badgeBlocker}`}>
                    {pr.reviewStats.blockers} blocker
                  </span>
                )}
                {pr.reviewStats.minors > 0 && (
                  <span className={`${styles.badge} ${styles.badgeMinor}`}>
                    {pr.reviewStats.minors} minor
                  </span>
                )}
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
