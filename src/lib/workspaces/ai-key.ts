import { createProvider } from "@/lib/ai";
import { config } from "@/lib/config";
import { encryptSecret } from "@/lib/crypto";
import { getWorkspacesCollection } from "@/lib/db/collections";
import type { AIKeyStatus, MembershipRole, Workspace } from "@/types";

const MAX_KEY_LENGTH = 200;

export type SaveKeyResult = { ok: true } | { ok: false; reason: string };

/** Validates the key against the provider before anything is stored. */
export async function saveWorkspaceKey(
  workspace: Workspace,
  rawKey: string,
  byLogin: string
): Promise<SaveKeyResult> {
  const key = rawKey.trim();
  if (!key) return { ok: false, reason: "Paste your Gemini API key." };
  if (key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
    return { ok: false, reason: "That doesn't look like an API key." };
  }

  const validation = await createProvider(key).validateKey();
  if (!validation.ok) return validation;

  const now = new Date();
  const workspaces = await getWorkspacesCollection();
  await workspaces.updateOne(
    { _id: workspace._id },
    {
      $set: {
        "ai.provider": "gemini",
        "ai.encryptedKey": encryptSecret(key),
        "ai.keyLast4": key.slice(-4),
        "ai.keyStatus": "valid",
        "ai.keyUpdatedAt": now,
        "ai.keyUpdatedBy": byLogin,
      },
    }
  );
  await workspaces.updateOne(
    { _id: workspace._id, onboardingCompletedAt: null },
    { $set: { onboardingCompletedAt: now } }
  );
  return { ok: true };
}

export async function removeWorkspaceKey(workspace: Workspace, byLogin: string): Promise<void> {
  await (await getWorkspacesCollection()).updateOne(
    { _id: workspace._id },
    {
      $set: {
        "ai.encryptedKey": null,
        "ai.keyLast4": null,
        "ai.keyStatus": "missing",
        "ai.keyUpdatedAt": new Date(),
        "ai.keyUpdatedBy": byLogin,
      },
    }
  );
}

export interface MemberAiState {
  provider: "gemini";
  keyStatus: AIKeyStatus;
  usingInstanceKey: boolean;
}

export interface OwnerAiState extends MemberAiState {
  keyLast4: string | null;
  keyUpdatedAt: Date | null;
}

/**
 * What the dashboard may know about the key. Never includes key material;
 * members only learn whether reviews can run, owners also see which key.
 */
export function publicAiState(workspace: Workspace, role: "owner"): OwnerAiState;
export function publicAiState(workspace: Workspace, role: MembershipRole): MemberAiState | OwnerAiState;
export function publicAiState(workspace: Workspace, role: MembershipRole): MemberAiState | OwnerAiState {
  const base: MemberAiState = {
    provider: workspace.ai.provider,
    keyStatus: workspace.ai.keyStatus,
    usingInstanceKey: !workspace.ai.encryptedKey && !!config().gemini.apiKey,
  };
  if (role !== "owner") return base;
  return { ...base, keyLast4: workspace.ai.keyLast4, keyUpdatedAt: workspace.ai.keyUpdatedAt };
}

/** After installing: onboarding only if no key (own or instance default) can run reviews. */
export function pathAfterInstall(workspace: Workspace): string {
  const { keyStatus, usingInstanceKey } = publicAiState(workspace, "member");
  const ready = keyStatus === "valid" || usingInstanceKey;
  return `/w/${workspace._id}${ready ? "" : "/onboarding"}`;
}
