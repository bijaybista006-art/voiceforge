import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  // tsconfig keeps JSX for Next ("preserve"); tests compile it themselves.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["lib/__tests__/**/*.test.ts", "components/__tests__/**/*.test.tsx"],
  },
});
