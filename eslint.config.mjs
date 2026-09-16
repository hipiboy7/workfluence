import js from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

/**
 * ESLint flat config (P0_설계서_Foundation 9.1절).
 *
 * 이 저장소에서 lint가 잡아야 할 것은 스타일이 아니라 **환경 차이로만 드러나는 실수**다.
 * - import 경로 대소문자: Windows는 구분하지 않아 Linux 빌드에서만 실패한다
 * - `import type`으로 주입 대상 클래스를 가져오기: 런타임에 사라져 Nest DI가 undefined를 받는다
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '.local/**', 'apps/web/dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts}'],
    plugins: { 'import-x': importX },
    languageOptions: {
      parserOptions: { projectService: false },
    },
    settings: {
      'import-x/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['tsconfig.base.json', 'apps/*/tsconfig.json', 'packages/*/tsconfig.json'],
          // 워크스페이스라 tsconfig가 여러 개인 것이 정상이다
          noWarnOnMultipleProjects: true,
        },
      },
    },
    rules: {
      // Linux는 파일명 대소문자를 구분한다. Windows에서만 통과하는 import를 잡는다
      'import-x/no-unresolved': ['error', { caseSensitiveStrict: true, ignore: ['^@workfluence/'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },
  {
    // NestJS 주입 대상은 `import type`으로 가져오면 런타임에 사라진다 (P0_설계서 9.1절)
    files: ['apps/api/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportDeclaration[importKind='type'] ImportSpecifier[imported.name=/Service$|Guard$|Module$/]",
          message: "주입 대상 클래스는 `import type`으로 가져오지 않는다 — 런타임에 사라져 의존성 주입이 실패한다.",
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx', 'e2e/**/*.ts', 'scripts/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
