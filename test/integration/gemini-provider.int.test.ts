import { describe, expect, it } from "vitest";
import { GeminiProvider } from "@/lib/ai/providers/gemini";
import { getProviderForWorkspace } from "@/lib/ai";
import { InvalidKeyError, MissingKeyError, QuotaError } from "@/lib/ai/errors";
import { resetConfigForTests } from "@/lib/config";
import { GEMINI_KEYS } from "../fakes/gemini";
import { testEnv } from "./env";
import { makeWorkspace } from "./builders";

function provider(apiKey: string, models = ["fake-primary", "fake-fallback"]) {
  return new GeminiProvider({ apiKey, models, baseUrl: testEnv.gemini.url });
}

describe("GeminiProvider", () => {
  it("I-01 returnsTheModelTextAndSendsTheKey", async () => {
    testEnv.gemini.scripted.push("  hello  ");
    expect(await provider(GEMINI_KEYS.valid).generate("prompt")).toBe("hello");
    expect(testEnv.gemini.generateCalls).toEqual([
      expect.objectContaining({ model: "fake-primary", key: GEMINI_KEYS.valid, prompt: "prompt" }),
    ]);
  });

  it("I-01 fallsBackToTheNextModelWhenOneIsUnavailable", async () => {
    testEnv.gemini.failingModels.add("fake-primary");
    testEnv.gemini.scripted.push("from fallback");
    expect(await provider(GEMINI_KEYS.valid).generate("p")).toBe("from fallback");
    expect(testEnv.gemini.generateCalls.map((c) => c.model)).toEqual(["fake-primary", "fake-fallback"]);
  });

  it("I-01 invalidKeyFailsFastWithInvalidKeyError", async () => {
    const err = await provider(GEMINI_KEYS.invalid).generate("p").catch((e) => e);
    expect(err).toBeInstanceOf(InvalidKeyError);
    expect(err.message).toBe("API key not valid. Please pass a valid API key.");
    expect(testEnv.gemini.generateCalls).toHaveLength(1);
  });

  it("I-01 exhaustedQuotaOnEveryModelSurfacesAsQuotaError", async () => {
    await expect(provider(GEMINI_KEYS.quota).generate("p")).rejects.toBeInstanceOf(QuotaError);
  });

  it("I-01 allModelsDownSurfacesAGenericError", async () => {
    testEnv.gemini.failingModels.add("fake-primary").add("fake-fallback");
    const err = await provider(GEMINI_KEYS.valid).generate("p").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InvalidKeyError);
    expect(err.message).toMatch(/All Gemini models failed/);
  });

  it("I-01 validateKeyAcceptsAValidOrQuotaLimitedKeyAndRejectsAnInvalidOneWithoutGenerating", async () => {
    expect(await provider(GEMINI_KEYS.valid).validateKey()).toEqual({ ok: true });
    expect(await provider(GEMINI_KEYS.quota).validateKey()).toEqual({ ok: true });
    const bad = await provider(GEMINI_KEYS.invalid).validateKey();
    expect(bad.ok).toBe(false);
    // Shown to users as-is: no HTTP status, URL or raw error JSON.
    if (!bad.ok) expect(bad.reason).toBe("Google rejected this key: API key not valid. Please pass a valid API key.");
    expect(testEnv.gemini.generateCalls).toHaveLength(0);
  });
});

describe("timeouts", () => {
  it("I-24 aHangingGeminiCallTimesOutAndIsTreatedAsTransient", async () => {
    testEnv.gemini.latencyMs = 2_000;
    const p = new GeminiProvider({ apiKey: GEMINI_KEYS.valid, models: ["fake-primary"], baseUrl: testEnv.gemini.url, timeoutMs: 200 });
    const started = Date.now();
    const err = await p.generate("p").catch((e) => e);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InvalidKeyError);
  });
});

describe("getProviderForWorkspace", () => {
  it("I-16 usesTheWorkspaceKeyFirst", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    await getProviderForWorkspace(ws).generate("p");
    expect(testEnv.gemini.generateCalls[0].key).toBe(GEMINI_KEYS.valid);
  });

  it("I-16 fallsBackToTheInstanceKeyWhenTheWorkspaceHasNone", async () => {
    process.env.GEMINI_API_KEY = "AIza-instance-key";
    resetConfigForTests();
    try {
      const ws = await makeWorkspace();
      await getProviderForWorkspace(ws).generate("p");
      expect(testEnv.gemini.generateCalls[0].key).toBe("AIza-instance-key");
    } finally {
      delete process.env.GEMINI_API_KEY;
      resetConfigForTests();
    }
  });

  it("I-16 throwsMissingKeyErrorWhenNoKeyIsAvailable", async () => {
    const ws = await makeWorkspace();
    expect(() => getProviderForWorkspace(ws)).toThrow(MissingKeyError);
  });
});

describe("GeminiProvider.chat", () => {
  const tools = [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];

  it("DI-16 aToolCallRoundTripSendsTheModelTurnBackUnchanged", async () => {
    testEnv.gemini.scripted.push(
      { functionCalls: [{ name: "read_file", args: { path: "src/a.ts" } }], thoughtSignature: "sig-123", promptTokens: 120 },
      { text: "done", promptTokens: 300 }
    );
    const p = provider(GEMINI_KEYS.valid);
    const first = await p.chat({ system: "be terse", messages: [{ role: "user", text: "review" }], tools });
    expect(first.text).toBeNull();
    expect(first.toolCalls).toEqual([{ id: undefined, name: "read_file", args: { path: "src/a.ts" } }]);
    expect(first.usage.inputTokens).toBe(120);

    const second = await p.chat({
      system: "be terse",
      messages: [
        { role: "user", text: "review" },
        first.message,
        { role: "tool", results: [{ name: "read_file", response: { content: "x" } }] },
      ],
      tools,
    });
    expect(second.text).toBe("done");
    expect(second.toolCalls).toEqual([]);
    expect(second.usage.inputTokens).toBe(300);

    const sent = testEnv.gemini.generateCalls[1];
    expect(sent.system).toBe("be terse");
    expect(sent.tools).toEqual(["read_file"]);
    // The model turn goes back with its thought signature, then the tool result.
    expect(sent.contents[1]).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "read_file", args: { path: "src/a.ts" } }, thoughtSignature: "sig-123" }],
    });
    expect(sent.contents[2].parts[0]).toEqual({ functionResponse: { name: "read_file", response: { content: "x" } } });
  });

  it("DI-17 a503MidRunFallsBackForThatCallAndARejectedKeyStops", async () => {
    testEnv.gemini.scripted.push("one", "two");
    const p = provider(GEMINI_KEYS.valid);
    await p.chat({ system: "s", messages: [{ role: "user", text: "a" }], tools });
    testEnv.gemini.failingModels.add("fake-primary");
    expect((await p.chat({ system: "s", messages: [{ role: "user", text: "b" }], tools })).text).toBe("two");
    expect(testEnv.gemini.generateCalls.map((c) => c.model)).toEqual(["fake-primary", "fake-primary", "fake-fallback"]);

    const bad = provider(GEMINI_KEYS.invalid);
    await expect(bad.chat({ system: "s", messages: [{ role: "user", text: "a" }], tools })).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it("DI-17 generateWithUsageReportsTokens", async () => {
    testEnv.gemini.scripted.push({ text: " hi ", promptTokens: 42 });
    expect(await provider(GEMINI_KEYS.valid).generateWithUsage("p")).toEqual({ text: "hi", usage: { inputTokens: 42, outputTokens: 10 } });
  });
});
