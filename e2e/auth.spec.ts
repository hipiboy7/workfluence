import { expect, test } from '@playwright/test';
import { cleanup, createAdmin, createMember, newAdmin } from './fixtures';

const ADMIN = newAdmin('auth');

/**
 * Phase 1 인수 기준을 브라우저에서 확인한다 (P1_설계서_Auth A.6절).
 * "가입 요청한 계정을 관리자가 승인하면 로그인된다"
 */

const member = { username: `e2e-user-${Date.now()}`, displayName: 'E2E 사용자', email: `e2e-${Date.now()}@example.internal`, password: 'E2e-User-2026!' };

test.beforeAll(() => createAdmin(ADMIN));
/** 이 파일이 만든 계정. 가입 흐름을 보는 첫 테스트 말고는 **계정을 직접 만든다** —
 *  가입은 IP별 rate limit이 걸려 있어(10분 5회) 스펙이 늘수록 뒤가 먼저 막힌다 */
const made: string[] = [ADMIN.username, member.username];
test.afterAll(() => cleanup(made));

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

/**
 * 컨트롤러(`*.module.ts`)를 커버리지에서 뺐으므로 **그 배선은 여기서 봐야 한다**
 * (P1_검증기록_Auth 2.1절). 아래는 단위·통합 테스트가 닿지 않는 HTTP 경로다.
 */
test('사내 계정(모의 OIDC)으로 로그인한다', async ({ page }) => {
  await page.goto('/login');
  const button = page.getByRole('link', { name: '사내 계정으로 로그인' });
  await expect(button).toBeVisible();
  await button.click();
  // start → callback → / 까지 서버 리다이렉트를 따라간다
  await expect(page.getByText('idp.dev님')).toBeVisible();
  await expect(page.getByText('member')).toBeVisible();
});

test('관리자가 잠금 해제·비밀번호 초기화·역할 변경을 한다', async ({ page }) => {
  const target = { username: `e2e-tgt-${Date.now()}`, displayName: 'E2E 대상', password: 'E2e-Target-2026!' };
  made.push(target.username);
  // 이 테스트가 보는 것은 **관리자의 조작**이다. 가입 흐름은 위 테스트가 이미 본다
  await createMember(target);

  await page.goto('/login');
  await page.getByLabel('아이디').fill(ADMIN.username);
  await page.getByLabel('비밀번호').fill(ADMIN.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByRole('link', { name: '사용자 관리' }).click();

  // 이 계정은 이미 활성이다 (승인 흐름은 위 테스트가 본다)
  const row = page.getByRole('row').filter({ hasText: target.username });
  await expect(row.getByText('active')).toBeVisible();

  // 역할 변경 (PATCH /api/users/:id/role)
  await row.getByRole('combobox').selectOption('admin');
  await expect(row.getByRole('combobox')).toHaveValue('admin');

  // 비밀번호 초기화 (POST /api/users/:id/reset-password) — 임시 비밀번호가 1회 보인다
  await row.getByRole('button', { name: '비밀번호 초기화' }).click();
  await expect(page.getByText('임시 비밀번호')).toBeVisible();
  await expect(page.getByText('이 값은 다시 볼 수 없다. 지금 전달한다.')).toBeVisible();

  // 감사로그 (GET /api/audit)
  await page.goto('/admin/audit');
  await expect(page.getByRole('heading', { name: '감사로그' })).toBeVisible();
  // **표 안에서** 찾는다. 행위 선택 상자에도 같은 글자가 option으로 있어서다 (Phase 4에서 생겼다)
  await expect(page.locator('tbody').getByText('user.approve').first()).toBeVisible();
  await expect(page.locator('tbody').getByText('user.password.reset').first()).toBeVisible();

  cleanupExtra.push(target.username);
});

/** afterAll이 지울 추가 계정 */
const cleanupExtra: string[] = [];
test.afterAll(() => cleanup(cleanupExtra));
