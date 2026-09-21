/**
 * pnpm test:e2e — Playwright를 이 저장소의 .local/ms-playwright 브라우저로 실행한다 (CLAUDE.md 8.1절).
 * OS별 환경변수 문법 차이를 문서에 노출하지 않기 위해 스크립트가 env를 설정한다 (4.1절).
 * 사전 조건: pnpm dev:db, 그리고 WF_SERVE_WEB=true 로 뜬 api (:3000).
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
