import { mailTest } from '../apps/api/src/cli/mail-test';

/**
 * 사내 메일 시험 — **본문은 `apps/api/src/cli/mail-test.ts`에 있다** (P18_설계서_Mail FR-1905). 개발은 이것(`pnpm mail:test <받는 주소>`)을, 운영(폐쇄망)은
 * 앱 이미지 안의 `node dist/cli/mail-test.js <받는 주소>`를 compose의 `tools`로 부른다 — 같은 코드다
 */
mailTest(process.argv.slice(2))
  .then((code) => (process.exitCode = code))
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
