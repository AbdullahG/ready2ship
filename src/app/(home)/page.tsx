import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { listMyWorkspaces } from "@/lib/auth/workspace";
import { activatePendingInvites } from "@/lib/workspaces/members";
import { appInstallUrl } from "@/lib/github/urls";
import panels from "@/styles/panels.module.css";

export default async function HomePage() {
  const user = await getSession();
  if (!user) redirect("/login");

  // Picks up invites sent while this user was already signed in.
  await activatePendingInvites(user.githubId);
  const workspaces = await listMyWorkspaces(user.githubId);
  if (workspaces.length === 1) redirect(`/w/${workspaces[0].workspace._id}`);

  return (
    <div className={panels.centered}>
      <h1 className={panels.heading}>🚢 Ready2Ship</h1>

      {workspaces.length > 0 && (
        <div className={panels.section}>
          <div className={panels.sectionTitle}>Your workspaces</div>
          <div className={panels.orgList} data-testid="workspace-list">
            {workspaces.map(({ workspace, role }) => (
              <Link key={workspace._id.toString()} href={`/w/${workspace._id}`} className={panels.orgRow}>
                <span className={panels.orgIcon}>{workspace.githubAccountType === "User" ? "👤" : "🏢"}</span>
                <span className={panels.orgName}>{workspace.githubAccountLogin}</span>
                <span className={panels.roleBadge}>{role}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className={panels.section} data-testid="empty-state">
        <div className={panels.sectionTitle}>
          {workspaces.length === 0 ? "Get started" : "Add another account"}
        </div>
        <div className={panels.sectionDesc}>
          Install the GitHub App on your organization or personal account. Ready2Ship then reviews every
          pull request with your own Gemini API key.
        </div>
        <a href={appInstallUrl()} className={panels.installBtn}>
          ⚡ Install the GitHub App
        </a>
        {workspaces.length === 0 && (
          <p className={panels.hint} style={{ marginTop: 16 }}>
            Joining a team that already uses Ready2Ship? Ask a workspace owner to invite{" "}
            <strong>@{user.githubUsername}</strong>.
          </p>
        )}
      </div>

      <form action="/api/auth/logout" method="POST">
        <button type="submit" className={panels.secondaryBtn}>
          Sign out
        </button>
      </form>
    </div>
  );
}
