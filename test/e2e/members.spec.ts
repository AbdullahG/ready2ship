import { expect, test } from "@playwright/test";
import { dbDocs, installApp, loginAs, openPullRequest, resetStack, seedUser } from "./helpers";

test.beforeEach(resetStack);

test("E-03 an invited member signs in and sees reviews but no owner controls", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await loginAs(owner, "alice");
  const ws = await installApp(owner, { installationId: 101, account: "team-a", owner: "alice" });
  await openPullRequest(owner, { installationId: 101, repo: "team-a/app", number: 3, title: "Shared PR" });
  // Webhooks are processed by the job worker, asynchronously.
  await expect.poll(async () => (await dbDocs("pull_requests")).length).toBe(1);

  await owner.request.put(`/api/w/${ws}/ai-key`, {
    headers: { origin: "http://127.0.0.1:3900" },
    data: { key: "AIza-fake-valid-key-1234" },
  });
  await seedUser("bob");
  await owner.goto(`/w/${ws}/settings/members`);
  await owner.getByLabel("Invite by GitHub username").fill("@bob");
  await owner.getByRole("button", { name: "Invite" }).click();
  await expect(owner.getByTestId("member-bob")).toContainText("Invited");

  const memberCtx = await browser.newContext();
  const member = await memberCtx.newPage();
  await loginAs(member, "bob");
  // Single workspace → straight into it.
  await expect(member).toHaveURL(new RegExp(`/w/${ws}$`));
  await expect(member.getByTestId("key-banner")).toHaveCount(0);

  await member.getByRole("link", { name: "Pull Requests" }).click();
  await expect(member.getByTestId("pulls-table")).toContainText("Shared PR");

  await member.getByRole("link", { name: "Settings" }).click();
  await expect(member.getByTestId("ai-key-readonly")).toContainText("A Gemini key is active.");
  await expect(member.getByTestId("ai-key-readonly")).toContainText("Only workspace owners can change the key");
  await expect(member.getByText("1234")).toHaveCount(0);
  await expect(member.getByLabel("Gemini API key")).toHaveCount(0);

  await member.getByRole("link", { name: "Members" }).click();
  await expect(member.getByTestId("members-list")).toContainText("@alice");
  await expect(member.getByLabel("Invite by GitHub username")).toHaveCount(0);
  await expect(member.getByRole("button", { name: /Remove/ })).toHaveCount(0);

  await owner.reload();
  await expect(owner.getByTestId("member-bob")).not.toContainText("Invited");
  await ownerCtx.close();
  await memberCtx.close();
});

test("E-04 a stranger sees the empty state and cannot open someone else's workspace", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await loginAs(owner, "alice");
  const ws = await installApp(owner, { installationId: 101, account: "team-a", owner: "alice" });

  const strangerCtx = await browser.newContext();
  const stranger = await strangerCtx.newPage();
  await loginAs(stranger, "carol");
  await expect(stranger.getByTestId("empty-state")).toContainText("Ask a workspace owner to invite @carol");

  const res = await stranger.goto(`/w/${ws}`);
  expect(res!.status()).toBe(404);
  await expect(stranger.getByText("team-a")).toHaveCount(0);
  await ownerCtx.close();
  await strangerCtx.close();
});

test("E-05 owners manage roles, and the last owner is protected", async ({ page }) => {
  await loginAs(page, "alice");
  const ws = await installApp(page, { installationId: 101, account: "team-a", owner: "alice" });
  await seedUser("bob");
  await page.goto(`/w/${ws}/settings/members`);
  await page.getByLabel("Invite by GitHub username").fill("bob");
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByTestId("member-bob")).toBeVisible();

  // Sole owner can't step down.
  await page.getByLabel("Role for @alice").selectOption("member");
  await expect(page.getByTestId("members-error")).toHaveText("A workspace needs at least one owner.");
  await expect(page.getByLabel("Role for @alice")).toHaveValue("owner");

  // Unknown users are rejected with a clear message.
  await page.getByLabel("Invite by GitHub username").fill("ghost-user");
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByTestId("members-error")).toHaveText("No GitHub user named @ghost-user.");

  // Promote bob, then bob can be removed by alice.
  await page.getByLabel("Role for @bob").selectOption("owner");
  await expect(page.getByLabel("Role for @bob")).toHaveValue("owner");
  await expect(page.getByTestId("members-error")).toHaveText("");
  await page.getByRole("button", { name: "Remove @bob" }).click();
  await expect(page.getByTestId("member-bob")).toHaveCount(0);
});

test("E-06 the sign-in page links to the source code", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Source" })).toHaveAttribute("href", /github\.com/);
});
