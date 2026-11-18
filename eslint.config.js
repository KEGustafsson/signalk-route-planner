const js = require("@eslint/js");
const globals = require("globals");
const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");

// Import-boundary rule: a module may import only its own layer or layers
// BELOW it:
//   foundation < oracle < search < plan < api
// `src/index.ts` (plugin entry) sits above all of them, so no layer imports
// it. Patterns for directories that do not exist yet are inert until they
// are created.
const LAYERS = ["foundation", "oracle", "search", "plan", "api"];
// `..` from a layer directory, or a path ending in `index`, is the plugin entry.
const ENTRY = {
  regex: "^(\\.\\./)*\\.\\.$|(^|/)index(\\.[jt]s)?$",
  message: "src/index.ts is the plugin entry; no layer imports it"
};

const layerBoundaries = LAYERS.map((layer, i) => ({
  files: [`src/${layer}/**/*.ts`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          ...(i + 1 < LAYERS.length
            ? [{ group: LAYERS.slice(i + 1).map((above) => `**/${above}/**`) }]
            : []),
          ENTRY
        ]
      }
    ]
  }
}));

module.exports = [
  {
    ignores: ["public/vendor/**", "coverage/**", "lib/**", "fixtures/**"]
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.es2021,
        ...globals.node,
        ...globals.jest
      }
    },
    rules: {
      // Error prevention
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-prototype-builtins": "error",
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",

      // Security
      "no-eval": "error",
      "no-implied-eval": "error",

      // Best practices
      curly: ["error", "all"],
      "no-throw-literal": "error",
      "require-await": "warn"
    }
  },
  {
    files: ["__tests__/**/*.{js,ts}", "**/*.test.{js,ts}", "**/*.spec.{js,ts}"],
    rules: {
      "no-console": "off",
      "require-await": "off"
    }
  },
  {
    files: ["__tests__/benchmarks/**/*.{js,ts}", "scripts/**/*.js"],
    rules: {
      "no-console": "off"
    }
  },
  // ── Extension pages ─────────────────────────────────────────────────────
  // The pages are ES modules in the browser; planner-shared.js is a plain
  // script the pages load with <script> and the tests require().
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser }
    }
  },
  {
    files: ["public/planner-shared.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.commonjs }
    }
  },
  // ── TypeScript sources ──────────────────────────────────────────────────
  // Type-aware concerns (unused vars, undefined names) are owned by
  // `tsc --noEmit` (check:ts), so the corresponding lint rules are off to
  // avoid double-reporting / false positives on TS syntax. Formatting is
  // owned by Prettier.
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser
    },
    plugins: {
      "@typescript-eslint": tsPlugin
    },
    rules: {
      "no-unused-vars": "off",
      "no-undef": "off",
      "no-redeclare": "off"
    }
  },
  // ── Module guardrails ───────────────────────────────────────────────────
  // Small, single-purpose modules. The search must stay readable enough to
  // review for safety.
  {
    files: ["src/**/*.ts"],
    rules: {
      "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
      "max-statements": ["warn", 30],
      complexity: ["warn", 15]
    }
  },
  ...layerBoundaries
];
