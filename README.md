# 🚢 Ready2Ship

Open-source AI code review for GitHub pull requests. Install the GitHub App, add your own Gemini API key, and every PR gets a review: a summary, inline findings ranked **blocker / minor / improvement**, one-click fixes, and automatic approval once blockers are resolved.

- **Bring your own key.** Reviews run on Google Gemini with your workspace's key, so you pay Google directly for what you use. The key is stored encrypted and never shown again.
- **One notification per review.** All inline comments and the verdict are posted as a single GitHub review.
- **`fix it`.** Reply `fix it` to a finding and Ready2Ship commits the suggested change to the PR branch.
- **Ask questions.** Mention the app or ask a question on the PR and it answers with the diff in context.
- **Lookout or Dive.** Lookout reviews the diff; Dive also explores the repository and checks each finding against the code before posting. Pick per repository in `.ready2ship.yml`, or comment `@your-app dive` on any PR. A review that couldn't finish is retried with `@your-app retry`. See [docs/review-modes.md](docs/review-modes.md).
- **Team dashboard.** Owners invite teammates by GitHub username; everyone sees review status across repositories.

Ready2Ship is self-hosted: you create your own GitHub App and run your own instance, so your code only goes to GitHub and to Gemini under your own key.

## How it works

```
PR opened/updated ──webhook──▶ your Ready2Ship ──job queue──▶ worker ──diff──▶ Gemini (your key)
                                   │
                                   ├─▶ GitHub review: inline findings + approve / request changes
                                   └─▶ dashboard: PRs, findings, status per workspace
```

Webhooks are queued in MongoDB and processed by a worker inside the app, so reviews survive restarts and temporary failures are retried automatically.

Each GitHub App installation (an organization or personal account) is a **workspace**. Whoever installs it becomes its **owner**: owners manage the AI key and members; **members** can see pull requests and reviews.

Only people with write access to the repository (or the PR's author) can trigger `fix it` or questions, so outside commenters on public repos can't commit code or spend your AI credits.

## Deploy

**With Claude Code (easiest):** paste the prompt from [docs/deploy-with-claude.md](docs/deploy-with-claude.md) into Claude Code and it walks you through everything.

**By hand:** follow [docs/self-host.md](docs/self-host.md), step by step: create your GitHub App with one command, fill in `.env`, then run it on any VM with Docker (automatic HTTPS included) or on Google Cloud Run.

```bash
git clone https://github.com/AbdullahG/ready2ship && cd ready2ship
node scripts/create-github-app.mjs https://r2s.example.com   # prints the GITHUB_* variables
cp .env.example .env                                         # paste them, generate the secrets
DOMAIN=r2s.example.com docker compose --profile tls up -d --build
```

Every setting is a runtime environment variable, documented in [`.env.example`](.env.example):

| Variable | Purpose |
|---|---|
| `BASE_URL` | Public URL of your instance |
| `GITHUB_APP_*`, `GITHUB_CLIENT_*`, `GITHUB_WEBHOOK_SECRET` | Your GitHub App |
| `MONGODB_URI` | MongoDB connection string |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | Session signing; encryption of stored keys and tokens |
| `GEMINI_MODELS` | Required. Comma-separated Gemini models, tried in order |
| `GEMINI_API_KEY` | Optional shared key, so nobody has to add one in the dashboard |
| `ALLOWED_GITHUB_ACCOUNTS` | Optional allow-list of accounts that may install |
| `JOB_CONCURRENCY` | Webhook jobs processed in parallel (default 2, 0 = worker off) |
| `GITHUB_API_URL`, `GITHUB_WEB_URL` | GitHub Enterprise Server |

## What gets stored

Your instance's MongoDB holds GitHub user ids and usernames, review results (summaries, findings, PR titles and authors), and the Gemini key and GitHub tokens, encrypted with `ENCRYPTION_KEY`. Webhook payloads (PR titles and descriptions, not code) are kept in the job queue for 14 days. Diffs are sent to Gemini and are not stored. Uninstalling the GitHub App deletes that workspace's data.

## Development

```bash
npm ci
cp .env.example .env.local   # fill in a dev GitHub App (a smee.io proxy works for webhooks)
npm run dev
```

Tests run against local fakes of GitHub and Gemini, never the real services. See [docs/testing.md](docs/testing.md).

```bash
npm test            # unit + integration (in-memory MongoDB)
npm run test:e2e    # production build + API and browser tests (Playwright)
```

Stack: Next.js (App Router), TypeScript, MongoDB, Octokit, `@google/genai`.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
