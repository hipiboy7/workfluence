import { defineConfig } from 'vitest/config';

/**
 * 커버리지 대상 (CLAUDE.md 3절).
 *
 * 등급이 섞여 있어 임계값은 **낮은 쪽(B등급 70%)**에 맞추고, A등급(auth/domain)은
 * 별도 프로젝트로 90%를 따로 건다.
 *
 * 부트스트랩(main.ts)·모듈 조립·마이그레이션 실행·실 IdP 어댑터는 제외한다.
 * - `*.module.ts`: 모듈 조립과 컨트롤러다. 컨트롤러가 하는 일은 `db.transaction(...)` 안에서
 *   서비스와 감사 기록을 부르는 배선이고, **그 둘은 각각 측정된다.** 배선이 맞는지는 실제
 *   HTTP 호출로 봐야 의미가 있어 E2E가 본다. 그래서 여기서 빼되, **빼는 만큼 E2E가 없으면
 *   구멍이다** — 검증기록에 그 사실을 적는다
 * - oidc/http.provider.ts: **실 IdP 없이는 의미 있는 테스트를 쓸 수 없다** (확인 필요 A).
 *   모의로 감싸 통과시키면 "테스트가 있다"는 착각만 남는다. 보류 11에서 실연동과 함께 본다
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/common/**/*.ts', 'src/health/**/*.ts', 'src/auth/**/*.ts', 'src/users/**/*.ts', 'src/audit/**/*.ts'],
      exclude: ['src/auth/oidc/http.provider.ts', 'src/**/*.module.ts', 'src/**/*.spec.ts'],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
        // A등급은 90% (CLAUDE.md 3절). 디렉토리로 고정해 측정을 기계적으로 만든다
        'src/auth/domain/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
      },
    },
  },
});
