import { expect, test } from "@playwright/test";
import { dbDocs, githubComments, installApp, loginAs, openPullRequest, resetStack } from "./helpers";

const VALID = "AIza-fake-valid-key-1234";
const INVALID = "AIza-fake-INVALID-key-0000";

test.beforeEach(resetStack);

test("E-01 owner goes from sign-in to a reviewed PR", async ({ page }) => {
  await loginAs(page, "alice");

  // Empty state for a brand-new user.
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByRole("link", { name: /Install the GitHub App/ })).toHaveAttribute(
    "href",
    /\/apps\/r2s-e2e\/installations\/new$/
  );
  await expect(page.getByText("@alice")).toBeVisible();

  // GitHub installs the app and redirects to the Setup URL → onboarding.
  const ws = await installApp(page, { installationId: 101, account: "team-a", owner: "alice" });
  await expect(page).toHaveURL(new RegExp(`/w/${ws}/onboarding$`));
  await expect(page.getByRole("heading", { name: "Set up team-a" })).toBeVisible();
  await expect(page.getByText("GitHub App installed")).toBeVisible();
  // Onboarding is the fix for the missing key, so it doesn't nag about it.
  await expect(page.getByTestId("key-banner")).toHaveCount(0);

  // A rejected key shows Google's reason and is not saved.
  await page.getByLabel("Gemini API key").fill(INVALID);
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Google rejected this key" })).toHaveText(
    "Google rejected this key: API key not valid. Please pass a valid API key."
  );
  expect((await dbDocs<{ ai: { keyStatus: string } }>("workspaces"))[0].ai.keyStatus).toBe("missing");

  // A valid key completes onboarding.
  await page.getByLabel("Gemini API key").fill(VALID);
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByTestId("onboarding-ready")).toBeVisible();
  const [workspace] = await dbDocs<Record<string, never>>("workspaces");
  expect(JSON.stringify(workspace)).not.toContain(VALID);

  await page.getByRole("link", { name: "Go to overview" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByTestId("key-banner")).toHaveCount(0);

  // A PR opened on GitHub gets reviewed and shows up in the dashboard.
  await openPullRequest(page, { installationId: 101, repo: "team-a/app", number: 1, title: "Add greet" });
  await expect
    .poll(async () => (await githubComments()).some((c) => c.body.includes("Review complete")))
    .toBe(true);

  await page.getByRole("link", { name: "Pull Requests" }).click();
  const row = page.getByTestId("pulls-table").getByRole("row", { name: /Add greet/ });
  await expect(row).toContainText("Reviewed");
  await row.getByRole("link", { name: "Add greet" }).click();
  await expect(page.getByText("Possible null dereference on name.")).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("ai-key-current")).toContainText("••••1234");
});

test("E-02 without a key, PRs are flagged and the owner is told to finish setup", async ({ page }) => {
  await loginAs(page, "alice");
  const ws = await installApp(page, { installationId: 101, account: "team-a", owner: "alice" });

  // Owner skips onboarding.
  await page.goto(`/w/${ws}`);
  await expect(page.getByTestId("key-banner")).toContainText("No AI key yet");

  await openPullRequest(page, { installationId: 101, repo: "team-a/app", number: 2, title: "Unreviewed change" });
  await expect
    .poll(async () => (await githubComments()).some((c) => c.body.includes("no AI key is configured")))
    .toBe(true);

  await page.goto(`/w/${ws}/pulls`);
  await expect(page.getByTestId("pulls-table").getByRole("row", { name: /Unreviewed change/ })).toContainText(
    "Needs AI key"
  );

  await page.getByTestId("key-banner").getByRole("link", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${ws}/onboarding$`));
});
