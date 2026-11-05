import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    coverage: { provider: "v8", include: ["src/**/*.ts"], exclude: ["src/infrastructure/db/schema/**", "src/app/**"] },
  },
});
