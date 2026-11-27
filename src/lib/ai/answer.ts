import type { AIProvider } from "./providers/types";
import { buildAnswerPrompt } from "./prompts";

export async function answerQuestion(
  provider: AIProvider,
  question: string,
  prTitle: string,
  prBody: string,
  diff: string,
  reviewSummary: string
): Promise<string> {
  const prompt = buildAnswerPrompt(question, prTitle, prBody, diff, reviewSummary);
  return provider.generate(prompt);
}
