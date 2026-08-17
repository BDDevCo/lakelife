import { defineConfig } from "vitest/config";
import path from "node:path";

// Mirror tsconfig's "@/*" → "src/*" so pure libs under test can import each
// other the same way the app does (Next resolves it; vitest needs this).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `import "server-only"` throws the moment it is loaded outside a server
      // component, which is exactly what it is for — and it also blocks unit
      // testing the modules that carry it. Aliasing it to an empty module lets
      // a pure helper like `must-read` be exercised directly; the real guard
      // still applies in every Next build, which is the only place it matters.
      "server-only": path.resolve(__dirname, "src/test/server-only-stub.ts"),
    },
  },
  test: {
    // Vitest's default excludes cover node_modules but NOT .claude/worktrees,
    // where Claude Code leaves throwaway checkouts of older code. Those carry
    // their own test files, so a stale snapshot was being run alongside the
    // real suite and failing against fixes made since. Tests come from src.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.claude/**"],
  },
});
