import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import { config } from "@/lib/config";

let githubApp: App | null = null;

/** fetch with a deadline, so a hung GitHub call can't block a job forever. */
function timedFetch(timeoutMs: number): typeof fetch {
  return (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
}

export function getGithubApp(): App {
  if (!githubApp) {
    const { github } = config();
    githubApp = new App({
      appId: github.appId,
      privateKey: github.privateKey,
      webhooks: { secret: github.webhookSecret },
      oauth: {
        clientId: github.clientId,
        clientSecret: github.clientSecret,
      },
      Octokit: Octokit.defaults({ baseUrl: github.apiUrl, request: { fetch: timedFetch(github.timeoutMs) } }),
    });
  }
  return githubApp;
}

/** A short-lived installation access token (also used for git over HTTPS). */
export async function getInstallationToken(installationId: number): Promise<string> {
  const installationOctokit = await getGithubApp().getInstallationOctokit(installationId);
  const auth = (await installationOctokit.auth({ type: "installation" })) as { token: string };
  return auth.token;
}

export async function getInstallationOctokit(
  installationId: number
): Promise<Octokit> {
  const token = await getInstallationToken(installationId);
  const { github } = config();
  return new Octokit({ auth: token, baseUrl: github.apiUrl, request: { fetch: timedFetch(github.timeoutMs) } });
}
