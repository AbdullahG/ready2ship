import { describe, expect, it } from "vitest";
import { getPRFiles } from "@/lib/github/api";
import { resetConfigForTests } from "@/lib/config";
import { testEnv } from "./env";

describe("GitHub API timeouts", () => {
  it("I-25 aHangingGitHubCallTimesOut", async () => {
    process.env.GITHUB_TIMEOUT_MS = "200";
    resetConfigForTests();
    try {
      testEnv.github.addInstallation({ id: 1, accountLogin: "acme" });
      testEnv.github.delayMs = 2_000;
      const started = Date.now();
      const err = await getPRFiles(1, "acme", "app", 1).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      delete process.env.GITHUB_TIMEOUT_MS;
      resetConfigForTests();
    }
  });
});
