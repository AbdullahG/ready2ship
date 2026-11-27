import { requireWorkspacePage } from "@/lib/auth/guards";
import { listMembers, toPublicMember } from "@/lib/workspaces/members";
import MembersManager from "@/components/MembersManager";
import panels from "@/styles/panels.module.css";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { user, workspace, membership } = await requireWorkspacePage(workspaceId);
  const members = await listMembers(workspace);
  const canManage = membership.role === "owner";

  return (
    <div>
      <h1 className={panels.heading}>Members</h1>
      <p className={panels.sectionDesc}>
        Owners manage the AI key and members. Members can see pull requests and reviews.
        {!canManage && " Ask an owner to invite someone."}
      </p>
      <MembersManager
        workspaceId={workspaceId}
        canManage={canManage}
        currentLogin={user.githubUsername}
        initial={members.map(toPublicMember)}
      />
    </div>
  );
}
