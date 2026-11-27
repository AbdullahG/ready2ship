import {
  deleteWorkspaceByInstallation,
  setWorkspaceStatus,
  upsertWorkspaceFromInstallation,
} from "@/lib/workspaces/installations";

export async function handleInstallation(payload: {
  action: string;
  installation: { id: number; account: { id: number; login: string; type: string } };
  sender: { id: number; login: string };
}): Promise<void> {
  const installationId = payload.installation.id;
  switch (payload.action) {
    case "created":
      await upsertWorkspaceFromInstallation({
        installationId,
        account: payload.installation.account,
        owner: payload.sender,
      });
      break;
    case "deleted":
      await deleteWorkspaceByInstallation(installationId);
      break;
    case "suspend":
      await setWorkspaceStatus(installationId, "suspended");
      break;
    case "unsuspend":
      await setWorkspaceStatus(installationId, "active");
      break;
    default:
      break;
  }
}
