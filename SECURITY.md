# Security

Please **don't** open public issues for vulnerabilities. Report them privately through GitHub: **Security → Report a vulnerability** on this repository. You'll get a reply within a few days.

Particularly relevant areas: tenant isolation between workspaces, handling of stored AI keys and GitHub tokens (`src/lib/crypto.ts`), webhook signature verification, and anything that lets a non-collaborator make the bot commit code or call the AI.
