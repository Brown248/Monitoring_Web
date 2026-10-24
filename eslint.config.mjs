import js from "@eslint/js";
import nextVitals from "eslint-config-next/core-web-vitals";
import prettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const WEB_FILES = ["apps/web/**/*.{js,jsx,mjs,ts,tsx}"];

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/next-env.d.ts",
      "packages/db/migrations/**",
      // เครื่องมือของ Stack Agent ที่ copy มา (init.mjs เขียนทับทุกครั้ง) และผลการ verify
      ".stack-agent/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  // กฎของ Next ใช้เฉพาะใน apps/web
  ...nextVitals.map((config) => ({ ...config, files: WEB_FILES })),
  { files: WEB_FILES, settings: { next: { rootDir: "apps/web/" } } },
  // สคริปต์ Node ที่ root (dev-db, start-web, verify-env, verify-login-flow)
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        fetch: "readonly",
        URL: "readonly",
        AbortSignal: "readonly",
      },
    },
  },
  prettier,
);
