import { defineConfig } from 'vitest/config';

// A등급 패키지: 라인·브랜치 90% 관문 (CLAUDE.md 3절)
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // **검증기록의 표를 손으로 쓰지 않는다.** `coverage-summary.json`에서 뽑는다 —
      // P4에서 손으로 적다가 브랜치 89.28%를 100%로 잘못 적었다
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/index.ts'],
      /**
       * **`perFile`을 켠다.** 합계로만 재면 한 파일이 관문 아래로 내려가도 다른 파일이
       * 덮어 준다. 실제로 그랬다 — `policy.ts`의 브랜치가 89.28%인데 패키지 합계가
       * 96%라 초록이었고(P4), Phase 5에서는 `parseDotenv`가 **테스트가 아예 없는데도**
       * 통과했다. 하필 그 함수의 주석에 "한 곳만 고쳤다가 조용히 깨졌다"고 적혀 있었다.
       *
       * 파일 단위로 재면 새 파일을 테스트 없이 넣는 순간 **빨개진다.** 관문의 뜻이
       * "이 패키지가 대체로 덮였다"에서 "모든 파일이 덮였다"로 바뀌는 것이고,
       * A등급이 원래 요구한 것은 후자다 (CLAUDE.md 3절).
       */
      thresholds: { perFile: true, lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
