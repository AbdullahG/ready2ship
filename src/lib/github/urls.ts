import { config } from "@/lib/config";

export function appInstallUrl(): string {
  const { github } = config();
  return `${github.webUrl}/apps/${github.appSlug}/installations/new`;
}
