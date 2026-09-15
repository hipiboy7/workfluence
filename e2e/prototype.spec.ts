import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 프로토타입 v2 E2E (CLAUDE.md 3절 C등급). 대상: SPA 서빙 모드의 api (:3000).
 * 계정은 전부 시드가 만든 합성 계정. 개발 계정(admin1·member1·pending1)의 비밀번호는 root 초기 비밀번호와 같다 (seed.ts).
 */
function envValue(key: string): string {
  const env = readFileSync(resolve(__dirname, '..', '.env'), 'utf8');
  const m = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
  if (!m) throw new Error(`.env에 ${key}가 없다`);
  return m[1].trim();
}
const ROOT_USER = envValue('WF_ROOT_USERNAME');
const PASSWORD = envValue('WF_ROOT_INITIAL_PASSWORD');

async function login(page: Page, username: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('사용자명').fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
}

async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test('첫 페이지: 로그인·신규 가입·ID 찾기·PWD 찾기·담당자 확인이 있다', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: '로그인' })).toBeVisible();
  for (const name of ['신규 가입', 'ID 찾기', 'PWD 찾기', '담당자 확인']) await expect(page.getByRole('link', { name })).toBeVisible();
  await page.getByRole('link', { name: '담당자 확인' }).click();
  await expect(page.getByRole('heading', { name: '담당자 확인' })).toBeVisible();
  await expect(page.locator('ul.plain li').first()).toBeVisible(); // 관리자 이름 목록
});

test('비밀번호 눈 아이콘: 기본 마스킹, 누르면 보이고 다시 누르면 가린다', async ({ page }) => {
  await page.goto('/login');
  const pw = page.getByLabel('비밀번호', { exact: true });
  await pw.fill('secret-1234');
  await expect(pw).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: '비밀번호 보기' }).click();
  await expect(pw).toHaveAttribute('type', 'text');
  await expect(pw).toHaveValue('secret-1234');
  await page.getByRole('button', { name: '비밀번호 숨기기' }).click();
  await expect(pw).toHaveAttribute('type', 'password');
});

test('승인 대기 계정은 로그인할 수 없다', async ({ page }) => {
  await login(page, 'pending1');
  await expect(page.locator('.error')).toContainText('승인 대기');
  await expect(page).toHaveURL(/\/login$/);
});

test('root: 개인 → 팀 전환, DEMO 열기, Crew, 편집·저장(v+1), 검색', async ({ page }) => {
  await login(page, ROOT_USER);
  await expect(page.getByRole('heading', { name: '스페이스', exact: true })).toBeVisible();
  await expect(page.locator('.title-row .badge')).toHaveText('개인');
  await expect(page.locator('.cards .card-title').first()).toContainText('개인 스페이스');

  await page.getByRole('button', { name: '팀 스페이스 보기' }).click();
  await expect(page.locator('.title-row .badge')).toHaveText('팀');
  await page.getByRole('link', { name: '데모 스페이스' }).click();
  await expect(page).toHaveURL(/\/spaces\/[0-9a-f-]+\/pages\/[0-9a-f-]+$/);
  await expect(page.locator('.page-header h1')).toHaveText('시작하기');

  // Crew 패널: 생성자 root + 편집 member1
  await page.getByRole('button', { name: 'Crew' }).click();
  await expect(page.locator('.crew')).toContainText(ROOT_USER);
  await expect(page.locator('.crew')).toContainText('member1');
  await expect(page.locator('.crew')).toContainText('생성자');
  await expect(page.locator('.crew')).toContainText('편집');

  const versionBefore = Number((await page.locator('.page-header .muted').innerText()).match(/v(\d+)/)?.[1]);
  await page.getByRole('link', { name: '편집' }).click();
  await expect(page.getByRole('toolbar')).toBeVisible();
  const stamp = `E2E v2 문장 ${Date.now()}`;
  await page.locator('.doc.editable .tiptap').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(stamp);
  await page.getByRole('button', { name: /^저장/ }).click();
  await expect(page.locator('.doc')).toContainText(stamp);
  await expect(page.locator('.page-header .muted')).toContainText(`v${versionBefore + 1}`);

  await page.getByLabel('검색').fill('문장');
  await page.getByLabel('검색').press('Enter');
  await expect(page.locator('.hits li').first()).toContainText('시작하기');
});

test('새 카테고리 만들기 → 팀 스페이스 생성 → 목록에 분류 배지가 붙는다', async ({ page }) => {
  await login(page, ROOT_USER);
  await page.getByRole('button', { name: '팀 스페이스 보기' }).click();
  const category = `분류${Date.now().toString().slice(-6)}`;
  const spaceName = `E2E 팀 공간 ${Date.now().toString().slice(-6)}`;
  await page.getByLabel('분류').selectOption('__new__');
  await page.getByLabel('새 카테고리 이름').fill(category);
  await page.getByRole('button', { name: '추가' }).click();
  await expect(page.getByLabel('분류')).toContainText(category);
  await page.getByLabel('스페이스 명').fill(spaceName);
  await page.getByRole('button', { name: '만들기' }).click();
  const card = page.locator('.cards .card', { hasText: spaceName });
  await expect(card).toBeVisible();
  await expect(card).toContainText(category);
  await expect(card).toContainText('팀');
});

test('가입 요청 → 승인 대기로 로그인 불가 → admin1 승인 → 로그인되고 개인 스페이스가 있다', async ({ page }) => {
  const suffix = Date.now().toString().slice(-7);
  const username = `e2e${suffix}`;
  await page.goto('/signup');
  await page.getByLabel('사용자명 (ID)').fill(username);
  await page.getByLabel('이름').fill(`가입자 ${suffix}`);
  await page.getByLabel('email').fill(`${username}@example.internal`);
  await page.getByLabel(/^비밀번호 \(/).fill('joinpass-1');
  await page.getByLabel('비밀번호 확인').fill('joinpass-1');
  await page.getByRole('button', { name: '가입 요청' }).click();
  await expect(page.locator('.notice.info')).toContainText('승인');

  await login(page, username, 'joinpass-1');
  await expect(page.locator('.error')).toContainText('승인 대기');

  await login(page, 'admin1');
  await page.getByRole('link', { name: '관리', exact: true }).click();
  await expect(page.getByRole('heading', { name: '관리' })).toBeVisible();
  await page.getByRole('link', { name: '사용자' }).click();
  const row = page.locator('table.table tbody tr', { hasText: username });
  await expect(row).toContainText('승인 대기');
  await row.getByRole('button', { name: '승인' }).click();
  await expect(row).toContainText('활성');
  await logout(page);

  await login(page, username, 'joinpass-1');
  await expect(page.getByRole('heading', { name: '스페이스', exact: true })).toBeVisible();
  await expect(page.locator('.cards .card-title').first()).toContainText('개인 스페이스');
  await expect(page.getByRole('link', { name: '관리', exact: true })).toHaveCount(0);
});

test('PWD 찾기 → 임시 비밀번호로 로그인 → 변경 강제 → 새 비밀번호로 계속', async ({ page }) => {
  await page.goto('/recover-password');
  await page.getByLabel('사용자명 (ID)').fill('member1');
  await page.getByLabel('email').fill('member1@example.internal');
  await page.getByRole('button', { name: '임시 비밀번호 발급' }).click();
  const temp = (await page.locator('.mono.big').innerText()).trim();
  expect(temp.length).toBeGreaterThanOrEqual(12);

  await login(page, 'member1', temp);
  await expect(page).toHaveURL(/\/change-password$/);
  await expect(page.locator('.notice.warn')).toContainText('임시 비밀번호');
  const newPw = `Member-${Date.now().toString().slice(-6)}`;
  await page.getByLabel('현재 비밀번호').fill(temp);
  await page.getByLabel(/^새 비밀번호 \(/).fill(newPw);
  await page.getByLabel('새 비밀번호 확인').fill(newPw);
  await page.getByRole('button', { name: '변경', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: '스페이스', exact: true })).toBeVisible();
  await logout(page);
  await login(page, 'member1', newPw);
  await expect(page.getByRole('heading', { name: '스페이스', exact: true })).toBeVisible();
});

test('admin1: 관리 대시보드 3구역 → 스페이스 페이지에서 행 선택·상태 변경하기', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await login(page, 'admin1');
  await page.getByRole('link', { name: '관리', exact: true }).click();
  for (const name of ['사용자', '스페이스', '감사로그']) await expect(page.locator('.admin-grid h2 a', { hasText: name })).toBeVisible();
  await expect(page.locator('.admin-grid section').first().locator('tbody tr')).toHaveCount(5);

  await page.locator('.admin-grid h2 a', { hasText: '스페이스' }).click();
  await expect(page).toHaveURL(/\/admin\/spaces$/);
  const row = page.locator('table.selectable tbody tr', { hasText: '데모 스페이스' });
  await row.locator('td').nth(1).click();
  const panel = page.locator('.detail-panel');
  await expect(panel.getByRole('heading', { name: '데모 스페이스' })).toBeVisible();
  await expect(panel).toContainText('사용자 (');
  await expect(panel).toContainText('member1');

  await panel.getByRole('button', { name: /상태 변경하기/ }).click();
  await expect(panel.locator('dd .badge')).toHaveText('중지');
  await expect(row.locator('.badge.status-suspended')).toHaveText('중지');
  await panel.getByRole('button', { name: /상태 변경하기/ }).click();
  await expect(panel.locator('dd .badge')).toHaveText('활성');
});

test('member1은 관리 메뉴가 없고 /admin에 가면 홈으로 돌아온다', async ({ page }) => {
  // 직전 테스트가 member1 비밀번호를 바꿨을 수 있으므로 root로 확인한다: member는 admin1로 대체 불가 → pending1 외 member는 member1만.
  // member1 비밀번호가 바뀐 경우를 대비해 임시 비밀번호를 다시 발급받아 쓴다.
  await page.goto('/recover-password');
  await page.getByLabel('사용자명 (ID)').fill('member1');
  await page.getByLabel('email').fill('member1@example.internal');
  await page.getByRole('button', { name: '임시 비밀번호 발급' }).click();
  const temp = (await page.locator('.mono.big').innerText()).trim();
  await login(page, 'member1', temp);
  await page.getByLabel('현재 비밀번호').fill(temp);
  await page.getByLabel(/^새 비밀번호 \(/).fill(PASSWORD);
  await page.getByLabel('새 비밀번호 확인').fill(PASSWORD);
  await page.getByRole('button', { name: '변경', exact: true }).click();
  await expect(page.getByRole('heading', { name: '스페이스', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '관리', exact: true })).toHaveCount(0);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/$/);
});
