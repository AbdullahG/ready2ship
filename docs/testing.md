# Testing

Last verified: 2026-11-21.

All suites run against **local fakes** of GitHub and Gemini (`test/fakes/`), wired through the same environment variables production uses (`GITHUB_API_URL`, `GITHUB_WEB_URL`, `GEMINI_BASE_URL`). Nothing calls the real services.

| Suite | Command | Where | Needs | Time |
|---|---|---|---|---|
| Unit | `npm run test:unit` | `test/unit/*.test.ts` | nothing | ~1 s |
| Integration | `npm run test:int` | `test/integration/*.int.test.ts` | downloads a MongoDB binary on first run (mongodb-memory-server); `git` with `git http-backend` on the PATH | ~25 s |
| Both | `npm test` | | | |
| API + browser E2E | `npm run test:e2e` | `test/e2e/*.spec.ts` | `npx playwright install chromium` once; ports 3900, 4910, 4920, 4930 free | ~1 min incl. build |

## How the pieces fit

- `test/integration/setup.ts` starts, per test file, an in-memory `mongod`, a fake GitHub and a fake Gemini on random ports, sets the env, and resets the database and fakes before each test. Builders live in `test/integration/builders.ts`.
- `test/e2e/stack.mts` (started by Playwright's `webServer`) boots in-memory MongoDB, the fakes on fixed ports, and the **standalone production server** (`.next/standalone/server.js`, the same as the Docker image). Its control server on :4930 resets state (`POST /reset`), expires user tokens (`POST /expire-tokens`) and reads collections (`GET /db/<name>`).
- **Fake GitHub** (`test/fakes/github.ts`): OAuth web flow under `/web`, REST under `/api`, control endpoints under `/__control`. Specs pick who signs in with `POST /__control/oauth-login`.
- **Fake Gemini** (`test/fakes/gemini.ts`): behavior is chosen by API key: `GEMINI_KEYS.valid`, `.invalid` (400 API_KEY_INVALID), `.quota` (429). Models listed in `failingModels` return 503; `outageCalls = n` makes the next n generate calls 503 (a transient outage); `latencyMs` delays answers; `scripted` queues responses: a string is a text answer, `{ functionCalls: [{ name, args }], thoughtSignature?, promptTokens? }` is a tool-calling turn (Dive). Serves `/v1` and `/v1beta`. Calls record the full request (`contents`, `system`, `tools`) and `startedAt`/`endedAt`.
- **Fake git** (`test/fakes/git-repo.ts`): `buildGitRepo({ base, pulls })` makes a real repository with `refs/pull/<n>/head` per PR. Register it with `github.gitRepos.set("owner/repo", repo.gitDir)` (E2E: `createGitRepo` in `helpers.ts`); the fake GitHub then serves it to `git fetch` through the real `git http-backend` (installation-token Basic auth required, headers recorded in `gitAuthHeaders`), and answers the trees and contents APIs from it. `github.gitDown = true` makes git requests fail; `github.repos` sets default branch and size.
- **Fake GitHub fault injection:** push `{ method, path: /regex/, remaining: n }` onto `github.failures` to make matching requests return 500.
- **Job queue:** integration tests drive it with an explicit clock (`processNextJob(now)`, `claimNext(now)`), never by waiting. The E2E server runs the real worker; specs wait for asynchronous processing with `expect.poll` (e.g. on `dbDocs("pull_requests")` or GitHub comments). The stack control server's `POST /jobs` inserts a job as-is, e.g. one left `running` by a crashed worker.

## Conventions

- Wait on conditions (`expect.poll`, locator assertions), never `sleep`.
- Webhooks in E2E are signed with the stack's secret (`sendWebhook` in `test/e2e/helpers.ts`) and processed asynchronously; poll the fake's recorded comments or the database.
