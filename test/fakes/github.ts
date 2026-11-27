import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import { FakeHttpServer, type FakeRequest, type FakeResponse } from "./http";
import { buildGitRepo, gitShow, gitTree, type GitRepo, type GitRepoSpec } from "./git-repo";

// Speaks the subset of the GitHub REST + OAuth web contract that Ready2Ship
// uses. API routes live under /api, web (OAuth) routes under /web, so the app
// is configured with GITHUB_API_URL=<url>/api and GITHUB_WEB_URL=<url>/web.
// /__control/* endpoints let out-of-process tests (Playwright) script state.
// Git over HTTP (clone/fetch) is served by the real `git http-backend` under
// /web/<owner>/<repo>.git, behind the same installation-token check GitHub does.

export interface FakeUser {
  id: number;
  login: string;
  avatar_url: string;
}

export interface FakeInstallation {
  id: number;
  account: { id: number; login: string; type: "User" | "Organization" };
  /** Logins that GET /user/installations lists this installation for. */
  accessibleBy: string[];
}

export interface FakePRFile {
  filename: string;
  status: string;
  patch?: string;
  additions: number;
  deletions: number;
}

interface PostedComment {
  id: number;
  kind: "issue" | "review" | "reply";
  repo: string;
  issueNumber?: number;
  body: string;
  path?: string;
  line?: number | null;
  reviewId?: number;
}

export interface FakeRepo {
  defaultBranch: string;
  /** Repository size in KB, as GET /repos/{repo} reports it. */
  sizeKb: number;
}

let nextId = 1000;

export class FakeGitHub {
  readonly http = new FakeHttpServer();
  users = new Map<string, FakeUser>();
  installations = new Map<number, FakeInstallation>();
  userTokens = new Map<string, string>();
  expiredTokens = new Set<string>();
  prFiles = new Map<string, FakePRFile[]>();
  fileContents = new Map<string, { content: string; sha: string }>();
  /** Repo metadata; a repo not listed here answers as `main`, 100 KB. */
  repos = new Map<string, FakeRepo>();
  /** Bare git repositories served over HTTP and read by the tree/contents endpoints. */
  gitRepos = new Map<string, string>();
  /** Authorization headers seen on git HTTP requests (to check how the app authenticates). */
  gitAuthHeaders: string[] = [];
  /** GET /repos/{repo}/pulls/{n} bodies, keyed "owner/repo#n". */
  pulls = new Map<string, Record<string, unknown>>();
  /** Repos built through /__control/git-repo, removed on reset. */
  private builtRepos: GitRepo[] = [];
  /** Git HTTP requests answer 500 while set (to exercise the clone fallback). */
  gitDown = false;
  comments: PostedComment[] = [];
  reviews: Array<{ id: number; repo: string; prNumber: number; event: string; body: string }> = [];
  commits: Array<{ repo: string; path: string; content: string; branch: string; message: string }> = [];
  /** Upcoming requests matching method + path regex fail with `status` (500 by default; count per rule). */
  failures: Array<{ method: string; path: RegExp; remaining: number; status?: number }> = [];
  /** Delay every API response (to exercise client timeouts). */
  delayMs = 0;
  /** Login the fake OAuth "authorize" page signs in as. */
  nextOAuthLogin: string | null = null;

  constructor() {
    const h = this.http;
    h.delay = () => this.delayMs;
    h.before = (req) => {
      const rule = this.failures.find((f) => f.remaining > 0 && f.method === req.method && f.path.test(req.path));
      if (!rule) return null;
      rule.remaining--;
      return { status: rule.status ?? 500, body: { message: "fake: injected failure" } };
    };

    // ── OAuth web flow ──
    h.on("GET", /^\/web\/login\/oauth\/authorize$/, (req) => {
      const login = this.nextOAuthLogin;
      if (!login) return { status: 400, body: { message: "fake: nextOAuthLogin not set" } };
      const redirect = new URL(req.query.get("redirect_uri")!);
      redirect.searchParams.set("code", `code-${login}`);
      redirect.searchParams.set("state", req.query.get("state") ?? "");
      return { status: 302, headers: { location: redirect.toString() } };
    });
    h.on("POST", /^\/web\/login\/oauth\/access_token$/, (req) => {
      const code = (req.body as { code?: string }).code ?? "";
      const login = code.replace(/^code-/, "");
      if (!this.users.has(login)) return { body: { error: "bad_verification_code" } };
      const token = `utok-${login}-${nextId++}`;
      this.userTokens.set(token, login);
      return { body: { access_token: token, token_type: "bearer" } };
    });

    // ── App / installation auth ──
    h.on("POST", /^\/api\/app\/installations\/(\d+)\/access_tokens$/, (_req, [id]) => {
      if (!this.installations.has(Number(id))) return { status: 404, body: { message: "Not Found" } };
      return {
        status: 201,
        body: { token: `inst-${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
      };
    });

    // ── User-token endpoints ──
    h.on("GET", /^\/api\/user$/, (req) => {
      const login = this.userFromToken(req);
      if (!login) return { status: 401, body: { message: "Bad credentials" } };
      return { body: this.users.get(login) };
    });
    h.on("GET", /^\/api\/user\/installations$/, (req) => {
      const login = this.userFromToken(req);
      if (!login) return { status: 401, body: { message: "Bad credentials" } };
      const list = [...this.installations.values()]
        .filter((i) => i.accessibleBy.includes(login))
        .map((i) => ({ id: i.id, account: i.account }));
      return { body: { total_count: list.length, installations: list } };
    });
    h.on("GET", /^\/api\/users\/([^/]+)$/, (_req, [login]) => {
      const user = [...this.users.values()].find(
        (u) => u.login.toLowerCase() === decodeURIComponent(login).toLowerCase()
      );
      return user ? { body: user } : { status: 404, body: { message: "Not Found" } };
    });

    // ── Repo endpoints (installation token) ──
    h.on("GET", /^\/api\/repos\/([^/]+\/[^/]+)$/, (_req, [repo]) => {
      const r = this.repoInfo(repo);
      return { body: { full_name: repo, default_branch: r.defaultBranch, size: r.sizeKb } };
    });
    h.on("GET", /^\/api\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/, (_req, [repo, n]) => {
      const pr = this.pulls.get(`${repo}#${n}`);
      return pr ? { body: pr } : { status: 404, body: { message: "Not Found" } };
    });
    h.on("POST", /^\/api\/repos\/[^/]+\/[^/]+\/pulls\/comments\/\d+\/reactions$/, () => ({ status: 201, body: {} }));
    h.on("GET", /^\/api\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/, (_req, [repo, n]) => ({
      body: this.prFiles.get(`${repo}#${n}`) ?? [],
    }));
    h.on("POST", /^\/api\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/, (req, [repo, n]) => {
      const c: PostedComment = {
        id: nextId++,
        kind: "issue",
        repo,
        issueNumber: Number(n),
        body: (req.body as { body: string }).body,
      };
      this.comments.push(c);
      return { status: 201, body: { id: c.id, body: c.body } };
    });
    h.on("PATCH", /^\/api\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/, (req, [, id]) => {
      const c = this.comments.find((x) => x.id === Number(id));
      if (!c) return { status: 404, body: { message: "Not Found" } };
      c.body = (req.body as { body: string }).body;
      return { body: { id: c.id, body: c.body } };
    });
    h.on("POST", /^\/api\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/, (req, [repo, n]) => {
      const b = req.body as {
        event: string;
        body: string;
        comments?: Array<{ path: string; line: number; body: string }>;
      };
      const id = nextId++;
      this.reviews.push({ id, repo, prNumber: Number(n), event: b.event, body: b.body });
      for (const c of b.comments ?? []) {
        this.comments.push({ id: nextId++, kind: "review", repo, body: c.body, path: c.path, line: c.line, reviewId: id });
      }
      return { body: { id } };
    });
    h.on("GET", /^\/api\/repos\/([^/]+\/[^/]+)\/pulls\/\d+\/reviews\/(\d+)\/comments$/, (_req, [, rid]) => ({
      body: this.comments
        .filter((c) => c.reviewId === Number(rid))
        .map((c) => ({ id: c.id, body: c.body, path: c.path, line: c.line })),
    }));
    h.on("POST", /^\/api\/repos\/([^/]+\/[^/]+)\/pulls\/\d+\/comments\/(\d+)\/replies$/, (req, [repo]) => {
      const c: PostedComment = { id: nextId++, kind: "reply", repo, body: (req.body as { body: string }).body };
      this.comments.push(c);
      return { status: 201, body: { id: c.id } };
    });
    h.on("POST", /^\/api\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+\/reactions$/, () => ({ status: 201, body: {} }));
    h.on("GET", /^\/api\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/, (req, [repo, path]) => {
      const ref = req.query.get("ref") ?? "";
      const decoded = decodeURIComponent(path);
      const f = this.fileContents.get(`${repo}:${decoded}@${ref}`);
      if (f) return { body: { type: "file", sha: f.sha, content: Buffer.from(f.content).toString("base64") } };
      const gitDir = this.gitRepos.get(repo);
      const text = gitDir ? gitShow(gitDir, ref || this.repoInfo(repo).defaultBranch, decoded) : null;
      if (text === null) return { status: 404, body: { message: "Not Found" } };
      return { body: { type: "file", sha: `blob-${nextId++}`, content: Buffer.from(text).toString("base64") } };
    });
    h.on("GET", /^\/api\/repos\/([^/]+\/[^/]+)\/git\/trees\/(.+)$/, (_req, [repo, ref]) => {
      const gitDir = this.gitRepos.get(repo);
      if (!gitDir) return { status: 404, body: { message: "Not Found" } };
      return { body: { sha: ref, tree: gitTree(gitDir, decodeURIComponent(ref)), truncated: false } };
    });
    h.on("PUT", /^\/api\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/, (req, [repo, path]) => {
      const b = req.body as { content: string; branch: string; message: string };
      this.commits.push({
        repo,
        path: decodeURIComponent(path),
        branch: b.branch,
        message: b.message,
        content: Buffer.from(b.content, "base64").toString("utf-8"),
      });
      return { body: { commit: { sha: `sha-${nextId++}` } } };
    });

    // ── Git smart HTTP (clone/fetch with an installation token) ──
    for (const method of ["GET", "POST"]) {
      h.on(method, /^\/web\/([^/]+\/[^/]+)\.git(\/.*)$/, (req, [repo, rest]) => this.serveGit(req, repo, rest));
    }

    // ── Control (out-of-process tests) ──
    h.on("POST", /^\/__control\/reset$/, () => {
      this.reset();
      return { body: { ok: true } };
    });
    h.on("POST", /^\/__control\/user$/, (req) => ({ body: this.addUser((req.body as { login: string }).login) }));
    h.on("POST", /^\/__control\/oauth-login$/, (req) => {
      this.nextOAuthLogin = (req.body as { login: string }).login;
      return { body: { ok: true } };
    });
    h.on("POST", /^\/__control\/installation$/, (req) => ({ body: this.addInstallation(req.body as Parameters<FakeGitHub["addInstallation"]>[0]) }));
    h.on("POST", /^\/__control\/pr-files$/, (req) => {
      const b = req.body as { repo: string; number: number; files: FakePRFile[] };
      this.prFiles.set(`${b.repo}#${b.number}`, b.files);
      return { body: { ok: true } };
    });
    h.on("POST", /^\/__control\/expire-tokens$/, (req) => {
      const login = (req.body as { login: string }).login;
      for (const [t, l] of this.userTokens) if (l === login) this.expiredTokens.add(t);
      return { body: { ok: true } };
    });
    h.on("POST", /^\/__control\/git-repo$/, (req) => {
      const b = req.body as { repo: string; spec: GitRepoSpec };
      const built = buildGitRepo(b.spec);
      this.builtRepos.push(built);
      this.gitRepos.set(b.repo, built.gitDir);
      const heads = Object.fromEntries(Object.keys(b.spec.pulls ?? {}).map((n) => [n, built.headSha(Number(n))]));
      return { body: { heads } };
    });
    h.on("POST", /^\/__control\/pull$/, (req) => {
      const b = req.body as { repo: string; pr: { number: number } & Record<string, unknown> };
      this.setPull(b.repo, b.pr);
      return { body: { ok: true } };
    });
    h.on("GET", /^\/__control\/comments$/, () => ({ body: this.comments }));
    h.on("GET", /^\/__control\/reviews$/, () => ({ body: this.reviews }));
  }

  start(port?: number) {
    return this.http.start(port);
  }
  stop() {
    return this.http.stop();
  }
  get apiUrl() {
    return `${this.http.url}/api`;
  }
  get webUrl() {
    return `${this.http.url}/web`;
  }

  reset(): void {
    this.users.clear();
    this.installations.clear();
    this.userTokens.clear();
    this.expiredTokens.clear();
    this.prFiles.clear();
    this.fileContents.clear();
    this.repos.clear();
    this.pulls.clear();
    this.gitRepos.clear();
    for (const r of this.builtRepos) r.cleanup();
    this.builtRepos = [];
    this.gitAuthHeaders = [];
    this.gitDown = false;
    this.comments = [];
    this.reviews = [];
    this.commits = [];
    this.nextOAuthLogin = null;
    this.failures = [];
    this.delayMs = 0;
    this.http.requests.length = 0;
  }

  /** Runs `git http-backend` for one request, like GitHub's git endpoint. */
  private async serveGit(req: FakeRequest, repo: string, rest: string): Promise<FakeResponse> {
    const auth = String(req.headers.authorization ?? "");
    this.gitAuthHeaders.push(auth);
    if (this.gitDown) return { status: 500, body: { message: "fake: git unavailable" } };
    const gitDir = this.gitRepos.get(repo);
    if (!gitDir) return { status: 404, body: { message: "Not Found" } };
    const [user, token] = Buffer.from(auth.replace(/^Basic\s+/i, ""), "base64").toString().split(":");
    const installationId = Number(/^inst-(\d+)$/.exec(token ?? "")?.[1]);
    if (user !== "x-access-token" || !this.installations.has(installationId)) {
      return { status: 401, headers: { "www-authenticate": 'Basic realm="GitHub"' }, raw: Buffer.from("bad credentials") };
    }

    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: dirname(gitDir),
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: `/${basename(gitDir)}${rest}`,
        QUERY_STRING: req.query.toString(),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
        HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
        GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stdin.end(req.rawBuffer);
    await new Promise((resolve) => child.on("close", resolve));

    // CGI output: headers, blank line, body.
    const all = Buffer.concat(out);
    const split = all.indexOf("\r\n\r\n");
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of all.subarray(0, split).toString().split("\r\n")) {
      const i = line.indexOf(":");
      const name = line.slice(0, i).trim().toLowerCase();
      const value = line.slice(i + 1).trim();
      if (name === "status") status = Number(value.split(" ")[0]);
      else if (name) headers[name] = value;
    }
    return { status, headers, raw: all.subarray(split + 4) };
  }

  setPull(repo: string, pr: { number: number } & Record<string, unknown>): void {
    this.pulls.set(`${repo}#${pr.number}`, { state: "open", ...pr });
  }

  repoInfo(repo: string): FakeRepo {
    return this.repos.get(repo) ?? { defaultBranch: "main", sizeKb: 100 };
  }

  /** Puts a file on a branch (or sha) so GET /contents/{path}?ref= returns it. */
  putFile(repo: string, path: string, ref: string, content: string): void {
    this.fileContents.set(`${repo}:${path}@${ref}`, { content, sha: `blob-${nextId++}` });
  }

  addUser(login: string): FakeUser {
    const existing = this.users.get(login);
    if (existing) return existing;
    const user = { id: nextId++, login, avatar_url: `https://avatars.example/${login}.png` };
    this.users.set(login, user);
    return user;
  }

  /** Issues a user token directly (integration tests that skip the OAuth dance). */
  tokenFor(login: string): string {
    this.addUser(login);
    const token = `utok-${login}-${nextId++}`;
    this.userTokens.set(token, login);
    return token;
  }

  addInstallation(input: {
    id: number;
    accountLogin: string;
    accountType?: "User" | "Organization";
    accountId?: number;
    accessibleBy?: string[];
  }): FakeInstallation {
    const inst: FakeInstallation = {
      id: input.id,
      account: { id: input.accountId ?? input.id * 10, login: input.accountLogin, type: input.accountType ?? "Organization" },
      accessibleBy: input.accessibleBy ?? [],
    };
    this.installations.set(inst.id, inst);
    return inst;
  }

  private userFromToken(req: FakeRequest): string | null {
    const auth = String(req.headers.authorization ?? "");
    const token = auth.replace(/^(bearer|token)\s+/i, "");
    if (this.expiredTokens.has(token)) return null;
    return this.userTokens.get(token) ?? null;
  }
}
