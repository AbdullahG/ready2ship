import { createHmac, timingSafeEqual } from "crypto";
import { config } from "@/lib/config";

export function verifyWebhookSignature(
  payload: string,
  signature: string | null
): boolean {
  if (!signature) return false;

  const sig = Buffer.from(signature, "utf-8");
  const hmac = createHmac("sha256", config().github.webhookSecret);
  hmac.update(payload);
  const digest = Buffer.from(`sha256=${hmac.digest("hex")}`, "utf-8");

  if (sig.length !== digest.length) return false;
  return timingSafeEqual(sig, digest);
}

export function parseRepoFromFullName(fullName: string): {
  owner: string;
  repo: string;
} {
  const [owner, repo] = fullName.split("/");
  return { owner, repo };
}

// "fix it", optionally addressed to the app: "@<slug> fix it".
export function isFixItCommand(body: string, appSlug: string): boolean {
  const slug = appSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(@${slug}\\s+)?fix\\s+it\\s*$`, "i").test(body.trim());
}

// "dive", "deep" or "deep review", optionally addressed to the app; the whole comment.
export function isDiveCommand(body: string, appSlug: string): boolean {
  const slug = appSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(@${slug}\\s+)?(dive|deep|deep\\s+review)\\s*$`, "i").test(body.trim());
}

// "retry" or "retry review", optionally addressed to the app; the whole comment.
export function isRetryCommand(body: string, appSlug: string): boolean {
  const slug = appSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(@${slug}\\s+)?retry(\\s+review)?\\s*$`, "i").test(body.trim());
}

export function looksLikeQuestion(body: string, appLogin: string): boolean {
  const mentionsApp = body.toLowerCase().includes(`@${appLogin.toLowerCase()}`);
  const hasQuestionMark = body.includes("?");
  return mentionsApp || hasQuestionMark;
}

// On public repos anyone can comment. Only people with write access to the
// repository may make the bot commit code or spend the workspace's AI credits.
// The PR's author is deliberately not trusted on its own: on a fork PR they
// have no write access to this repository.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function canCommandBot(authorAssociation: string | undefined): boolean {
  return !!authorAssociation && TRUSTED_ASSOCIATIONS.has(authorAssociation);
}
