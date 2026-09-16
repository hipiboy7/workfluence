import { expect, test } from '@playwright/test';

/**
 * Phase 0 인수 기준 (scope-definition 5절): 브라우저에서 앱이 뜨고 헬스체크가 DB까지 확인한다.
 * 사전 조건: `pnpm dev:db`로 DB가 떠 있고, WF_SERVE_WEB=true 로 api가 기동되어 있다.
 */
test('API 헬스체크가 DB까지 확인해 ok를 반환한다', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('no-store');
  const body = (await res.json()) as { status: string; db: string; time: string };
  expect(body).toMatchObject({ status: 'ok', db: 'ok' });
  expect(Number.isNaN(Date.parse(body.time))).toBe(false);
});

test('보안 응답 헤더가 붙는다', async ({ request }) => {
  const headers = (await request.get('/api/health')).headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-powered-by']).toBeUndefined();
});

test('SPA 셸이 뜨고 기동 확인 결과를 보여준다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'workfluence' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '기동 확인' })).toBeVisible();
  await expect(page.locator('.badge.ok').first()).toHaveText('ok');
  await expect(page.locator('dl.meta')).toContainText('데이터베이스');
});

test('SPA 딥링크는 index.html로 폴백하고 /api는 제외된다', async ({ request }) => {
  const deep = await request.get('/some/unknown/route');
  expect(deep.status()).toBe(200);
  expect(deep.headers()['content-type']).toContain('text/html');

  const api = await request.get('/api/unknown');
  expect(api.status()).toBe(404);
  expect(api.headers()['content-type']).toContain('application/json');
});
