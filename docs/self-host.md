# Deploy your own Ready2Ship

Ready2Ship is self-hosted: you create your own GitHub App and run your own instance. It takes about 20 minutes. Prefer to have Claude Code do it for you? See [deploy-with-claude.md](deploy-with-claude.md).

**You'll need**

- A GitHub account, and admin rights on the organization if you're installing it there.
- A Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (free tier works to try it).
- Somewhere to run it, reachable from the internet so GitHub can send webhooks:
  - **Option A:** any Linux VM with Docker and a domain name pointing at it (Hetzner, DigitalOcean, EC2…), or
  - **Option B:** Google Cloud Run plus MongoDB Atlas (free tiers available).
- Node.js 22+ on your own machine (only to create the GitHub App).

Below, `https://r2s.example.com` stands for your instance's URL.

---

## Step 1: Get the code

```bash
git clone https://github.com/AbdullahG/ready2ship
cd ready2ship
```

## Step 2: Create your GitHub App

```bash
node scripts/create-github-app.mjs https://r2s.example.com              # owned by your personal account
node scripts/create-github-app.mjs https://r2s.example.com --org acme   # owned by an organization
```

Open http://localhost:3999 when prompted, confirm on GitHub, and the script prints six `GITHUB_*` lines. Keep them for the next step; the private key and secrets are shown only once.

- The app is **private** by default: it can only be installed on the account that owns it. Add `--public` if other accounts should be able to install it too.
- GitHub Enterprise Server: add `--github-url https://github.example.com`.
- Prefer clicking through GitHub's UI? The exact settings are in the [manual setup table](#manual-github-app-setup) at the end.

## Step 3: Configure

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Value |
|---|---|
| `BASE_URL` | `https://r2s.example.com` |
| `GITHUB_*` | the six lines from step 2 |
| `SESSION_SECRET` | output of `openssl rand -base64 48` |
| `ENCRYPTION_KEY` | output of `openssl rand -base64 32`. **Back it up**: without it, stored AI keys can't be decrypted. |
| `MONGODB_URI` | leave as is for Option A; your Atlas connection string for Option B |
| `GEMINI_MODELS` | comma-separated Gemini model names, tried in order (e.g. `gemini-2.5-flash-lite,gemini-2.5-flash`). Required: the app won't start without it. |

Optional, for a single team:

- `GEMINI_API_KEY=...` uses one key for everyone, so nobody has to paste a key in the dashboard.
- `ALLOWED_GITHUB_ACCOUNTS=acme` refuses installations from any other account.

## Step 4A: Run on a VM with Docker

On the server (with Docker and the Compose plugin installed, ports 80 and 443 open, and your domain's DNS A record pointing at it):

```bash
git clone https://github.com/AbdullahG/ready2ship && cd ready2ship
# copy your .env here (scp .env user@server:ready2ship/)
DOMAIN=r2s.example.com docker compose --profile tls up -d --build
```

This starts the app, MongoDB, and Caddy, which gets a Let's Encrypt certificate automatically. Check it: `curl -I https://r2s.example.com/login` should return `200`.

Already have a reverse proxy? Skip `--profile tls` and point your proxy at port 8080.

**Update later:** `git pull && docker compose --profile tls up -d --build`.

## Step 4B: Run on Google Cloud Run

1. Create a free MongoDB Atlas cluster, a database user, and allow access from anywhere (`0.0.0.0/0`) or your VPC. Put the connection string in `MONGODB_URI`.
2. Store the secrets:

   ```bash
   for name in GITHUB_APP_PRIVATE_KEY GITHUB_WEBHOOK_SECRET GITHUB_CLIENT_SECRET MONGODB_URI SESSION_SECRET ENCRYPTION_KEY; do
     grep "^$name=" .env | cut -d= -f2- | tr -d '\n' | gcloud secrets create "r2s-$name" --data-file=-
   done
   ```

3. Deploy from the repository root:

   ```bash
   gcloud run deploy ready2ship --source . --region us-central1 --allow-unauthenticated \
     --port 8080 --no-cpu-throttling --min-instances 1 --memory 2Gi \
     --set-env-vars "BASE_URL=https://r2s.example.com,GITHUB_APP_ID=…,GITHUB_APP_SLUG=…,GITHUB_CLIENT_ID=…" \
     --set-secrets "GITHUB_APP_PRIVATE_KEY=r2s-GITHUB_APP_PRIVATE_KEY:latest,GITHUB_WEBHOOK_SECRET=r2s-GITHUB_WEBHOOK_SECRET:latest,GITHUB_CLIENT_SECRET=r2s-GITHUB_CLIENT_SECRET:latest,MONGODB_URI=r2s-MONGODB_URI:latest,SESSION_SECRET=r2s-SESSION_SECRET:latest,ENCRYPTION_KEY=r2s-ENCRYPTION_KEY:latest"
   ```

   `--no-cpu-throttling` and `--min-instances 1` are required: webhooks are queued and a background worker inside the app processes them, so the instance needs CPU between requests. Cloud Run allows only 10 seconds after SIGTERM, so a review interrupted by a deploy finishes on the new revision about 2 minutes later. The service account needs the *Secret Manager Secret Accessor* role.
4. Map your domain (Cloud Run → Manage custom domains), or use the `*.run.app` URL as `BASE_URL`. If the URL changed from what you used in step 2, update the four URLs in the GitHub App settings (homepage, callback, setup, webhook).

## Step 5: Install and connect AI

1. Open `https://r2s.example.com`, sign in with GitHub.
2. Click **Install the GitHub App**, choose the account and repositories.
3. You're sent back to onboarding: paste your Gemini key (skipped if you set `GEMINI_API_KEY`).
4. Invite teammates from **Members** by GitHub username.

## Step 6: Check it works

Open a pull request in a repository you installed the app on. Within a minute you should see a "Ready2Ship review" comment and inline findings. Reply `fix it` to a finding to have the fix committed.

## How reviews are processed

Every webhook is stored as a job in MongoDB (the `jobs` collection) and a worker inside the app runs it, so:

- a restart or redeploy doesn't lose a review: on SIGTERM the app stops taking new jobs and gives running ones up to 60 seconds to finish (the Docker image sets `NEXT_MANUAL_SIG_HANDLE=true` for this); a job cut short anyway, by a crash or a platform that kills sooner, is picked up again within about 2 minutes;
- a review that hits a temporary failure (Gemini overloaded, network errors, GitHub 5xx, rate limits) is retried once after 30 s; after that, or if it stops for any other reason, the PR's summary comment says so and anyone with write access can comment `@your-app retry` ([details](review-modes.md#retrying-a-review)). Other jobs are retried after 30 s, 2 min and 10 min;
- a review is never posted twice, and `fix it` never commits twice.

Gemini calls time out after 120 seconds and GitHub calls after 30 (`GEMINI_TIMEOUT_MS`, `GITHUB_TIMEOUT_MS`), so a hung request can't stall a pull request's jobs.

Repositories choose Lookout or Dive in their own `.ready2ship.yml` ([review modes](review-modes.md)); there is nothing to configure on the instance. Dive checks out the PR's head with `git`, which the Docker image includes, and holds a worker slot for minutes, so raise `JOB_CONCURRENCY` if Dive repositories are busy.

`JOB_CONCURRENCY` (default 2) sets how many jobs run in parallel; `0` turns the worker off (jobs wait until it's back). `GET /api/health` shows whether the worker runs and how many jobs are pending, running, or failed in the last 24 hours. Finished jobs are deleted after 14 days.

## Troubleshooting

| Symptom | Check |
|---|---|
| Reviews are slow to start | `curl https://r2s.example.com/api/health`: a growing `pending` means the worker can't keep up (raise `JOB_CONCURRENCY`) or is off (`worker: "disabled"`). Logs show `job.start`, `job.retry`, `job.failed`. |
| A workspace has no owner left | Shouldn't happen, but if it does: `mongosh "$MONGODB_URI" --eval 'db.getSiblingDB("ready2ship").memberships.updateOne({ githubLogin: "your-login" }, { $set: { role: "owner", status: "active" } })'` |
| Container exits right away | `docker compose logs app`: it lists every missing or invalid variable. |
| No comment on the PR | GitHub App settings → **Advanced** → Recent Deliveries. A non-200 or timeout means GitHub can't reach `BASE_URL/api/webhooks/github`. |
| "no AI key is configured" on the PR | Add a key in Settings (or set `GEMINI_API_KEY`), then comment `@your-app retry` on the PR. |
| "AI key was rejected" | The key was revoked or mistyped; replace it in Settings. |
| Sign-in loops back to the login page | `BASE_URL` must exactly match the URL you open, including `https://`, and the callback URL in the GitHub App. |

## Manual GitHub App setup

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App (or the organization's settings for an org-owned app):

| Setting | Value |
|---|---|
| Homepage URL | `https://r2s.example.com` |
| Callback URL | `https://r2s.example.com/api/auth/callback` |
| Setup URL | `https://r2s.example.com/api/github/setup`, with **Redirect on update** checked |
| Request user authorization (OAuth) during installation | off |
| Webhook URL | `https://r2s.example.com/api/webhooks/github`, plus a random webhook secret |
| Repository permissions | Contents: read & write · Issues: read & write · Pull requests: read & write · Metadata: read |
| Subscribe to events | Pull request · Issue comment · Pull request review comment · Pull request review thread |

Then generate a private key (`base64 -i key.pem | tr -d '\n'` gives `GITHUB_APP_PRIVATE_KEY`) and a client secret, and note the App ID, client ID and slug (the last part of the app's public URL).
