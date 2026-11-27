import { posix } from "node:path";
import type { DiveLimits } from "@/lib/repo-config";
import type { TokenUsage } from "@/lib/ai/providers/types";

/** Kept below Gemini's 1M-token window so a single call can't be rejected for size. */
export const MAX_CONTEXT_TOKENS = 900_000;

/** A Dive that ran out of budget. Not retried: the same PR would run out again. */
export class DiveCancelledError extends Error {
  /** What the run had spent when it stopped (set by the agent). */
  usage: import("@/types").ReviewUsage | null = null;

  constructor(
    /** What ran out, shown on the PR ("used all 50 tool calls before finishing"). */
    readonly reason: string,
    /** What to change, shown on the PR. */
    readonly hint: string
  ) {
    super(reason);
    this.name = "DiveCancelledError";
  }
}

const n = (x: number) => x.toLocaleString("en-US");

/**
 * Enforces .ready2ship.yml's Dive limits. Checked before each model call and
 * tool call, so the review stops before spending past a limit, not after.
 */
export class DiveBudget {
  private toolCalls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  /** Size of the last prompt plus its answer: the next prompt starts from here. */
  private historyTokens = 0;
  private files = new Set<string>();

  constructor(private limits: DiveLimits) {}

  /** `pendingChars`: tool output about to be added to the conversation. */
  beforeModelCall(pendingChars: number): void {
    const nextPrompt = this.historyTokens + Math.ceil(pendingChars / 4);
    if (nextPrompt > MAX_CONTEXT_TOKENS) {
      throw new DiveCancelledError(
        "the conversation grew past the model's context window",
        "Narrow review.include or lower dive.maxLinesPerFile in .ready2ship.yml"
      );
    }
    if (this.inputTokens + nextPrompt > this.limits.maxInputTokens) {
      throw new DiveCancelledError(
        `used ${n(this.inputTokens)} of ${n(this.limits.maxInputTokens)} input tokens before finishing`,
        "Raise dive.maxInputTokens in .ready2ship.yml or narrow review.include"
      );
    }
  }

  afterModelCall(usage: TokenUsage): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.historyTokens = usage.inputTokens + usage.outputTokens;
  }

  beforeToolCall(): void {
    if (this.toolCalls >= this.limits.maxToolCalls) {
      throw new DiveCancelledError(
        `used all ${n(this.limits.maxToolCalls)} tool calls before finishing`,
        "Raise dive.maxToolCalls in .ready2ship.yml or narrow review.include"
      );
    }
    this.toolCalls++;
  }

  /** Counts distinct files read. */
  readFile(rawPath: string): void {
    const path = posix.normalize(rawPath).replace(/^\.\//, "");
    if (this.files.has(path)) return;
    if (this.files.size >= this.limits.maxFiles) {
      throw new DiveCancelledError(
        `needed more than ${n(this.limits.maxFiles)} files`,
        "Raise dive.maxFiles in .ready2ship.yml or narrow review.include"
      );
    }
    this.files.add(path);
  }

  /** A nudge for the model once fewer than a fifth of its tool calls remain. */
  wrapUpNote(): string | null {
    const left = this.limits.maxToolCalls - this.toolCalls;
    if (left >= this.limits.maxToolCalls * 0.2) return null;
    return `Budget: ${left} tool call${left === 1 ? "" : "s"} left. Stop exploring and return the final JSON now.`;
  }

  usage() {
    return { toolCalls: this.toolCalls, filesRead: this.files.size, inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }
}
