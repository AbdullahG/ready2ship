import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: unknown;
  rawBody: string;
  /** The body's bytes, for binary protocols (git). */
  rawBuffer: Buffer;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Sent as-is instead of JSON-encoding `body`. */
  raw?: Buffer;
}

export type Handler = (req: FakeRequest, params: string[]) => FakeResponse | Promise<FakeResponse>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

/** Tiny router so fakes read like the real API's route table. */
export class FakeHttpServer {
  private routes: Route[] = [];
  private server: Server | null = null;
  readonly requests: FakeRequest[] = [];
  /** Runs before routing; a non-null response short-circuits (fault injection). */
  before: ((req: FakeRequest) => FakeResponse | null) | null = null;
  /** Milliseconds to wait before answering (0 = immediately). */
  delay: () => number = () => 0;
  url = "";

  on(method: string, pattern: RegExp, handler: Handler): void {
    this.routes.push({ method, pattern, handler });
  }

  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    // Outlive the client's idle sockets (undici closes after 4 s). With Node's
    // 5 s default, a test that blocks the event loop (e.g. building a git repo
    // with execFileSync) can reuse a socket the server is closing: ECONNRESET.
    this.server.keepAliveTimeout = 120_000;
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    const { port: actual } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${actual}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBuffer = Buffer.concat(chunks);
    const rawBody = rawBuffer.toString("utf-8");
    const url = new URL(req.url ?? "/", "http://fake");
    let body: unknown = rawBody;
    const contentType = req.headers["content-type"] ?? "";
    if (rawBody && contentType.includes("json")) body = JSON.parse(rawBody);
    else if (rawBody && contentType.includes("x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(rawBody));
    }

    const request: FakeRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
      rawBody,
      rawBuffer,
    };
    if (!url.pathname.startsWith("/__control")) this.requests.push(request);

    const route = this.routes.find(
      (r) => r.method === request.method && r.pattern.test(url.pathname)
    );
    let out: FakeResponse;
    const injected = this.before?.(request) ?? null;
    try {
      out =
        injected ??
        (route
          ? await route.handler(request, url.pathname.match(route.pattern)!.slice(1))
          : { status: 404, body: { message: `fake: no route for ${request.method} ${url.pathname}` } });
    } catch (err) {
      out = { status: 500, body: { message: (err as Error).message } };
    }

    const wait = this.delay();
    if (wait > 0 && !url.pathname.startsWith("/__control")) await new Promise((r) => setTimeout(r, wait));
    if (res.destroyed) return;
    const status = out.status ?? 200;
    if (out.raw) {
      res.writeHead(status, out.headers ?? {});
      res.end(out.raw);
      return;
    }
    const headers = { "content-type": "application/json", ...out.headers };
    res.writeHead(status, headers);
    res.end(out.body === undefined ? "" : JSON.stringify(out.body));
  }
}
