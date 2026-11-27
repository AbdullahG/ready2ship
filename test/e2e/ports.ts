// 127.0.0.1 rather than localhost: localhost may resolve to ::1, where an
// unrelated local dev server can be listening on the same port.
export const E2E = {
  appPort: 3900,
  githubPort: 4910,
  geminiPort: 4920,
  controlPort: 4930,
  baseUrl: "http://127.0.0.1:3900",
  appSlug: "r2s-e2e",
  webhookSecret: "e2e-webhook-secret",
} as const;

export const GITHUB_CONTROL = `http://127.0.0.1:${E2E.githubPort}/__control`;
export const GEMINI_CONTROL = `http://127.0.0.1:${E2E.geminiPort}/__control`;
export const STACK_CONTROL = `http://127.0.0.1:${E2E.controlPort}`;
