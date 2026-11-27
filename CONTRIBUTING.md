# Contributing

Thanks for helping! Bug reports, fixes and focused features are welcome.

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. `npm ci`, then make your change with tests. See [docs/testing.md](docs/testing.md); tests use local fakes, so you don't need GitHub or Gemini credentials.
3. Before opening a PR: `npm run lint && npm run typecheck && npm test && npm run test:e2e`.
4. Keep PRs small and describe the behavior change and how you verified it.

Code style: follow the surrounding code. Configuration goes through `src/lib/config.ts` (never read `process.env` elsewhere), and every query on workspace data must be scoped by `workspaceId` and go through `authorizeWorkspace`.

By contributing you agree that your contributions are licensed under the MIT license.
