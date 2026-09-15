import { defineConfig } from '@playwright/test';

/**
 * E2E (CLAUDE.md 3절 C등급). 대상: SPA 서빙 모드의 api (WF_SERVE_WEB=true, :3000).
 * 실행: pnpm test:e2e  (사전에 pnpm dev:db 와 api가 떠 있어야 한다)
 * 브라우저는 .local/ms-playwright (PLAYWRIGHT_BROWSERS_PATH) — D 드라이브 규칙 (8.1절)
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  outputDir: '../.local/tmp/playwright',
  use: {
    baseURL: process.env.WF_E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    locale: 'ko-KR',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
