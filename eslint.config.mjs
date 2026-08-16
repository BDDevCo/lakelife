import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  {
    rules: {
      /**
       * AN UNDERSCORE ALREADY MEANS "I KNOW, AND I MEANT IT".
       *
       * The codebase writes `_val`, `_op`, `_to`, `_body`, `_today` where a
       * signature needs a parameter it does not use — a test double matching
       * the real function's shape, a callback that only wants its second
       * argument. That is the usual convention and it is the clearest thing
       * available: deleting the parameter would change the signature, and
       * renaming it would lose the documentation of what that position is.
       *
       * The linter simply was not told. Flagging five deliberate underscores
       * as mistakes trains people to ignore the rule, which costs far more
       * than the five warnings are worth — the SAME reasoning as leaving lint
       * advisory in CI until the list is clean.
       *
       * `caughtErrors: "all"` keeps `catch (e)` honest: an error you bind and
       * never look at is a real omission, not a convention.
       */
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        caughtErrors: "all",
        ignoreRestSiblings: true,
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
