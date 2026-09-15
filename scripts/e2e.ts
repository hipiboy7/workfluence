/**
 * pnpm test:e2e — Playwright를 이 저장소의 .local/ms-playwright 브라우저로 실행한다 (CLAUDE.md 8.1절).
 * OS별 환경변수 문법 차이를 문서에 노출하지 않기 위해 스크립트가 env를 설정한다 (4.1절).
 * 사전 조건: pnpm dev:db, 그리고 WF_SERVE_WEB=true 로 뜬 api (:3000).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'playwright', 'test', '-c', 'e2e/playwright.config.ts', ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve(root, '.local', 'ms-playwright') },
  },
);
process.exit(result.status ?? 1);
