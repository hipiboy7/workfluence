import { expect, test } from '@playwright/test';
import { cleanup, createAdmin, createMember, newAdmin } from './fixtures';

const ADMIN = newAdmin('admin');

/**
 * Phase 4 인수 기준 (scope-definition 5절).
 * "관리자가 사용자·스페이스를 관리하고 감사로그로 추적한다. 삭제한 페이지를 휴지통에서
 *  되살린다. 멘션이 알림함에 뜬다"
 */

const MATE = { username: `e2e-p4mate-${Date.now()}`, displayName: 'E2E 동료4', password: 'E2e-Mate4-2026!' };

test.beforeAll(async () => {
  await createAdmin(ADMIN);
  await createMember(MATE);
});
test.afterAll(() => cleanup([ADMIN.username, MATE.username]));

async function login(page: import('@playwright/test').Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(username);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

const STAMP = Date.now();

test('멘션 → 알림함 → 휴지통 복원 → 라벨', async ({ page }) => {
  await login(page, ADMIN.username, ADMIN.password);

  // 1) 스페이스와 페이지를 만들고 동료를 Crew에 넣는다
  const spaceName = `E2E 관리 ${STAMP}`;
  await page.goto('/');
  await page.getByLabel('이름').fill(spaceName);
  await page.getByRole('button', { name: '만들기' }).click();
  await page.getByRole('link', { name: spaceName }).click();
  await page.getByLabel('아이디로 Crew 추가 (editor)').fill(MATE.username);
  await page.getByRole('button', { name: '추가' }).click();
  await expect(page.getByText(MATE.displayName)).toBeVisible();

  await page.getByLabel('새 페이지 제목').fill(`정책 회의 ${STAMP}`);
  await page.getByRole('button', { name: '만들기' }).click();
  await page.locator('.editor .ProseMirror').click();
  await page.keyboard.type('내용을 적는다');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByText('버전 2')).toBeVisible();
  const pageUrl = page.url();

  // 2) 라벨을 붙이고 라벨로 찾는다
  await page.getByLabel('라벨 붙이기').fill('회의록');
  await page.getByRole('button', { name: '붙이기' }).click();
  await page.locator('section[aria-label="라벨"]').getByRole('link', { name: '회의록' }).click();
  await expect(page.getByRole('link', { name: `정책 회의 ${STAMP}` })).toBeVisible();

  // 3) 댓글로 동료를 부른다
  await page.goto(pageUrl);
  await page.locator('section[aria-label="댓글"] .editor .ProseMirror').click();
  await page.keyboard.type(`@${MATE.username} 확인 부탁`);
  await page.getByRole('button', { name: '등록' }).click();
  await expect(page.locator('section[aria-label="댓글"]').getByText('확인 부탁')).toBeVisible();

  // 4) 페이지를 지운다 (휴지통 확인용)
  await page.getByRole('button', { name: '삭제' }).click();
  await expect(page).toHaveURL(/\/spaces\//);

  // 5) 동료로 들어가 **알림함**을 본다
  await page.goto('/');
  await page.getByRole('button', { name: '로그아웃' }).click();
  await login(page, MATE.username, MATE.password);
  await expect(page.getByRole('link', { name: /알림 \(1\)/ })).toBeVisible();
  await page.getByRole('link', { name: /알림/ }).click();
  // 화면은 아이디가 아니라 **이름**을 보여 준다 — 부른 사람이 누구인지는 사람이 읽는 이름이다
  await expect(page.getByText('E2E 관리자님이 불렀다')).toBeVisible();
  // 페이지가 지워졌으므로 갈 곳이 없다고 말한다 (FR-506)
  await expect(page.getByText('(지워진 글)')).toBeVisible();
  await page.getByRole('button', { name: '모두 읽음' }).click();
  await expect(page.getByText('안 읽은 것 0건')).toBeVisible();

  // 6) **휴지통에서 되살린다**
  await page.goto('/trash');
  const row = page.getByRole('listitem').filter({ hasText: `정책 회의 ${STAMP}` });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '되살리기' }).click();
  await expect(page.getByRole('status')).toContainText('되살렸다');

  // 되살아난 페이지가 다시 열린다
  await page.goto(pageUrl);
  await expect(page.getByRole('heading', { name: `정책 회의 ${STAMP}` })).toBeVisible();
});

test('운영 설정을 바꾸면 다시 띄우지 않아도 먹는다 (NFR-40)', async ({ page }) => {
  await login(page, ADMIN.username, ADMIN.password);
  await page.getByRole('link', { name: '운영 설정' }).click();

  // **지금 값을 읽어 다른 값으로 바꾼다.** 정책값은 DB에 남는 전역 상태라, 특정 숫자를
  // 전제하면 두 번째 실행에서 "바꿀 값이 없다"가 된다 (CLAUDE.md 3절 — E2E는 자기 상태를 직접 만든다)
  const field = page.getByLabel('trashRetentionDays');
  const before = Number(await field.inputValue());
  const next = before === 30 ? 15 : 30;
  await field.fill(String(next));
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByRole('status')).toContainText('바로 먹는다');

  // 다시 열어도 바뀐 값이다 — 서버가 DB에서 읽는다
  await page.reload();
  await expect(page.getByLabel('trashRetentionDays')).toHaveValue(String(next));

  // 이 서버의 천장을 넘기면 막고 이유를 말한다 (FR-528)
  await page.getByLabel('uploadMaxMb').fill('9999');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByRole('alert')).toContainText('1024');
});

test('일반 사용자에게는 운영 설정이 보이지 않는다', async ({ page }) => {
  await login(page, MATE.username, MATE.password);
  await expect(page.getByRole('link', { name: '운영 설정' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '휴지통' })).toBeVisible();
});
