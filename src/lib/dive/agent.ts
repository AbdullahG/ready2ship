// The Dive agent: explores the PR head with tools until it can answer with the
// review JSON, then a separate verification call drops findings the code
// doesn't support. Every model and tool call goes through the budget.
import type { AIProvider, ChatMessage } from "@/lib/ai/providers/types";
import { buildDiveFirstMessage, buildDiveSystemPrompt, buildVerifyPrompt, VERIFY_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { parseReviewJson } from "@/lib/ai/review";
import type { DiveLimits } from "@/lib/repo-config";
import type { ReviewResult, ReviewUsage } from "@/types";
import { DiveBudget, DiveCancelledError } from "./budget";
import type { RepoSource } from "./source";
import { diveTools, executeTool, outOfScope } from "./tools";

/** Lines of context around a finding that the verifier sees. */
export const EVIDENCE_CONTEXT_LINES = 30;
const MAX_DIFF_CHARS = 60_000;

export interface DiveInput {
  provider: AIProvider;
  source: RepoSource;
  limits: DiveLimits;
  inScope: (path: string) => boolean;
  prTitle: string;
  prBody: string;
  diff: string;
}

export async function runDive(input: DiveInput): Promise<{ result: ReviewResult; usage: ReviewUsage }> {
  const budget = new DiveBudget(input.limits);
  const usage = (dropped: number): ReviewUsage => ({ ...budget.usage(), droppedByVerification: dropped, source: input.source.kind });
  try {
    const diff = input.diff.length > MAX_DIFF_CHARS ? `${input.diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]` : input.diff;
    const result = await explore(input, budget, diff);
    const dropped = await verify(input, budget, diff, result);
    return { result, usage: usage(dropped) };
  } catch (err) {
    // Cancelled runs still report what they spent.
    if (err instanceof DiveCancelledError) err.usage = usage(0);
    throw err;
  }
}

async function explore(input: DiveInput, budget: DiveBudget, diff: string): Promise<ReviewResult> {
  const tools = diveTools(input.source);
  const system = buildDiveSystemPrompt(tools.map((t) => t.name));
  const messages: ChatMessage[] = [{ role: "user", text: buildDiveFirstMessage(input.prTitle, input.prBody || "", diff || "(empty diff)") }];
  let pendingChars = messages[0].role === "user" ? messages[0].text.length : 0;
  let repaired = false;

  for (;;) {
    budget.beforeModelCall(pendingChars);
    const res = await input.provider.chat({ system, messages, tools });
    budget.afterModelCall(res.usage);
    messages.push(res.message);

    if (res.toolCalls.length === 0) {
      try {
        return parseReviewJson(res.text ?? "");
      } catch (err) {
        // One repair turn: restarting the whole Dive would throw away everything it explored.
        if (!(err instanceof SyntaxError) || repaired) throw err;
        repaired = true;
        const ask = "Your last answer wasn't valid JSON. Reply with the review JSON only: no prose, no code fence, no tool call.";
        messages.push({ role: "user", text: ask });
        pendingChars = ask.length;
        continue;
      }
    }

    const results: Array<{ id?: string; name: string; response: Record<string, unknown> }> = [];
    for (const call of res.toolCalls) {
      results.push({ id: call.id, name: call.name, response: await executeTool(call, { ...input, budget, maxLinesPerFile: input.limits.maxLinesPerFile }) });
    }
    const note = budget.wrapUpNote() ?? undefined;
    messages.push({ role: "tool", results, note });
    pendingChars = JSON.stringify(results).length + (note?.length ?? 0);
  }
}

/** Returns how many findings were dropped (they are removed from `result`). */
async function verify(input: DiveInput, budget: DiveBudget, diff: string, result: ReviewResult): Promise<number> {
  if (result.findings.length === 0) return 0;
  const findings = await Promise.all(
    result.findings.map(async (f, index) => ({
      index,
      ...f,
      evidence: outOfScope(f.file, input.inScope) ? "(excluded by .ready2ship.yml)" : await evidenceFor(input.source, f.file, f.startLine, f.endLine),
    }))
  );
  const prompt = buildVerifyPrompt(diff, findings);
  budget.beforeModelCall(prompt.length + VERIFY_SYSTEM_PROMPT.length);
  const res = await input.provider.chat({ system: VERIFY_SYSTEM_PROMPT, messages: [{ role: "user", text: prompt }], tools: [] });
  budget.afterModelCall(res.usage);

  let drop: Set<number>;
  try {
    const text = res.text ?? "";
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { verdicts?: Array<{ index?: number; keep?: boolean }> };
    drop = new Set((parsed.verdicts ?? []).filter((v) => v.keep === false && typeof v.index === "number").map((v) => v.index!));
  } catch {
    // An unreadable verdict keeps every finding: dropping on noise would hide real bugs.
    console.warn(JSON.stringify({ msg: "dive.verify_unparsed" }));
    return 0;
  }
  const before = result.findings.length;
  result.findings = result.findings.filter((_, i) => !drop.has(i));
  return before - result.findings.length;
}

async function evidenceFor(source: RepoSource, file: string, start: number, end: number): Promise<string> {
  try {
    const slice = await source.readFile(file, Math.max(1, start - EVIDENCE_CONTEXT_LINES), (end || start) + EVIDENCE_CONTEXT_LINES);
    return slice.lines.map((l, i) => `${slice.startLine + i}| ${l}`).join("\n");
  } catch {
    return "(file not readable at the PR head)";
  }
}
