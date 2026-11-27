import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspacePage } from "@/lib/auth/guards";
import OnboardingAiStep from "@/components/OnboardingAiStep";
import panels from "@/styles/panels.module.css";
import { publicAiState } from "@/lib/workspaces/ai-key";

export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { workspace, membership } = await requireWorkspacePage(workspaceId);
  if (membership.role !== "owner") redirect(`/w/${workspaceId}`);

  return (
    <div>
      <h1 className={panels.heading}>Set up {workspace.githubAccountLogin}</h1>

      <div className={panels.steps}>
        <div className={panels.step}>
          <div className={`${panels.stepNum} ${panels.stepDone}`}>✓</div>
          <div className={panels.stepText}>
            <strong>GitHub App installed</strong> on {workspace.githubAccountLogin}.
          </div>
        </div>
        <div className={panels.step}>
          <div className={panels.stepNum}>2</div>
          <div className={panels.stepText} style={{ flex: 1 }}>
            <strong>Connect AI.</strong> Add a Gemini API key; reviews use it, so you only pay Google for what you use.
            <div style={{ marginTop: 12 }}>
              <OnboardingAiStep
                workspaceId={workspaceId}
                alreadyDone={workspace.ai.keyStatus === "valid" || publicAiState(workspace, "owner").usingInstanceKey}
              />
            </div>
          </div>
        </div>
      </div>

      <p className={panels.hint} style={{ marginTop: 24 }}>
        Want teammates to see reviews here? <Link href={`/w/${workspaceId}/settings/members`}>Invite them</Link>.
      </p>
    </div>
  );
}
