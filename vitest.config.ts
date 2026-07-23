import { defineConfig } from "vitest/config";
import path from "node:path";

// Mirror tsconfig's "@/*" → "src/*" so pure libs under test can import each
// other the same way the app does (Next resolves it; vitest needs this).
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
