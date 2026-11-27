import { describe, expect, it } from "vitest";
import { DiveBudget, DiveCancelledError, MAX_CONTEXT_TOKENS } from "@/lib/dive/budget";
import { isRetryable } from "@/lib/jobs/errors";
import { DIVE_DEFAULTS } from "@/lib/repo-config";

const limits = (o: Partial<typeof DIVE_DEFAULTS> = {}) => ({ ...DIVE_DEFAULTS, ...o });
function cancelled(fn: () => void): DiveCancelledError {
  try {
    fn();
  } catch (err) {
    if (err instanceof DiveCancelledError) return err;
    throw err;
  }
  throw new Error("expected DiveCancelledError");
}

describe("DiveBudget", () => {
  it("DU-06 stopsBeforeACallThatWouldPassTheInputTokenCap", () => {
    const b = new DiveBudget(limits({ maxInputTokens: 1_000 }));
    b.beforeModelCall(0);
    b.afterModelCall({ inputTokens: 600, outputTokens: 50 });
    // The next prompt repeats the 650-token history plus ~100 tokens of tool output.
    const err = cancelled(() => b.beforeModelCall(400));
    expect(err.reason).toBe("used 600 of 1,000 input tokens before finishing");
    expect(err.hint).toBe("Raise dive.maxInputTokens in .ready2ship.yml or narrow review.include");
  });

  it("DU-06 allowsCallsThatFitTheTokenCap", () => {
    const b = new DiveBudget(limits({ maxInputTokens: 1_000 }));
    b.afterModelCall({ inputTokens: 300, outputTokens: 0 });
    expect(() => b.beforeModelCall(400)).not.toThrow(); // 300 + (300 + 100) = 700
    expect(b.usage().inputTokens).toBe(300);
  });

  it("DU-06 stopsWhenOneCallWouldOutgrowTheContextWindow", () => {
    const b = new DiveBudget(limits({ maxInputTokens: 100_000_000 }));
    b.afterModelCall({ inputTokens: MAX_CONTEXT_TOKENS - 10, outputTokens: 0 });
    expect(cancelled(() => b.beforeModelCall(400)).reason).toBe("the conversation grew past the model's context window");
  });

  it("DU-06 theToolCallCapAllowsExactlyMaxCalls", () => {
    const b = new DiveBudget(limits({ maxToolCalls: 3 }));
    b.beforeToolCall();
    b.beforeToolCall();
    b.beforeToolCall();
    const err = cancelled(() => b.beforeToolCall());
    expect(err.reason).toBe("used all 3 tool calls before finishing");
    expect(err.hint).toMatch(/dive\.maxToolCalls/);
    expect(b.usage().toolCalls).toBe(3);
  });

  it("DU-06 theFileCapCountsDistinctFiles", () => {
    const b = new DiveBudget(limits({ maxFiles: 2 }));
    b.readFile("a.ts");
    b.readFile("a.ts");
    b.readFile("b.ts");
    expect(b.usage().filesRead).toBe(2);
    expect(cancelled(() => b.readFile("c.ts")).reason).toBe("needed more than 2 files");
  });

  it("DU-06 theSameFileUnderAnotherSpellingCountsOnce", () => {
    const b = new DiveBudget(limits({ maxFiles: 1 }));
    b.readFile("src/a.ts");
    b.readFile("./src/a.ts");
    b.readFile("src//a.ts");
    expect(b.usage().filesRead).toBe(1);
  });

  it("DU-06 warnsWhenFewerThanAFifthOfToolCallsRemain", () => {
    const b = new DiveBudget(limits({ maxToolCalls: 10 }));
    for (let i = 0; i < 8; i++) b.beforeToolCall();
    expect(b.wrapUpNote()).toBeNull(); // 2 left = 20%, not below
    b.beforeToolCall();
    expect(b.wrapUpNote()).toBe("Budget: 1 tool call left. Stop exploring and return the final JSON now.");
  });

  it("DU-06 aCancelledDiveIsNotRetried", () => {
    expect(isRetryable(new DiveCancelledError("x", "y"))).toBe(false);
  });
});
