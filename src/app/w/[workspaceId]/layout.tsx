import Link from "next/link";
import { requireWorkspacePage } from "@/lib/auth/guards";
import { listMyWorkspaces } from "@/lib/auth/workspace";
import WorkspaceSwitcher from "@/components/WorkspaceSwitcher";
import KeyBanner from "@/components/KeyBanner";
import { publicAiState } from "@/lib/workspaces/ai-key";
import styles from "./layout.module.css";
import { config } from "@/lib/config";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { user, workspace, membership } = await requireWorkspacePage(workspaceId);
  const mine = await listMyWorkspaces(user.githubId);
  const base = `/w/${workspaceId}`;
  const isOwner = membership.role === "owner";
  const { keyStatus, usingInstanceKey } = publicAiState(workspace, membership.role);

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link href="/" className={styles.logo}>
          <span className={styles.logoIcon}>🚢</span>
          <span className={styles.logoText}>Ready2Ship</span>
        </Link>

        {mine.length > 1 ? (
          <div className={styles.switcher}>
            <WorkspaceSwitcher
              current={workspaceId}
              workspaces={mine.map((m) => ({
                id: m.workspace._id.toString(),
                name: m.workspace.githubAccountLogin,
              }))}
            />
          </div>
        ) : (
          <div className={styles.workspaceName} data-testid="workspace-name">
            {workspace.githubAccountLogin}
          </div>
        )}

        <nav className={styles.nav}>
          <Link href={base} className={styles.navLink}>
            <span className={styles.navIcon}>📊</span>
            Overview
          </Link>
          <Link href={`${base}/pulls`} className={styles.navLink}>
            <span className={styles.navIcon}>🔀</span>
            Pull Requests
          </Link>
          <Link href={`${base}/settings/members`} className={styles.navLink}>
            <span className={styles.navIcon}>👥</span>
            Members
          </Link>
          <Link href={`${base}/settings`} className={styles.navLink}>
            <span className={styles.navIcon}>⚙️</span>
            Settings
          </Link>
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.userInfo}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={user.avatarUrl} alt="" className={styles.avatar} />
            <span className={styles.username}>{user.githubUsername}</span>
            <a href={config().sourceCodeUrl} className={styles.logoutBtn} title="Source code" aria-label="Source code">
              ⟨⟩
            </a>
            <form action="/api/auth/logout" method="POST">
              <button type="submit" className={styles.logoutBtn} title="Sign out" aria-label="Sign out">
                ↩
              </button>
            </form>
          </div>
        </div>
      </aside>

      <main className={styles.main}>
        {isOwner && !usingInstanceKey && <KeyBanner workspaceId={workspaceId} keyStatus={keyStatus} />}
        {children}
      </main>
    </div>
  );
}
