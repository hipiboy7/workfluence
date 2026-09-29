import { expect, test } from '@playwright/test';
import { confirmInDialog, cleanup, createAdmin, createMember, newAdmin } from './fixtures';

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
  await expect(row.getByText('승인 대기')).toBeVisible();
  await row.getByRole('button', { name: '승인' }).click();
  await expect(row.getByText('활성')).toBeVisible();

  // 로그아웃은 모든 화면의 위 막대에 있다 (P17 J.3.2)
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
  // 칸은 셋이고 칸마다 눈 모양 단추가 있다("… 보이기") — 이름은 정확히 찾는다(T-068)
  await page.getByLabel('현재 비밀번호', { exact: true }).fill(member.password);
  await page.getByLabel('새 비밀번호', { exact: true }).fill('E2e-Changed-2026!');
  await page.getByLabel('새 비밀번호 확인', { exact: true }).fill('E2e-Changed-2026!');
  await page.getByRole('button', { name: '변경', exact: true }).click();
  // **바뀐 결과를 본다** — 위 막대의 "{이름}님"은 누르기 전부터 있어 서버가 거절해도 참이었다(T-066과 같은 모양 — 병합 전 검토 2).
  // 성공하면 홈(h1 "스페이스")으로 간다. 그리고 옛 비밀번호는 거절되고 새 비밀번호로 들어온다
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(page.getByRole('heading', { level: 1, name: '스페이스', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('아이디').fill(member.username);
  await page.getByLabel('비밀번호').fill(member.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('alert')).toContainText('아이디 또는 비밀번호가 올바르지 않다');
  await page.getByLabel('비밀번호').fill('E2e-Changed-2026!');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '스페이스', exact: true })).toBeVisible();
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
  // 위 막대의 역할은 한글이다 (P17 J.9-9)
  await expect(page.getByText('일반 사용자')).toBeVisible();
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
  await expect(row.getByText('활성')).toBeVisible();

  // 역할 변경 (PATCH /api/users/:id/role)
  await row.getByRole('combobox').selectOption('admin');
  await expect(row.getByRole('combobox')).toHaveValue('admin');

  // 비밀번호 초기화 (POST /api/users/:id/reset-password) — 한 번 묻고(병합 전 검토 22), 임시 비밀번호가 1회 보인다
  await row.getByRole('button', { name: '비밀번호 초기화' }).click();
  await confirmInDialog(page, '새로 만든다');
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

/**
 * **비밀번호 초기화 요청이 관리자의 알림에 온다** (P17 F-010 8번, FR-1801·1803). 예전에는 감사로그에만 남아 관리자가 알 길이 없었다.
 * 다른 화면에 있어도 맨 위의 알림 영역에서 보고, 그 링크로 사용자 관리에 가서(찾기 칸에 아이디가 들어간다) 초기화하면 그 알림은 읽음이 된다
 */
test('비밀번호 찾기의 초기화 요청이 관리자의 알림 영역에 오고, 초기화하면 읽음이 된다', async ({ page }) => {
  const stamp = Date.now();
  const asker = { username: `e2e-ask-${stamp}`, displayName: 'E2E 요청자', password: 'E2e-Asker-2026!', email: `e2e-ask-${stamp}@example.internal` };
  made.push(asker.username);
  await createMember(asker);
  // 본인의 요청이라고 말하지 않는다 — 아이디·email만으로 누구나 보낸다(병합 전 검토 22)
  const said = `${asker.displayName} (${asker.username})님의 아이디·email로 비밀번호 초기화가 요청됐다`;

  await page.goto('/find-account');
  const form = page.locator('form').filter({ has: page.getByRole('heading', { name: '비밀번호 찾기' }) });
  await form.getByLabel('아이디').fill(asker.username);
  await form.getByLabel('email').fill(asker.email);
  await form.getByRole('button', { name: '초기화 요청' }).click();
  await expect(form.getByText('요청을 접수했다', { exact: false })).toBeVisible();

  await page.goto('/login');
  await page.getByLabel('아이디').fill(ADMIN.username);
  await page.getByLabel('비밀번호').fill(ADMIN.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByText('E2E 관리자님')).toBeVisible();
  // 스페이스 목록이 아닌 화면에서도 보인다
  await page.goto('/search');
  const bell = page.getByRole('button', { name: /^알림 — 안 읽은 것 \d+건$/ });
  await expect(bell).toBeVisible();
  await bell.click();
  const item = page.getByRole('region', { name: '최근 알림' }).getByRole('listitem').filter({ hasText: said });
  await expect(item).toBeVisible();
  await item.getByRole('link', { name: '사용자 관리에서 초기화' }).click();

  await expect(page).toHaveURL(/\/admin\/users\?q=/);
  await expect(page.getByRole('searchbox')).toHaveValue(asker.username);
  const row = page.getByRole('row').filter({ hasText: asker.username });
  await row.getByRole('button', { name: '비밀번호 초기화' }).click();
  // 본인 확인을 말하는 확인 대화를 지난다
  expect(await confirmInDialog(page, '새로 만든다')).toContain('본인이 요청했는지 먼저 확인한다');
  await expect(page.getByText('임시 비밀번호')).toBeVisible();

  // 초기화했으니 그 알림은 읽음이다 — 읽음 단추가 없다
  await page.goto('/notifications');
  const done = page.getByRole('listitem').filter({ hasText: said });
  await expect(done).toContainText('· 읽음');
  await expect(done.getByRole('button', { name: '읽음' })).toHaveCount(0);
});

/** afterAll이 지울 추가 계정 */
const cleanupExtra: string[] = [];
test.afterAll(() => cleanup(cleanupExtra));

/**
 * **계정 정지** (P13 C.5, FR-1441~1443). 퇴사자 처리 — 관리자가 찾아서 정지하면 그 사람은 로그인하지 못하고, 정지를 풀면 그대로 들어온다.
 * 찾기로 찾는다 — 사람이 100명을 넘으면 목록의 첫 조각에 없을 수 있다(FR-1450)
 */
test('관리자가 찾아서 정지하면 로그인되지 않고, 정지를 풀면 된다', async ({ page }) => {
  const leaver = { username: `e2e-leave-${Date.now()}`, displayName: 'E2E 퇴사자', password: 'E2e-Leaver-2026!' };
  made.push(leaver.username);
  await createMember(leaver);

  await page.goto('/login');
  await page.getByLabel('아이디').fill(ADMIN.username);
  await page.getByLabel('비밀번호').fill(ADMIN.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByRole('link', { name: '사용자 관리' }).click();
  await page.getByRole('searchbox').fill(leaver.username);
  const row = page.getByRole('row').filter({ hasText: leaver.username });
  await expect(row).toHaveCount(1);
  await expect(page.getByText(/전체 1명/)).toBeVisible();
  await row.getByRole('button', { name: '정지', exact: true }).click();
  await confirmInDialog(page, '멈춘다');
  // **상태 칸의 뱃지를 본다** — 글자 '정지'는 누르기 전부터 있는 정지 단추에도 걸려 늘 참이었다 (병합 전 자체 점검 10)
  await expect(row.locator('td .badge').filter({ hasText: /^정지$/ })).toBeVisible();
  await expect(row.getByRole('button', { name: '정지 해제' })).toBeVisible();

  // 정지된 사람은 맞는 비밀번호로도 못 들어온다 — 응답은 다른 실패와 같다(계정 상태가 새지 않게)
  const other = await page.context().browser()!.newContext();
  const leaverPage = await other.newPage();
  await leaverPage.goto('/login');
  await leaverPage.getByLabel('아이디').fill(leaver.username);
  await leaverPage.getByLabel('비밀번호').fill(leaver.password);
  await leaverPage.getByRole('button', { name: '로그인' }).click();
  await expect(leaverPage.getByRole('alert')).toContainText('아이디 또는 비밀번호가 올바르지 않다');

  await row.getByRole('button', { name: '정지 해제' }).click();
  await expect(row.locator('td .badge').filter({ hasText: /^활성$/ })).toBeVisible();
  await leaverPage.getByRole('button', { name: '로그인' }).click();
  await expect(leaverPage.getByText(`${leaver.displayName}님`)).toBeVisible();
  await other.close();
});
