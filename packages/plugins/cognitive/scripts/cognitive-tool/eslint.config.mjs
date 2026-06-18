// Local-only flat config: enables ONLY the cognitive-complexity rule from
// eslint-plugin-sonarjs, matching the threshold SonarCloud applies on PR.
// Loaded explicitly by check-cognitive.sh with --no-config-lookup so it does
// not interfere with the host project's own eslint config.
import sonarjs from "eslint-plugin-sonarjs";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { sonarjs },
    rules: {
      // SonarCloud SonarWay default is 15.
      "sonarjs/cognitive-complexity": ["error", 15],
    },
  },
];
