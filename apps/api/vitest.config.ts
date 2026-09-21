import { defineConfig } from 'vitest/config';

// B등급 (CLAUDE.md 3절): 구현 후 테스트 허용, api ≥70%.
// 커버리지 대상은 Phase 0이 책임지는 모듈만. 부트스트랩(main.ts)·모듈 조립·마이그레이션 실행은
// 브라우저·컨테이너에서 실제로 돌려 확인한다(E2E·Linux 빌드).
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/common/**/*.ts', 'src/health/**/*.ts'],
      thresholds: { lines: 70, branches: 70, functions: 70, statements: 70 },
    },
  },
});
