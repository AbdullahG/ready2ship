#!/usr/bin/env node
// Creates the GitHub App for your instance through GitHub's manifest flow and
// prints the env variables to paste into .env.local / your secret manager.
//
//   node scripts/create-github-app.mjs https://r2s.example.com [--org my-org] [--public]
//
// Opens a local page on :3999 that submits the manifest to GitHub; after you
// confirm, GitHub redirects back here and the credentials are exchanged.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const [baseUrlArg, ...rest] = process.argv.slice(2);
if (!baseUrlArg) {
  console.error("Usage: node scripts/create-github-app.mjs <BASE_URL> [--org <org>] [--public] [--github-url https://github.com]");
  process.exit(1);
}
const baseUrl = baseUrlArg.replace(/\/+$/, "");
const flag = (name) => {
  const i = rest.indexOf(name);
  return i === -1 ? null : rest[i + 1];
};
const org = flag("--org");
const webUrl = (flag("--github-url") ?? "https://github.com").replace(/\/+$/, "");
const apiUrl = webUrl === "https://github.com" ? "https://api.github.com" : `${webUrl}/api/v3`;

const manifest = JSON.parse(
  readFileSync(new URL("../github-app-manifest.json", import.meta.url), "utf-8").replaceAll("https://YOUR_BASE_URL", baseUrl)
);
manifest.public = rest.includes("--public");

const target = org ? `${webUrl}/organizations/${org}/settings/apps/new` : `${webUrl}/settings/apps/new`;
const state = crypto.randomUUID();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:3999");
  if (url.pathname === "/") {
    const escaped = JSON.stringify(manifest).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    res.writeHead(200, { "content-type": "text/html" }).end(
      `<form id="f" method="post" action="${target}?state=${state}"><input type="hidden" name="manifest" value="${escaped}"></form><script>f.submit()</script>`
    );
    return;
  }
  if (url.pathname === "/callback" && url.searchParams.get("state") === state) {
    const r = await fetch(`${apiUrl}/app-manifests/${url.searchParams.get("code")}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json" },
    });
    const app = await r.json();
    if (!r.ok) {
      res.writeHead(500).end(JSON.stringify(app));
      console.error(app);
      process.exit(1);
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("Done. Return to your terminal.");
    console.log(`\n# GitHub App "${app.slug}" created. Add these to your environment:\n`);
    console.log(`GITHUB_APP_ID=${app.id}`);
    console.log(`GITHUB_APP_SLUG=${app.slug}`);
    console.log(`GITHUB_APP_PRIVATE_KEY=${Buffer.from(app.pem).toString("base64")}`);
    console.log(`GITHUB_WEBHOOK_SECRET=${app.webhook_secret}`);
    console.log(`GITHUB_CLIENT_ID=${app.client_id}`);
    console.log(`GITHUB_CLIENT_SECRET=${app.client_secret}`);
    if (webUrl !== "https://github.com") console.log(`GITHUB_WEB_URL=${webUrl}\nGITHUB_API_URL=${apiUrl}`);
    server.close();
    return;
  }
  res.writeHead(404).end();
});
server.listen(3999, () => console.log("Open http://localhost:3999 to create the GitHub App."));
