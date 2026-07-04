// ESLint flat config（Next.js 16 起移除 next lint，改用 ESLint CLI；
// 設定方式依 node_modules/next/dist/docs/01-app/03-api-reference/05-config/03-eslint.md）
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // 底線開頭的參數視為「刻意不使用」：介面實作常有用不到的參數
      // （例：VTOProvider.checkStatus 的 _ctx 只有 mock provider 需要）
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  globalIgnores([
    // eslint-config-next 的預設忽略清單
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Claude Code 的背景任務會在這裡建立暫時 worktree（整份 repo 的舊版副本），
    // 不忽略的話 eslint . 會把裡面的程式碼也算進來
    ".claude/**",
  ]),
]);

export default eslintConfig;
