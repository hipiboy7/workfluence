import { expect, request, test, type Page } from '@playwright/test';
import { cleanup, confirmInDialog, createAdmin, createMember, newAdmin } from './fixtures';

const ADMIN = newAdmin('token');
const mate = { username: `e2e-tokmate-${Date.now()}`, displayName: 'E2E 토큰 동료', password: 'E2e-Mate-2026!' };

/**
 * 공개 API 토큰 화면의 인수 기준 (docs/spinoff/public-api 설계서 FR-2222). 화면에서 토큰을 **발급**하고, 그 토큰만으로(쿠키·CSRF 머리말 없이)
 * 마크다운 페이지를 **만들고 읽고**, 화면에서 **폐기**하면 곧바로 401이 된다. 관리자는 사용자 관리에서 남의 토큰도 폐기한다.
 */

test.beforeAll(async () => {
  await createAdmin(ADMIN);
  await createMember(mate);
});
test.afterAll(() => cleanup([ADMIN.username, mate.username]));

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(username);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test('발급 → 그 토큰으로 마크다운 페이지 만들기 → 폐기 → 401', async ({ page, baseURL }) => {
  await login(page, ADMIN.username, ADMIN.password);
  await page.goto('/account/tokens');

  // 1) 발급 — 읽기+쓰기. 값은 한 번만 보인다
  await page.getByLabel('이름', { exact: true }).fill('E2E 보고서 봇');
  await page.getByRole('checkbox', { name: /쓰기/ }).check();
  await page.getByRole('button', { name: '발급' }).click();
  const token = (await page.getByLabel('발급된 토큰').innerText()).trim();
  expect(token).toMatch(/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/);
  await expect(page.getByText(/다시 볼 수 없다/)).toBeVisible();
  const row = page.getByRole('row', { name: /E2E 보고서 봇/ });
  await expect(row).toContainText('사용 중');
  await expect(row).toContainText('쓴 적 없음');
  // 확인하면 값이 화면에서 사라진다 — 다시 볼 길이 없다
  await page.getByRole('button', { name: '확인했다' }).click();
  await expect(page.getByLabel('발급된 토큰')).toHaveCount(0);

  // 2) 그 토큰만으로 — 쿠키도 CSRF 머리말도 없는 별도 클라이언트
  const bot = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  const spaceName = `E2E 토큰 공간 ${Date.now()}`;
  const sp = await bot.post('/api/v1/spaces', { data: { name: spaceName } });
  expect(sp.status(), await sp.text()).toBe(201);
  const pg = await bot.post('/api/v1/pages', { data: { space: spaceName, title: '토큰으로 만든 글', body: '# 큰 제목\n\n본문 **굵게** 입니다.' } });
  expect(pg.status(), await pg.text()).toBe(201);
  const created = (await pg.json()) as { id: string; currentVersionNo: number };
  expect(created.currentVersionNo).toBe(1);
  const read = await bot.get(`/api/v1/pages/${created.id}`);
  expect(read.status()).toBe(200);
  expect(((await read.json()) as { body: string }).body).toContain('**굵게**');

  // 3) 사람의 화면에서도 보인다 — 같은 위키다
  await page.goto(`/pages/${created.id}`);
  await expect(page.getByRole('heading', { name: '토큰으로 만든 글' }).first()).toBeVisible();

  // 4) 마지막 사용이 찍힌다
  await page.goto('/account/tokens');
  await expect(page.getByRole('row', { name: /E2E 보고서 봇/ })).not.toContainText('쓴 적 없음');

  // 5) 화면에서 폐기 → 곧바로 401 TOKEN_REVOKED
  await page.getByRole('row', { name: /E2E 보고서 봇/ }).getByRole('button', { name: '폐기' }).click();
  await confirmInDialog(page, '폐기한다');
  await expect(page.getByRole('row', { name: /E2E 보고서 봇/ })).toContainText('폐기됨');
  const after = await bot.get(`/api/v1/pages/${created.id}`);
  expect(after.status()).toBe(401);
  expect(((await after.json()) as { error: { code: string } }).error.code).toBe('TOKEN_REVOKED');
  await bot.dispose();
});

test('관리자가 사용자 관리에서 남의 토큰을 폐기하면 그 토큰은 곧바로 401이다', async ({ browser, baseURL }) => {
  // 동료가 자기 화면(세션)에서 토큰을 발급한다 — 쓰는 길은 화면과 같다
  const mateCtx = await browser.newContext();
  const matePage = await mateCtx.newPage();
  await login(matePage, mate.username, mate.password);
  await matePage.goto('/account/tokens');
  await expect(matePage.getByRole('checkbox', { name: /관리/ })).toHaveCount(0); // member에게는 관리 권한 칸이 없다
  await matePage.getByLabel('이름', { exact: true }).fill('새어 나간 봇');
  await matePage.getByRole('button', { name: '발급' }).click();
  const token = (await matePage.getByLabel('발급된 토큰').innerText()).trim();
  const bot = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  expect((await bot.get('/api/v1/spaces')).status()).toBe(200);

  // 관리자가 그 사람을 찾아 토큰을 폐기한다
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await login(adminPage, ADMIN.username, ADMIN.password);
  await adminPage.goto('/admin/users');
  await adminPage.getByRole('searchbox', { name: '찾기' }).fill(mate.username);
  const row = adminPage.getByRole('row', { name: new RegExp(mate.username) });
  await row.getByRole('button', { name: 'API 토큰' }).click();
  const panel = adminPage.getByRole('region', { name: new RegExp(`API 토큰 — ${mate.username}`) });
  await expect(panel.getByRole('row', { name: /새어 나간 봇/ })).toContainText('사용 중');
  await panel.getByRole('button', { name: '폐기' }).click();
  await confirmInDialog(adminPage, '폐기한다');
  await expect(panel.getByRole('row', { name: /새어 나간 봇/ })).toContainText('폐기됨');

  const after = await bot.get('/api/v1/spaces');
  expect(after.status()).toBe(401);
  expect(((await after.json()) as { error: { code: string } }).error.code).toBe('TOKEN_REVOKED');

  // 동료의 화면에도 폐기됨으로 보인다
  await matePage.goto('/account/tokens');
  await expect(matePage.getByRole('row', { name: /새어 나간 봇/ })).toContainText('폐기됨');
  await bot.dispose();
  await mateCtx.close();
  await adminCtx.close();
});
