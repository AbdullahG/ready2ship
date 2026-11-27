import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SCANNED = ["src", "scripts", "public", "test", "docs/self-host.md", "docs/deploy-with-claude.md", "docs/testing.md", "docs/product-context.md", "Dockerfile", "README.md", "CONTRIBUTING.md", "SECURITY.md", ".env.example", "package.json", "docker-compose.yml"];

function files(path: string): string[] {
  const abs = join(ROOT, path);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs).flatMap((name) => files(join(path, name)));
}

const all = SCANNED.flatMap(files).filter((f) => !/\.(ico|png|jpg)$/.test(f));

describe("repository hygiene", () => {
  it("readsEnvironmentVariablesOnlyThroughTheConfigModule", () => {
    const allowed = new Set(["src/lib/config.ts", "src/instrumentation.ts"]);
    const offenders = all
      .map((f) => relative(ROOT, f))
      .filter((f) => f.startsWith("src/") && !allowed.has(f))
      .filter((f) => readFileSync(join(ROOT, f), "utf-8").includes("process.env"));
    expect(offenders).toEqual([]);
  });

  it("DU-14 usesOnlyTheCurrentGeminiSdk", () => {
    const offenders = all
      .filter((f) => readFileSync(f, "utf-8").includes(["@google", "generative-ai"].join("/")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
    expect(readFileSync(join(ROOT, "package.json"), "utf-8")).toContain('"@google/genai"');
  });

  it("U-08 keepsPipelineModulesSmall", () => {
    expect(existsSync(join(ROOT, "src/lib/github/review-pipeline.ts"))).toBe(false);
    const dir = join(ROOT, "src/lib/github/pipeline");
    const tooLong = readdirSync(dir)
      .map((name) => ({ name, lines: readFileSync(join(dir, name), "utf-8").split("\n").length }))
      .filter(({ lines }) => lines > 300);
    expect(tooLong).toEqual([]);
  });
});
