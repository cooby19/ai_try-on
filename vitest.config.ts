// Vitest 設定：測試對象是 src/lib 下的純後端邏輯，因此用 node 環境即可，
// 不需要 jsdom。alias 對應 tsconfig 的 "@/*" → "./src/*"。
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
