import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["test/integration/**/*.int.test.ts"],
          setupFiles: ["test/integration/setup.ts"],
          // One in-memory mongod + fake servers per file; files run in parallel workers.
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
