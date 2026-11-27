import { describe, expect, it } from "vitest";
import { pathAfterInstall } from "@/lib/workspaces/ai-key";
import { resetConfigForTests } from "@/lib/config";
import { makeWorkspace } from "./builders";

describe("where the Setup URL sends the installer", () => {
  it("I-17 aWorkspaceWithoutAnyKeyGoesToOnboarding", async () => {
    const ws = await makeWorkspace();
    expect(pathAfterInstall(ws)).toBe(`/w/${ws._id}/onboarding`);
  });

  it("I-17 aWorkspaceWithItsOwnKeyGoesToTheOverview", async () => {
    const ws = await makeWorkspace({ aiKey: "AIza-own-1234" });
    expect(pathAfterInstall(ws)).toBe(`/w/${ws._id}`);
  });

  it("I-17 anInstanceDefaultKeySkipsOnboarding", async () => {
    process.env.GEMINI_API_KEY = "AIza-instance";
    resetConfigForTests();
    try {
      const ws = await makeWorkspace();
      expect(pathAfterInstall(ws)).toBe(`/w/${ws._id}`);
    } finally {
      delete process.env.GEMINI_API_KEY;
      resetConfigForTests();
    }
  });
});
