import { config } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import { MissingKeyError } from "./errors";
import { GeminiProvider } from "./providers/gemini";
import type { AIProvider } from "./providers/types";
import type { Workspace } from "@/types";

export function createProvider(apiKey: string, models?: string[]): AIProvider {
  const { gemini } = config();
  return new GeminiProvider({ apiKey, models: models?.length ? models : gemini.models, baseUrl: gemini.baseUrl, timeoutMs: gemini.timeoutMs });
}

/**
 * The workspace's own key, else the self-host instance key, else MissingKeyError.
 * `models` (Dive's from .ready2ship.yml) replaces GEMINI_MODELS when non-empty.
 */
export function getProviderForWorkspace(workspace: Workspace, opts: { models?: string[] } = {}): AIProvider {
  const key = workspace.ai.encryptedKey
    ? decryptSecret(workspace.ai.encryptedKey)
    : config().gemini.apiKey;
  if (!key) throw new MissingKeyError();
  return createProvider(key, opts.models);
}

export type { AIProvider } from "./providers/types";
