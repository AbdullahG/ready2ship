// Per-repository review settings, read from `.ready2ship.yml` on the
// repository's default branch. This file is the only place they are set:
// not env, not the dashboard. Anything it leaves out gets the defaults below.
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";

export const REPO_CONFIG_PATH = ".ready2ship.yml";

export type ReviewMode = "lookout" | "dive";

export interface DiveLimits {
  /** Gemini models for Dive, tried in order. Empty = the instance's GEMINI_MODELS. */
  models: string[];
  maxToolCalls: number;
  /** Distinct files the agent may read. */
  maxFiles: number;
  maxLinesPerFile: number;
  /** Input tokens summed over every model call of one review. */
  maxInputTokens: number;
}

export const DIVE_DEFAULTS: Readonly<DiveLimits> = Object.freeze({
  models: [],
  maxToolCalls: 50,
  maxFiles: 100,
  maxLinesPerFile: 5000,
  maxInputTokens: 2_000_000,
});

export interface RepoConfig {
  mode: ReviewMode;
  include: string[];
  exclude: string[];
  dive: DiveLimits;
  /** "default" when the repository has no .ready2ship.yml. */
  source: "file" | "default";
  /** Unknown keys, reported on the PR but not fatal. */
  warnings: string[];
}

export type RepoConfigResult = { ok: true; config: RepoConfig } | { ok: false; error: string };

const MODE_ALIASES: Record<string, ReviewMode> = { lookout: "lookout", quick: "lookout", dive: "dive", deep: "dive" };

/** "dive", "deep" → dive; "lookout", "quick" → lookout; anything else → null. */
export function normalizeMode(value: string): ReviewMode | null {
  return MODE_ALIASES[value.trim().toLowerCase()] ?? null;
}

class ConfigError extends Error {}

const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function stringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    throw new ConfigError(`${key} must be a list of non-empty strings`);
  }
  return value.map((v: string) => v.trim());
}

function positiveInt(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${key} must be a whole number of 1 or more`);
  }
  return value;
}

function section(root: Record<string, unknown>, name: string, known: string[], warnings: string[]): Record<string, unknown> {
  const value = root[name];
  if (value === undefined || value === null) return {};
  if (!isMapping(value)) throw new ConfigError(`${name} must be a mapping`);
  for (const key of Object.keys(value)) if (!known.includes(key)) warnings.push(`unknown key ${name}.${key}`);
  return value;
}

/** Parses the file's text; null means the repository has no file. */
export function parseRepoConfig(text: string | null): RepoConfigResult {
  const config: RepoConfig = {
    mode: "lookout",
    include: [],
    exclude: [],
    dive: { ...DIVE_DEFAULTS, models: [] },
    source: text === null ? "default" : "file",
    warnings: [],
  };
  if (text === null) return { ok: true, config };

  let root: unknown;
  try {
    root = parseYaml(text);
  } catch (err) {
    // The parser's first line ends with ":" before a code excerpt; keep just the sentence.
    const first = (err as Error).message.split("\n")[0].replace(/:\s*$/, "");
    return { ok: false, error: `not valid YAML (${first})` };
  }
  if (root === null || root === undefined) return { ok: true, config };

  try {
    if (!isMapping(root)) throw new ConfigError("the file must be a mapping (key: value)");
    // Warnings follow the file's order, so they read top to bottom like the file.
    const known = { review: ["mode", "include", "exclude"], dive: ["models", "maxToolCalls", "maxFiles", "maxLinesPerFile", "maxInputTokens"] };
    const sections: Record<string, Record<string, unknown>> = { review: {}, dive: {} };
    for (const key of Object.keys(root)) {
      if (key === "review" || key === "dive") sections[key] = section(root, key, known[key], config.warnings);
      else config.warnings.push(`unknown key ${key}`);
    }

    const review = sections.review;
    if (review.mode !== undefined) {
      const mode = typeof review.mode === "string" ? normalizeMode(review.mode) : null;
      if (!mode) throw new ConfigError(`review.mode must be lookout or dive (got ${JSON.stringify(review.mode)})`);
      config.mode = mode;
    }
    if (review.include !== undefined) config.include = stringList(review.include, "review.include");
    if (review.exclude !== undefined) config.exclude = stringList(review.exclude, "review.exclude");

    const dive = sections.dive;
    if (dive.models !== undefined) config.dive.models = stringList(dive.models, "dive.models");
    for (const key of ["maxToolCalls", "maxFiles", "maxLinesPerFile", "maxInputTokens"] as const) {
      if (dive[key] !== undefined) config.dive[key] = positiveInt(dive[key], `dive.${key}`);
    }
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, error: err.message };
    throw err;
  }
  return { ok: true, config };
}

/** Whether a repository path is in scope: matches include (if any) and no exclude. */
export function makePathFilter(config: Pick<RepoConfig, "include" | "exclude">): (path: string) => boolean {
  const opts = { dot: true };
  const included = config.include.length > 0 ? picomatch(config.include, opts) : () => true;
  const excluded = config.exclude.length > 0 ? picomatch(config.exclude, opts) : () => false;
  return (path) => included(path) && !excluded(path);
}
