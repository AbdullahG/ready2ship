export type KeyValidation = { ok: true } | { ok: false; reason: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * One turn of a tool-using conversation. A model turn keeps the provider's
 * own message (`raw`) so it is sent back unchanged: Gemini attaches thought
 * signatures to function calls and rejects a history that drops them.
 */
export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "model"; raw: unknown }
  | {
      role: "tool";
      results: Array<{ id?: string; name: string; response: Record<string, unknown> }>;
      /** Text sent alongside the results, e.g. a budget warning. */
      note?: string;
    };

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDeclaration[];
}

export interface ChatResponse {
  /** The model's text, or null when it only called tools. */
  text: string | null;
  toolCalls: ToolCall[];
  /** Append this to `messages` before sending the tool results. */
  message: ChatMessage;
  usage: TokenUsage;
}

/**
 * One AI backend bound to one API key. Adding a provider (Anthropic, OpenAI)
 * means implementing this and choosing it in getProviderForWorkspace.
 */
export interface AIProvider {
  /** Returns trimmed text. Throws InvalidKeyError, QuotaError or Error. */
  generate(prompt: string): Promise<string>;
  /** generate() plus the tokens it used. */
  generateWithUsage(prompt: string): Promise<{ text: string; usage: TokenUsage }>;
  /** One step of a tool-using conversation. Throws like generate(). */
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Cheap call that proves the key works, without spending generation quota. */
  validateKey(): Promise<KeyValidation>;
}
