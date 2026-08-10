import { defineConfig } from "vitest/config";
import path from "node:path";

// Mirror tsconfig's "@/*" → "src/*" so pure libs under test can import each
// other the same way the app does (Next resolves it; vitest needs this).
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    // Vitest's default excludes cover node_modules but NOT .claude/worktrees,
    // where Claude Code leaves throwaway checkouts of older code. Those carry
    // their own test files, so a stale snapshot was being run alongside the
    // real suite and failing against fixes made since. Tests come from src.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.claude/**"],
  },
});
