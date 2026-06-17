import tseslint from "typescript-eslint";

/**
 * Spec 0003 §3.4.6 — strict lint, scoped to exactly the three rules the spec
 * calls out: no-any, prefer-const, no-unused-vars. We deliberately do NOT pull
 * in js.configs.recommended or the typescript-eslint recommended set: in a
 * TS-strict codebase most of those (no-undef, no-irregular-whitespace, …) are
 * either redundant with the compiler or pure noise (the BOM-strip regexes trip
 * no-irregular-whitespace). Keep the lint signal high.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "**/*.js", "**/*.mjs"] },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: "module",
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "prefer-const": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);
