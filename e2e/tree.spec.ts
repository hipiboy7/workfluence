import { expect, test, type Page } from '@playwright/test';
import { cleanup, createAdmin, newAdmin } from './fixtures';

const ADMIN = newAdmin('tree');

/**
 * Phase 14 인수 기준 (P14_설계서_Spaces C.1, F-007). "페이지 트리에서 하위 페이지를 만들고, 페이지를 옮긴다" — 새 부모와 자리를 고르고, 트리가
 * 그 순서와 들여쓰기로 그려진다. 자리는 형제 가운데 몇 번째다(서버가 다시 매긴다)
 */

test.beforeAll(async () => {
  await createAdmin(ADMIN);
});
test.afterAll(() => cleanup([ADMIN.username]));

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(username);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test('하위 페이지를 만들고 옮긴다 — 트리가 새 자리와 들여쓰기로 그려진다 (FR-1500~1502)', async ({ page }) => {
  await login(page, ADMIN.username, ADMIN.password);
  const spaceName = `E2E 트리 ${Date.now()}`;
  await page.goto('/');
  await page.getByLabel('이름').fill(spaceName);
  await page.getByRole('button', { name: '만들기' }).click();
  await page.getByRole('link', { name: spaceName }).click();
  await expect(page.getByRole('heading', { name: spaceName })).toBeVisible();
  const spaceUrl = page.url();
  const tree = page.getByRole('list', { name: '페이지 트리' });
  // 그 페이지의 줄 — 트리는 목록 안의 목록이라 조상 줄도 그 이름을 담는다. 링크에서 가장 가까운 줄을 잡는다
  const line = (title: string) => tree.getByRole('link', { name: title, exact: true }).locator('xpath=ancestor::li[1]');
  // 화면에서 그 링크가 시작하는 자리 — 단계마다 16px여야 한다(안쪽 목록의 기본 들여쓰기가 더해지면 56px였다 — 반영분 점검 3)
  const left = async (title: string) => (await tree.getByRole('link', { name: title, exact: true }).boundingBox())!.x;

  // 맨 위에 둘을 만든다
  for (const title of ['회의록', '규정']) {
    await page.getByLabel('새 페이지 제목').fill(title);
    await page.getByRole('button', { name: '만들기' }).click();
    await expect(page.getByRole('heading', { name: '페이지 편집' })).toBeVisible();
    await page.goto(spaceUrl);
  }

  // 1) 페이지 보기의 하위 페이지 만들기 → 스페이스 화면의 새 페이지 칸에 그 부모가 골라져 있다
  await tree.getByRole('link', { name: '회의록' }).click();
  await page.getByRole('link', { name: '하위 페이지 만들기' }).click();
  await expect(page.getByLabel('위치').locator('option:checked')).toHaveText(/회의록/);
  await page.getByLabel('새 페이지 제목').fill('9월 회의');
  await page.getByRole('button', { name: '만들기' }).click();
  await expect(page.getByRole('heading', { name: '페이지 편집' })).toBeVisible();
  await page.goto(spaceUrl);
  await expect(tree.getByRole('listitem')).toHaveText([/^회의록/, /^9월 회의/, /^규정/]);
  // 9월 회의는 회의록 줄 안의 목록에 들여 있다
  await expect(line('9월 회의')).toHaveCSS('margin-left', '16px');
  await expect(line('회의록').getByRole('list').getByRole('link')).toHaveText(['9월 회의']);
  await expect(line('규정')).toHaveCSS('margin-left', '0px');
  expect((await left('9월 회의')) - (await left('회의록'))).toBe(16);

  // 2) 옮기기 — 9월 회의를 맨 위의 맨 앞으로
  await tree.getByRole('link', { name: '9월 회의' }).click();
  await page.getByRole('button', { name: '옮기기' }).click();
  const mover = page.getByRole('region', { name: '페이지 옮기기' });
  await mover.getByLabel('어디 아래로').selectOption({ label: '맨 위' });
  await mover.getByLabel('자리').selectOption({ label: '맨 앞' });
  await mover.getByRole('button', { name: '옮기기' }).click();
  await expect(page).toHaveURL(spaceUrl);
  await expect(tree.getByRole('listitem')).toHaveText([/^9월 회의/, /^회의록/, /^규정/]);
  await expect(line('9월 회의')).toHaveCSS('margin-left', '0px');

  // 3) 회의록을 규정 아래로 — 자기와 그 아래는 새 부모 목록에 없다
  await tree.getByRole('link', { name: '회의록' }).click();
  await page.getByRole('button', { name: '옮기기' }).click();
  await expect(mover.getByLabel('어디 아래로').locator('option')).toHaveText(['맨 위', '9월 회의', '규정']);
  await mover.getByLabel('어디 아래로').selectOption({ label: '규정' });
  await mover.getByRole('button', { name: '옮기기' }).click();
  await expect(page).toHaveURL(spaceUrl);
  await expect(tree.getByRole('listitem')).toHaveText([/^9월 회의/, /^규정/, /^회의록/]);
  await expect(line('회의록')).toHaveCSS('margin-left', '16px');
  await expect(line('규정').getByRole('list').getByRole('link')).toHaveText(['회의록']);
  expect((await left('회의록')) - (await left('규정'))).toBe(16);
});
