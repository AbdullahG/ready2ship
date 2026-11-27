import { describe, expect, it } from "vitest";
import { publicAiState, removeWorkspaceKey, saveWorkspaceKey } from "@/lib/workspaces/ai-key";
import { getWorkspacesCollection } from "@/lib/db/collections";
import { decryptSecret } from "@/lib/crypto";
import { GEMINI_KEYS } from "../fakes/gemini";
import { testEnv } from "./env";
import { makeWorkspace } from "./builders";

const load = async (id: unknown) => (await getWorkspacesCollection()).findOne({ _id: id as never });

describe("workspace AI key", () => {
  it("I-10 rejectsAnInvalidKeyAndStoresNothing", async () => {
    const ws = await makeWorkspace();
    const result = await saveWorkspaceKey(ws, GEMINI_KEYS.invalid, "alice");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Google rejected this key/);
    const after = await load(ws._id);
    expect(after!.ai).toMatchObject({ encryptedKey: null, keyStatus: "missing" });
    expect(after!.onboardingCompletedAt).toBeNull();
  });

  it.each(["", "   ", "x".repeat(300)])("I-10 rejectsMalformedInput %#", async (key) => {
    const ws = await makeWorkspace();
    expect((await saveWorkspaceKey(ws, key, "alice")).ok).toBe(false);
    expect(testEnv.gemini.calls).toHaveLength(0);
  });

  it("I-10 storesAValidKeyEncryptedAndExposesOnlyTheLast4", async () => {
    const ws = await makeWorkspace();
    const result = await saveWorkspaceKey(ws, `  ${GEMINI_KEYS.valid}  `, "alice");

    expect(result).toEqual({ ok: true });
    const after = await load(ws._id);
    expect(JSON.stringify(after)).not.toContain(GEMINI_KEYS.valid);
    expect(decryptSecret(after!.ai.encryptedKey!)).toBe(GEMINI_KEYS.valid);
    expect(after!.ai).toMatchObject({ keyStatus: "valid", keyLast4: "1234", keyUpdatedBy: "alice" });
    expect(after!.onboardingCompletedAt).toBeInstanceOf(Date);

    const state = publicAiState(after!, "owner");
    expect(state).toEqual({
      provider: "gemini",
      keyStatus: "valid",
      keyLast4: "1234",
      keyUpdatedAt: expect.any(Date),
      usingInstanceKey: false,
    });
    expect(JSON.stringify(state)).not.toContain("AIza");
  });

  it("I-10b membersOnlySeeTheKeyStatus", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    expect(publicAiState(ws, "member")).toEqual({ provider: "gemini", keyStatus: "valid", usingInstanceKey: false });
    expect(publicAiState(ws, "owner")).toMatchObject({ keyLast4: "1234", keyUpdatedAt: expect.any(Date) });
  });

  it("I-10 replacingAnInvalidKeyRestoresValidAndKeepsOnboardingDate", async () => {
    const first = new Date("2026-01-01T00:00:00Z");
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.invalid, onboardingCompletedAt: first });
    await (await getWorkspacesCollection()).updateOne({ _id: ws._id }, { $set: { "ai.keyStatus": "invalid" } });

    await saveWorkspaceKey((await load(ws._id))!, GEMINI_KEYS.valid, "bob");

    const after = await load(ws._id);
    expect(after!.ai.keyStatus).toBe("valid");
    expect(after!.onboardingCompletedAt).toEqual(first);
  });

  it("I-10 removingTheKeyClearsItAndStatusBecomesMissing", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    await removeWorkspaceKey(ws, "alice");
    expect((await load(ws._id))!.ai).toMatchObject({ encryptedKey: null, keyLast4: null, keyStatus: "missing" });
  });
});
