/**
 * pnpm test:e2e — Playwright를 이 저장소의 .local/ms-playwright 브라우저로 실행한다 (CLAUDE.md 8.1절).
 * OS별 환경변수 문법 차이를 문서에 노출하지 않기 위해 스크립트가 env를 설정한다 (4.1절).
 * 사전 조건: pnpm dev:db, 그리고 WF_SERVE_WEB=true 로 뜬 api (:3000). **Phase 19부터 그 api는 메일을 켠 채 뜬다** — `e2e/recovery.spec.ts`가 가짜 사내
 * 메일 서버(`E2E_MAIL_PORT`, 기본 3199)를 띄우고 받은 링크를 쓴다: `WF_MAIL_ENABLED=true` · `WF_MAIL_MOCK=false` ·
 * `WF_MAIL_API_URL=http://127.0.0.1:3199/api/v1/email/send` · `WF_PUBLIC_URL`(그 api의 주소). 아니면 그 파일의 첫 단정이 까닭을 말하며 실패한다
 *
 * **`.env`를 여기서 읽어 넘긴다.** fixtures가 `WF_DATABASE_URL`로 계정을 직접 만드는데,
 * 셸에 내보내지 않으면 "WF_DATABASE_URL이 없다"로 죽는다. 문서에 적힌 명령이 적힌 그대로
 * 동작해야 한다는 규칙(CLAUDE.md 4.1절)에 따라 스크립트가 챙긴다 (P3 자체 점검 #3).
 */
import { parseDotenv } from '@workfluence/shared';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const envFile = resolve(root, '.env');
// 이미 셸에 있는 값이 우선한다 — CI나 다른 DB를 가리키고 싶을 때 덮어쓸 수 있어야 한다
const fromFile = existsSync(envFile) ? parseDotenv(readFileSync(envFile, 'utf8')) : {};
const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'playwright', 'test', '-c', 'e2e/playwright.config.ts', ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...fromFile, ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve(root, '.local', 'ms-playwright') },
  },
);
process.exit(result.status ?? 1);
