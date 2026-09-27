import { expect, test, type Page } from '@playwright/test';
import { cleanup, createAdmin, createMember, newAdmin } from './fixtures';

const ADMIN = newAdmin('spaces');
const MATE = { username: `e2e-sp-mate-${Date.now()}`, displayName: 'E2E 스페이스 동료', password: 'E2e-Mate-2026!' };

/**
 * Phase 14 인수 기준 (P14_설계서_Spaces C.2, F-008). "관리자가 화면에서 스페이스를 관리한다" — 모든 스페이스에서 찾아 중지·다시 쓰기, 분류 만들기·
 * 바꾸기(쓰는 스페이스가 있으면 지우지 못한다), 스페이스 화면의 관리 칸, Crew를 viewer로 넣고 역할을 바꾼다
 */

test.beforeAll(async () => {
  await createAdmin(ADMIN);
  await createMember(MATE);
});
test.afterAll(() => cleanup([ADMIN.username, MATE.username]));

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(username);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test('관리자가 스페이스를 찾아 중지하고 다시 쓰게 하며, 분류와 Crew 역할을 바꾼다 (FR-1510~1515)', async ({ page }) => {
  await login(page, ADMIN.username, ADMIN.password);
  const stamp = Date.now();
  const category = `E2E 분류 ${stamp}`;
  const spaceName = `E2E 관리 ${stamp}`;

  // 1) 관리 콘솔에서 분류를 만든다
  await page.goto('/');
  await page.getByRole('link', { name: '스페이스 관리' }).click();
  await expect(page.getByRole('heading', { name: '스페이스 관리' })).toBeVisible();
  await page.getByLabel('새 분류').fill(category);
  await page.getByRole('button', { name: '만들기' }).click();
  await expect(page.getByLabel(`분류 ${category} 이름`)).toBeVisible();

  // 2) 팀 스페이스를 만들고 — Crew를 viewer로 넣고 editor로 바꾼다
  await page.goto('/');
  await page.getByLabel('이름').fill(spaceName);
  await page.getByRole('button', { name: '만들기' }).click();
  await page.getByRole('link', { name: spaceName }).click();
  await page.getByLabel('아이디로 Crew 추가').fill(MATE.username);
  await page.getByLabel('역할', { exact: true }).selectOption('viewer');
  await page.getByRole('button', { name: '추가' }).click();
  const mateRole = page.getByLabel(`${MATE.username} 역할`);
  await expect(mateRole).toHaveValue('viewer');
  await mateRole.selectOption('editor');
  await expect(mateRole).toHaveValue('editor');

  // 3) 관리 칸 — 분류를 고르고 설명을 적어 저장한다
  const manage = page.getByRole('region', { name: '스페이스 관리' });
  await manage.getByLabel('분류').selectOption({ label: category });
  await manage.getByLabel('설명').fill('관리 화면에서 적은 설명');
  await manage.getByRole('button', { name: '저장' }).click();
  await expect(manage.getByRole('status')).toHaveText('저장했다.');
  await expect(page.getByText(`팀 · `).first()).toContainText(category);

  // 4) 모든 스페이스에서 찾아 중지한다 — 한 번 더 묻는다
  await page.goto('/admin/spaces');
  await page.getByRole('searchbox').fill(spaceName);
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: spaceName }) });
  await expect(row).toHaveCount(1);
  await expect(page.getByRole('link', { name: spaceName })).toHaveCount(1);
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: '중지' }).click();
  await expect(row.getByText('중지', { exact: true })).toBeVisible();

  // 중지된 스페이스는 읽기만 된다 — 새 페이지 칸이 없다
  await row.getByRole('link', { name: spaceName }).click();
  await expect(page.getByText('중지됨 — 읽기만 된다')).toBeVisible();
  await expect(page.getByLabel('새 페이지 제목')).toHaveCount(0);

  // 5) 분류는 쓰는 스페이스가 있어 지우지 못한다 — 서버의 까닭이 보인다
  await page.goto('/admin/spaces');
  const catItem = page.getByRole('region', { name: '분류' }).getByRole('listitem').filter({ has: page.getByLabel(`분류 ${category} 이름`) });
  page.once('dialog', (d) => void d.accept());
  await catItem.getByRole('button', { name: '지우기' }).click();
  await expect(page.getByRole('alert')).toContainText('이 분류를 쓰는 스페이스가 1개 있다');

  // 6) 다시 쓰게 한다 — 묻지 않는다
  await page.getByRole('searchbox').fill(spaceName);
  await row.getByRole('button', { name: '다시 쓰기' }).click();
  await expect(row.getByRole('button', { name: '중지' })).toBeVisible();
  await row.getByRole('link', { name: spaceName }).click();
  await expect(page.getByLabel('새 페이지 제목')).toBeVisible();
});
