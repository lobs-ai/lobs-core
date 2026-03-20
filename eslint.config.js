import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript rules
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/ban-ts-comment": "warn",

      // General rules - tuned for our codebase
      "no-console": "off",
      "prefer-const": "warn",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "no-useless-assignment": "warn",
      "no-extra-boolean-cast": "warn",
      "no-misleading-character-class": "warn",
      "no-case-declarations": "warn",
      "no-unsafe-finally": "error",
      "no-useless-catch": "warn",
      "preserve-caught-error": "off",
    },
  },
  {
    ignores: [
      "dist/",
      "node_modules/",
      "tests/",
      "*.config.js",
      "*.config.ts",
    ],
  },
);
