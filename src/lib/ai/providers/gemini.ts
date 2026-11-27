import { ApiError, GoogleGenAI, type Content, type GenerateContentResponse } from "@google/genai";
import { InvalidKeyError, QuotaError } from "../errors";
import type { AIProvider, ChatMessage, ChatRequest, ChatResponse, KeyValidation, TokenUsage } from "./types";

type ErrorKind = "invalid_key" | "quota" | "other";
type ErrorBody = { message?: string; details?: Array<{ reason?: string }> };

// The SDK's ApiError message is the raw error body as JSON:
// {"error":{"code":400,"message":"...","status":"...","details":[...]}}.
function errorBody(err: unknown): ErrorBody | null {
  if (!(err instanceof ApiError)) return null;
  try {
    return (JSON.parse(err.message) as { error?: ErrorBody }).error ?? null;
  } catch {
    return null;
  }
}

function classify(err: unknown): ErrorKind {
  if (!(err instanceof ApiError)) return "other";
  if (err.status === 429) return "quota";
  if (err.status === 401 || err.status === 403) return "invalid_key";
  if (err.status === 400 && (errorBody(err)?.details ?? []).some((d) => d.reason === "API_KEY_INVALID")) return "invalid_key";
  return "other";
}

/** The provider's own message, without HTTP status, URL or raw JSON, safe to show users. */
function cleanMessage(err: unknown): string {
  return errorBody(err)?.message ?? ((err as Error)?.message ?? String(err)).trim();
}

function usageOf(res: GenerateContentResponse): TokenUsage {
  return {
    inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
    // Thinking tokens are billed as output too.
    outputTokens: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
  };
}

function toContents(messages: ChatMessage[]): Content[] {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", parts: [{ text: m.text }] };
    if (m.role === "model") return m.raw as Content;
    return {
      role: "user",
      parts: [
        ...m.results.map((r) => ({ functionResponse: { id: r.id, name: r.name, response: r.response } })),
        ...(m.note ? [{ text: m.note }] : []),
      ],
    };
  });
}

export class GeminiProvider implements AIProvider {
  private client: GoogleGenAI;
  /** The first model that answered; later calls try it first so one run stays on one model. */
  private pinned: string | null = null;

  constructor(private opts: { apiKey: string; models: string[]; baseUrl?: string | null; timeoutMs?: number }) {
    this.client = new GoogleGenAI({
      apiKey: opts.apiKey,
      httpOptions: {
        // A hung call would hold its PR's job (and a worker slot) forever.
        timeout: opts.timeoutMs ?? 120_000,
        // The job queue owns retries; the SDK must not retry on its own.
        retryOptions: { attempts: 1 },
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      },
    });
  }

  private modelOrder(): string[] {
    const { models } = this.opts;
    return this.pinned ? [this.pinned, ...models.filter((m) => m !== this.pinned)] : models;
  }

  /** Tries each model in order; a rejected key stops at once since every model shares it. */
  private async withFallback<T>(call: (model: string) => Promise<T | null>): Promise<T> {
    const models = this.modelOrder();
    let lastError: unknown;
    let sawQuota = false;

    for (const name of models) {
      try {
        const result = await call(name);
        if (result !== null) {
          if (name !== models[0]) console.log(`Used fallback model: ${name}`);
          this.pinned ??= name;
          return result;
        }
      } catch (err) {
        const kind = classify(err);
        if (kind === "invalid_key") throw new InvalidKeyError(cleanMessage(err));
        if (kind === "quota") sawQuota = true;
        console.warn(`Model ${name} failed:`, cleanMessage(err));
        lastError = err;
      }
    }

    if (sawQuota) throw new QuotaError(cleanMessage(lastError));
    throw new Error(`All Gemini models failed. Last error: ${lastError ? cleanMessage(lastError) : "empty response"}`);
  }

  async generate(prompt: string): Promise<string> {
    return (await this.generateWithUsage(prompt)).text;
  }

  async generateWithUsage(prompt: string): Promise<{ text: string; usage: TokenUsage }> {
    return this.withFallback(async (model) => {
      const res = await this.client.models.generateContent({ model, contents: prompt });
      const text = res.text;
      return text ? { text: text.trim(), usage: usageOf(res) } : null;
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const tools = req.tools.length
      ? [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }]
      : undefined;
    return this.withFallback(async (model) => {
      const res = await this.client.models.generateContent({
        model,
        contents: toContents(req.messages),
        config: { systemInstruction: req.system, ...(tools ? { tools } : {}) },
      });
      const content = res.candidates?.[0]?.content;
      if (!content?.parts?.length) return null;
      const toolCalls = (res.functionCalls ?? []).map((c) => ({ id: c.id, name: c.name ?? "", args: c.args ?? {} }));
      const text = content.parts
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text)
        .join("")
        .trim();
      return {
        text: text || null,
        toolCalls,
        message: { role: "model", raw: { role: "model", parts: content.parts } },
        usage: usageOf(res),
      };
    });
  }

  async validateKey(): Promise<KeyValidation> {
    try {
      await this.client.models.countTokens({ model: this.opts.models[0], contents: "ping" });
      return { ok: true };
    } catch (err) {
      const kind = classify(err);
      if (kind === "quota") return { ok: true };
      if (kind === "invalid_key") return { ok: false, reason: `Google rejected this key: ${cleanMessage(err)}` };
      return { ok: false, reason: `Couldn't reach Gemini to check the key, try again: ${cleanMessage(err)}` };
    }
  }
}
