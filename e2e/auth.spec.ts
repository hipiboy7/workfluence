import { expect, test } from '@playwright/test';
import { ADMIN, cleanup, createAdmin } from './fixtures';

/**
 * Phase 1 인수 기준을 브라우저에서 확인한다 (P1_설계서_Auth A.6절).
 * "가입 요청한 계정을 관리자가 승인하면 로그인된다"
 */

const member = { username: `e2e-user-${Date.now()}`, displayName: 'E2E 사용자', email: `e2e-${Date.now()}@example.internal`, password: 'E2e-User-2026!' };

test.beforeAll(createAdmin);
test.afterAll(() => cleanup([ADMIN.username, member.username]));

test('가입 요청 → 승인 → 로그인 → 비밀번호 변경', async ({ page }) => {
  // 1) 가입 요청
  await page.goto('/signup');
  await page.getByLabel('아이디').fill(member.username);
  await page.getByLabel('이름').fill(member.displayName);
  await page.getByLabel('email').fill(member.email);
  await page.getByLabel('비밀번호').fill(member.password);
  await page.getByRole('button', { name: '가입 요청' }).click();
  await expect(page.getByText('가입 요청이 접수됐다')).toBeVisible();

  // 2) 승인 전에는 로그인되지 않는다
  await page.goto('/login');
  await page.getByLabel('아이디').fill(member.username);
  await page.getByLabel('비밀번호').fill(member.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('alert')).toContainText('아이디 또는 비밀번호가 올바르지 않다');

  // 3) 관리자가 승인
  await page.goto('/login');
  await page.getByLabel('아이디').fill(ADMIN.username);
  await page.getByLabel('비밀번호').fill(ADMIN.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('link', { name: '사용자 관리' })).toBeVisible();
  await page.getByRole('link', { name: '사용자 관리' }).click();

  const row = page.getByRole('row').filter({ hasText: member.username });
  await expect(row.getByText('pending')).toBeVisible();
  await row.getByRole('button', { name: '승인' }).click();
  await expect(row.getByText('active')).toBeVisible();

  // 관리 화면에는 로그아웃 버튼이 없다. 홈으로 돌아가서 누른다
  await page.goto('/');
  await page.getByRole('button', { name: '로그아웃' }).click();

  // 4) 승인 후 로그인된다
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('아이디').fill(member.username);
  await page.getByLabel('비밀번호').fill(member.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByText(`${member.displayName}님`)).toBeVisible();

  // 5) 일반 사용자에게는 관리 메뉴가 보이지 않는다 — 판정은 shared의 can()이 한다
  await expect(page.getByRole('link', { name: '사용자 관리' })).toHaveCount(0);

  // 6) 비밀번호 변경
  await page.getByRole('link', { name: '비밀번호 변경' }).click();
  await page.getByLabel('현재 비밀번호').fill(member.password);
  await page.getByLabel('새 비밀번호').fill('E2e-Changed-2026!');
  await page.getByRole('button', { name: '변경' }).click();
  await expect(page.getByText(`${member.displayName}님`)).toBeVisible();
});

test('로그인하지 않으면 보호된 화면에서 로그인으로 보낸다 (FR-244)', async ({ page }) => {
  await page.goto('/admin/users');
  await expect(page).toHaveURL(/\/login/);
});

test('계정 찾기는 없는 정보에도 같은 모양으로 답한다 (FR-208)', async ({ page }) => {
  await page.goto('/find-account');
  await page.getByLabel('email').first().fill('nobody@example.internal');
  await page.getByLabel('이름').fill('없는사람');
  await page.getByRole('button', { name: '찾기' }).click();
  await expect(page.getByText('일치하는 정보로 찾을 수 없다')).toBeVisible();
});
