import type { FakeGitHub } from "../fakes/github";
import type { FakeGemini } from "../fakes/gemini";

/** Handles to the per-file fakes started in setup.ts. */
export const testEnv = {} as { github: FakeGitHub; gemini: FakeGemini };
