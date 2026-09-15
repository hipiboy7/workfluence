import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 루트 .env의 관리자 비밀번호. 합성 계정이다 (CLAUDE.md 6절 실데이터 금지). */
function adminPassword(): string {
  const env = readFileSync(resolve(__dirname, '..', '.env'), 'utf8');
  const m = env.match(/^WF_ADMIN_INITIAL_PASSWORD=(.+)$/m);
  if (!m) throw new Error('.env에 WF_ADMIN_INITIAL_PASSWORD가 없다');
  return m[1].trim();
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('사용자명').fill('admin');
  await page.getByLabel('비밀번호').fill(adminPassword());
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: '스페이스', exact: true })).toBeVisible();
}

test('로그인 → 스페이스 → 페이지 열기 → 편집·저장(v+1) → 이력 → 검색', async ({ page }) => {
  await login(page);

  // 데모 스페이스로 들어가면 첫 페이지가 자동 선택된다
  await page.getByRole('link', { name: /DEMO/ }).click();
  await expect(page).toHaveURL(/\/spaces\/[0-9a-f-]+\/pages\/[0-9a-f-]+$/);
  // 본문 안에도 h1이 있으므로 페이지 제목 영역으로 한정한다
  await expect(page.locator('.page-header h1')).toHaveText('시작하기');
  const versionBefore = Number((await page.locator('.page-header .muted').innerText()).match(/v(\d+)/)?.[1]);
  expect(versionBefore).toBeGreaterThanOrEqual(1);

  // 편집: 본문 끝에 문장을 추가하고 저장
  await page.getByRole('link', { name: '편집' }).click();
  await expect(page.getByRole('toolbar')).toBeVisible();
  const stamp = `E2E 추가 문장 ${Date.now()}`;
  const editor = page.locator('.doc.editable .tiptap');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(stamp);
  await page.getByRole('button', { name: /^저장/ }).click();

  // 저장 후 보기 화면: 버전이 1 올라가고 새 문장이 보인다
  await expect(page).toHaveURL(/\/spaces\/[0-9a-f-]+\/pages\/[0-9a-f-]+$/);
  await expect(page.locator('.doc')).toContainText(stamp);
  await expect(page.locator('.page-header .muted')).toContainText(`v${versionBefore + 1}`);

  // 이력: 최신 버전이 (현재)로 표시되고 이전 버전을 열 수 있다
  await page.getByRole('link', { name: '이력' }).click();
  await expect(page.getByRole('heading', { name: '버전 이력' })).toBeVisible();
  await expect(page.locator('.versions li').first()).toContainText(`v${versionBefore + 1}`);
  await page.locator('.versions button', { hasText: `v${versionBefore}` }).first().click();
  await expect(page.getByRole('button', { name: '이 버전으로 복원' })).toBeVisible();

  // 검색: 방금 넣은 문장의 일부(한글 2글자)로 찾는다
  await page.getByLabel('검색').fill('추가');
  await page.getByLabel('검색').press('Enter');
  await expect(page).toHaveURL(/\/search\?q=/);
  await expect(page.locator('.hits li').first()).toContainText('시작하기');
});

test('로그인 없이 보호 화면에 가면 로그인으로 보낸다', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login$/);
});

test('관리 화면: 사용자 목록과 감사로그가 보인다', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: '관리' }).click();
  await expect(page.getByRole('heading', { name: '사용자', exact: true })).toBeVisible();
  await expect(page.locator('table.table').first()).toContainText('admin');
  await expect(page.getByRole('heading', { name: /감사로그/ })).toBeVisible();
  await expect(page.locator('table.table.small')).toContainText('auth.login.success');
});
