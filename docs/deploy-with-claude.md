# Deploy with Claude Code

Paste the prompt below into [Claude Code](https://claude.com/claude-code) in an empty folder. Claude clones the repository, asks you a few questions, and walks you through creating your GitHub App and deploying your instance. You stay in control: it asks before creating cloud resources, and you click the GitHub confirmations yourself.

````text
Set up and deploy my own instance of Ready2Ship, an open-source AI pull request reviewer:
https://github.com/AbdullahG/ready2ship

1. Clone the repository and read README.md, docs/self-host.md and .env.example. Follow docs/self-host.md; it is the source of truth.
2. Before doing anything else, ask me in one message:
   - where to run it: (A) a Linux VM with Docker that I can SSH into, or (B) Google Cloud Run with MongoDB Atlas;
   - the public URL (domain) it will live at, and whether DNS already points to the server;
   - whether the GitHub App should belong to my personal account or an organization (which one), and whether only that account may install it;
   - whether to use one shared Gemini API key for everyone (GEMINI_API_KEY) or let each workspace owner add theirs in the dashboard.
3. Check prerequisites (node 22+, openssl, and docker or gcloud depending on the target) and tell me exactly what to install if anything is missing.
4. Create the GitHub App with `node scripts/create-github-app.mjs <BASE_URL> [--org <org>]`. Tell me to open the printed localhost URL and confirm on GitHub, then capture the printed GITHUB_* values.
5. Generate SESSION_SECRET and ENCRYPTION_KEY with openssl, write .env from .env.example, and remind me to back up ENCRYPTION_KEY somewhere safe. Never commit .env and never paste secret values back into the chat; refer to them by name.
6. Deploy using the steps for the target I chose (docker compose with the tls profile on the VM, or Secret Manager + gcloud run deploy with --no-cpu-throttling). Ask for my confirmation before creating any cloud resource that may cost money.
7. Verify: <BASE_URL>/login returns 200 over HTTPS. Then guide me to sign in, install the app on a repository, add the Gemini key if needed, and open a test pull request. Confirm a review comment appears; if not, use the Troubleshooting table in docs/self-host.md (start with the GitHub App's Recent Deliveries).
8. Finish with a short summary: the URL, the GitHub App's settings page, where the secrets live, and how to update later.
````

Not using Claude Code? The same steps by hand are in [self-host.md](self-host.md).
