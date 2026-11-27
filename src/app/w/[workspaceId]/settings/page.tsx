import { requireWorkspacePage } from "@/lib/auth/guards";
import { config } from "@/lib/config";
import { publicAiState } from "@/lib/workspaces/ai-key";
import AiKeyForm from "@/components/AiKeyForm";
import panels from "@/styles/panels.module.css";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { workspace, membership } = await requireWorkspacePage(workspaceId);
  const isOwner = membership.role === "owner";
  const ai = publicAiState(workspace, membership.role);
  const owner = isOwner ? publicAiState(workspace, "owner") : null;
  const { webUrl } = config().github;
  const manageUrl =
    workspace.githubAccountType === "Organization"
      ? `${webUrl}/organizations/${workspace.githubAccountLogin}/settings/installations/${workspace.githubInstallationId}`
      : `${webUrl}/settings/installations/${workspace.githubInstallationId}`;

  return (
    <div>
      <h1 className={panels.heading}>Settings</h1>

      <section className={panels.section} aria-labelledby="ai-heading">
        <h2 id="ai-heading" className={panels.sectionTitle}>AI provider</h2>
        <p className={panels.sectionDesc}>
          Reviews run on Google Gemini with this workspace&apos;s own API key, so AI usage is billed to you directly.
        </p>
        {isOwner ? (
          <AiKeyForm workspaceId={workspaceId} initial={{ keyStatus: ai.keyStatus, keyLast4: owner?.keyLast4 ?? null }} />
        ) : (
          <div className={panels.card} data-testid="ai-key-readonly">
            {ai.keyStatus === "valid" && <>A Gemini key is active.</>}
            {ai.keyStatus === "invalid" && <>The Gemini key was rejected. Ask a workspace owner to replace it.</>}
            {ai.keyStatus === "missing" && !ai.usingInstanceKey && <>No AI key yet. Ask a workspace owner to add one.</>}
            {ai.keyStatus === "missing" && ai.usingInstanceKey && <>Using this instance&apos;s default key.</>}
            <p className={panels.hint}>Only workspace owners can change the key.</p>
          </div>
        )}
        {isOwner && ai.usingInstanceKey && (
          <p className={panels.hint}>No workspace key set: this instance&apos;s default key is used.</p>
        )}
      </section>

      <section className={panels.section} aria-labelledby="modes-heading">
        <h2 id="modes-heading" className={panels.sectionTitle}>Review modes</h2>
        <p className={panels.sectionDesc}>
          🔭 <strong>Lookout</strong> reviews the diff in one call. 🤿 <strong>Dive</strong> also explores the repository
          (reads files, searches the code) and checks each finding before posting it; it costs more tokens. Each repository
          picks its mode in a <code>.ready2ship.yml</code> on its default branch; without one it gets Lookout. Anyone with
          write access can comment <code>@{config().github.appSlug} dive</code> on a PR for a one-off Dive.
        </p>
        <pre className={panels.card} data-testid="review-modes-example">{`# .ready2ship.yml
review:
  mode: dive              # lookout | dive
  exclude: ["**/generated/**"]
dive:
  maxInputTokens: 2000000`}</pre>
        <p className={panels.hint}>
          All options: <a href={`${config().sourceCodeUrl}/blob/main/docs/review-modes.md`}>docs/review-modes.md</a>
        </p>
      </section>

      <section className={panels.section} aria-labelledby="gh-heading">
        <h2 id="gh-heading" className={panels.sectionTitle}>GitHub installation</h2>
        <div className={panels.orgRow}>
          <span className={panels.orgIcon}>{workspace.githubAccountType === "User" ? "👤" : "🏢"}</span>
          <div>
            <div className={panels.orgName}>{workspace.githubAccountLogin}</div>
            <div className={panels.orgMeta}>Installation #{workspace.githubInstallationId}</div>
          </div>
          <span className={panels.connectedBadge}>
            {workspace.status === "active" ? "● Connected" : "Suspended"}
          </span>
        </div>
        <p className={panels.hint} style={{ marginTop: 8 }}>
          Choose which repositories Ready2Ship can see, or uninstall it,{" "}
          <a href={manageUrl} target="_blank" rel="noopener noreferrer">on GitHub</a>. Uninstalling deletes this
          workspace&apos;s key and review history from Ready2Ship.
        </p>
      </section>
    </div>
  );
}
