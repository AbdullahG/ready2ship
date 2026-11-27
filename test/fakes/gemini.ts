import { FakeHttpServer } from "./http";

// Speaks the Generative Language REST contract used by @google/genai:
// POST /v1[beta]/models/<model>:generateContent and :countTokens, key in the
// x-goog-api-key header. Behaviour is keyed by the API key so a test picks a
// failure mode just by choosing which key the workspace holds.

export const GEMINI_KEYS = {
  valid: "AIza-fake-valid-key-1234",
  invalid: "AIza-fake-INVALID-key-0000",
  quota: "AIza-fake-QUOTA-key-9999",
} as const;

export const DEFAULT_REVIEW = {
  summary: "Adds a greeting helper.",
  findings: [
    {
      severity: "blocker",
      file: "src/greet.ts",
      startLine: 2,
      endLine: 2,
      description: "Possible null dereference on name.",
      suggestion: "Guard against an empty name.",
      fix: { original: "return name.trim();", replacement: "return (name ?? '').trim();" },
    },
  ],
};

/**
 * A scripted model turn: plain text, or tool calls (Gemini's functionCall
 * parts, optionally with a thoughtSignature the client must send back).
 */
export type FakeTurn =
  | string
  | { text?: string; functionCalls?: Array<{ name: string; args: Record<string, unknown> }>; thoughtSignature?: string; promptTokens?: number };

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
  thoughtSignature?: string;
}
export interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

export class FakeGemini {
  readonly http = new FakeHttpServer();
  /** Responses returned in order by generateContent; falls back to DEFAULT_REVIEW. */
  scripted: FakeTurn[] = [];
  /** Models this key may not use: 403 PERMISSION_DENIED. */
  forbiddenModels = new Set<string>();
  /** Models that answer 503, to exercise the fallback chain. */
  failingModels = new Set<string>();
  /** The next N generateContent calls answer 503 whatever the model (a transient outage). */
  outageCalls = 0;
  calls: Array<{
    model: string;
    task: string;
    key: string;
    prompt: string;
    /** Full request: the conversation the client sent, its system prompt and tool names. */
    contents: GeminiContent[];
    system: string;
    tools: string[];
    startedAt: number;
    endedAt?: number;
  }> = [];
  /** Artificial latency for generateContent, to observe overlap between jobs. */
  latencyMs = 0;

  constructor() {
    this.http.on("POST", /^\/v1(?:beta)?\/models\/([^:]+):(generateContent|countTokens)$/, async (req, [model, task]) => {
      const key = String(req.headers["x-goog-api-key"] ?? "");
      const body = req.body as {
        contents?: GeminiContent[];
        systemInstruction?: { parts?: Array<{ text?: string }> };
        tools?: Array<{ functionDeclarations?: Array<{ name: string }> }>;
      };
      const contents = body.contents ?? [];
      const prompt = contents[0]?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const call: FakeGemini["calls"][number] = {
        model,
        task,
        key,
        prompt,
        contents,
        system: body.systemInstruction?.parts?.map((p) => p.text ?? "").join("") ?? "",
        tools: (body.tools ?? []).flatMap((t) => (t.functionDeclarations ?? []).map((f) => f.name)),
        startedAt: Date.now(),
      };
      this.calls.push(call);
      if (task === "generateContent" && this.latencyMs > 0) {
        await new Promise((r) => setTimeout(r, this.latencyMs));
      }
      call.endedAt = Date.now();

      if (key === GEMINI_KEYS.invalid || key === "") {
        return {
          status: 400,
          body: {
            error: {
              code: 400,
              message: "API key not valid. Please pass a valid API key.",
              status: "INVALID_ARGUMENT",
              details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
            },
          },
        };
      }
      if (key === GEMINI_KEYS.quota) {
        return {
          status: 429,
          body: { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } },
        };
      }
      if (task === "generateContent" && this.outageCalls > 0) {
        this.outageCalls--;
        return { status: 503, body: { error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } } };
      }
      if (this.forbiddenModels.has(model)) {
        return { status: 403, body: { error: { code: 403, message: `Permission denied on model ${model}.`, status: "PERMISSION_DENIED" } } };
      }
      if (this.failingModels.has(model)) {
        return { status: 503, body: { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } } };
      }
      if (task === "countTokens") return { body: { totalTokens: Math.ceil(prompt.length / 4) } };

      const turn = this.scripted.shift() ?? JSON.stringify(DEFAULT_REVIEW);
      const t = typeof turn === "string" ? { text: turn } : turn;
      const parts: GeminiPart[] = [
        ...(t.text !== undefined ? [{ text: t.text }] : []),
        ...(t.functionCalls ?? []).map((fc, i) => ({
          functionCall: fc,
          ...(i === 0 && t.thoughtSignature ? { thoughtSignature: t.thoughtSignature } : {}),
        })),
      ];
      // Tokens are estimated from the request size unless the test pins them.
      const promptTokens = t.promptTokens ?? Math.ceil(JSON.stringify(contents).length / 4);
      return {
        body: {
          candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: 10, totalTokenCount: promptTokens + 10 },
        },
      };
    });

    this.http.on("POST", /^\/__control\/reset$/, () => {
      this.reset();
      return { body: { ok: true } };
    });
    this.http.on("POST", /^\/__control\/script$/, (req) => {
      this.scripted.push(...(req.body as { responses: FakeTurn[] }).responses);
      return { body: { ok: true } };
    });
    this.http.on("GET", /^\/__control\/calls$/, () => ({ body: this.calls }));
    this.http.on("POST", /^\/__control\/latency$/, (req) => {
      this.latencyMs = (req.body as { ms: number }).ms;
      return { body: { ok: true } };
    });
  }

  start(port?: number) {
    return this.http.start(port);
  }
  stop() {
    return this.http.stop();
  }
  get url() {
    return this.http.url;
  }

  /** Calls that actually generated text (excludes key validation). */
  get generateCalls() {
    return this.calls.filter((c) => c.task === "generateContent");
  }

  reset(): void {
    this.scripted = [];
    this.failingModels.clear();
    this.forbiddenModels.clear();
    this.outageCalls = 0;
    this.latencyMs = 0;
    this.calls = [];
    this.http.requests.length = 0;
  }
}
