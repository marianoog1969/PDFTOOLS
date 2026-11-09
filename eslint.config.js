// ESLint 9 (configuración «flat»): TypeScript + reglas de hooks de React.
// Uso: npm run lint
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src-tauri", "*.html", "UTILS"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2020, globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Variables sin usar: aviso (no error); se permiten las que empiezan por «_».
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
);
