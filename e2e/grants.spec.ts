import { expect, test, type Browser, type Page } from '@playwright/test';
import { cleanup, createAdmin, createMember, newAdmin } from './fixtures';

/**
 * Phase 15 인수 기준 (scope-definition 5절, P15_설계서_Grants K.5). "관리자가 건 중지를 권한을 받은 주인이 푼다" · "남이 쓰는 분류는 만든 사람이
 * 지우지 못하고, 관리자가 지우면 쓰던 공간이 분류 없음이 된다"
 */

const STAMP = Date.now();
const ADMIN = newAdmin('grants');
const OWNER = { username: `e2e-gr-owner-${STAMP}`, displayName: 'E2E 주인', password: 'E2e-Owner-2026!' };
const MAKER = { username: `e2e-gr-maker-${STAMP}`, displayName: 'E2E 분류 주인', password: 'E2e-Maker-2026!' };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await createAdmin(ADMIN);
  await createMember(OWNER);
  await createMember(MAKER);
});
test.afterAll(() => cleanup([ADMIN.username, OWNER.username, MAKER.username]));

async function login(page: Page, u: { username: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(u.username);
  await page.getByLabel('비밀번호').fill(u.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function as(browser: Browser, u: { username: string; password: string }): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await login(page, u);
  return page;
}

/** 첫 화면에서 팀 스페이스를 만들고 그 스페이스로 들어간다 */
async function newTeamSpace(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('이름').fill(name);
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

test('**관리자가 건 중지는 권한을 받은 주인만 푼다** — 받기 전에는 까닭을 듣고, 관리자가 사용자 관리에서 주면 다시 쓰기로 푼다 (FR-1600·1611·1612)', async ({ browser }) => {
  const spaceName = `E2E 맡김 ${STAMP}`;
  const owner = await as(browser, OWNER);
  await newTeamSpace(owner, spaceName);
  const spaceUrl = owner.url();

  // 관리자가 모든 스페이스에서 찾아 중지한다 — 주인이 아닌 사람이 건 중지다
  const admin = await as(browser, ADMIN);
  await admin.goto('/admin/spaces');
  await admin.getByRole('searchbox').fill(spaceName);
  const row = admin.getByRole('row').filter({ has: admin.getByRole('link', { name: spaceName }) });
  await expect(row).toHaveCount(1);
  admin.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: '중지' }).click();
  await expect(row.locator('td').nth(3)).toHaveText('중지 관리자가 걸었다');

  // 주인은 풀지 못한다 — 관리 칸이 까닭을 말하고 다시 쓰기 단추가 없다
  await owner.goto(spaceUrl);
  const manage = owner.getByRole('region', { name: '스페이스 관리' });
  await expect(manage.getByRole('note')).toContainText('관리자가 중지한 스페이스다.');
  await expect(manage.getByRole('note')).toContainText('주인도 다시 쓰기로 풀지 못한다');
  await expect(manage.getByRole('button', { name: '다시 쓰기' })).toHaveCount(0);

  // 관리자가 그 사람에게 "관리자가 건 중지 풀기"를 준다 — member 줄에 셋이 있다
  await admin.goto('/admin/users');
  await admin.getByRole('searchbox').fill(OWNER.username);
  const box = admin.getByRole('checkbox', { name: `${OWNER.username} 관리자가 건 중지 풀기` });
  await expect(admin.getByRole('checkbox', { name: `${OWNER.username} 분류 관리` })).toBeVisible();
  await expect(admin.getByRole('checkbox', { name: `${OWNER.username} 스페이스 관리 전체` })).toBeVisible();
  await expect(admin.getByRole('checkbox', { name: `${OWNER.username} LLM 연결 관리` })).toHaveCount(0);
  const [given] = await Promise.all([admin.waitForResponse((r) => r.url().endsWith('/grants') && r.request().method() === 'PUT'), box.click()]);
  expect(given.status()).toBe(200);
  await expect(box).toBeChecked();

  // 다음 요청부터 먹는다 — 새로 고치면 다시 쓰기가 보이고, 누르면 쓸 수 있다
  await owner.reload();
  await manage.getByRole('button', { name: '다시 쓰기' }).click();
  await expect(manage.getByRole('status')).toHaveText('다시 쓸 수 있게 했다.');
  await expect(owner.getByLabel('새 페이지 제목')).toBeVisible();
  await owner.context().close();
  await admin.context().close();
});

test('**분류는 누구나 만들고, 남이 쓰면 만든 사람은 못 지운다** — 관리자가 지우면 쓰던 공간은 분류 없음이 된다 (FR-1620~1624)', async ({ browser }) => {
  const category = `E2E 맡김 분류 ${STAMP}`;
  const teamName = `E2E 남의 공간 ${STAMP}`;

  // 만든 사람이 자기 개인 공간의 관리 칸에서 새 분류를 만든다 — 고른 상태가 되고, 저장해야 붙는다
  const maker = await as(browser, MAKER);
  await maker.getByRole('link', { name: `${MAKER.displayName}의 공간` }).click();
  const makerManage = maker.getByRole('region', { name: '스페이스 관리' });
  await makerManage.getByLabel('새 분류').fill(category);
  await makerManage.getByRole('button', { name: '분류 만들기' }).click();
  await expect(makerManage.getByRole('status')).toHaveText(`분류 "${category}"을(를) 만들어 골랐다 — 저장을 누르면 붙는다.`);
  await makerManage.getByRole('button', { name: '저장' }).click();
  await expect(makerManage.getByRole('status')).toHaveText('저장했다.');
  // 자기 공간만 쓰는 동안은 만든 사람이 바꾸고 지운다 — 분류 관리에 보인다
  await expect(makerManage.getByLabel(`분류 ${category} 이름`)).toBeVisible();

  // 다른 사람이 자기 팀 공간에 그 분류를 붙인다
  const owner = await as(browser, OWNER);
  await newTeamSpace(owner, teamName);
  const ownerManage = owner.getByRole('region', { name: '스페이스 관리' });
  await ownerManage.getByLabel('분류', { exact: true }).selectOption({ label: category });
  await ownerManage.getByRole('button', { name: '저장' }).click();
  await expect(ownerManage.getByRole('status')).toHaveText('저장했다.');

  // 이제 남의 공간이 쓴다 — 만든 사람의 분류 관리에서 사라지고, 서버도 거절한다
  await maker.reload();
  await expect(makerManage.getByLabel(`분류 ${category} 이름`)).toHaveCount(0);
  await expect(makerManage.getByText(/내가 만들어 이름을 바꾸거나 지울 수 있는 분류가 없다/)).toBeVisible();
  const categoryId = await maker.evaluate(async (name) => {
    const list = (await (await fetch('/api/categories')).json()) as { id: string; name: string }[];
    return list.find((c) => c.name === name)?.id;
  }, category);
  expect(categoryId).toBeTruthy();
  const denied = await maker.evaluate(
    // 상태를 바꾸는 요청에는 CSRF 머리글이 있어야 한다(7절) — 화면이 보내는 것과 같게
    async (id) => (await fetch(`/api/categories/${id}`, { method: 'DELETE', headers: { 'x-workfluence-request': '1' } })).status,
    categoryId!,
  );
  expect(denied).toBe(403);

  // 관리자가 지운다 — 몇 개가 분류 없음이 되는지 묻고, 두 공간 모두 분류 없음이 된다
  const admin = await as(browser, ADMIN);
  await admin.goto('/admin/spaces');
  const item = admin.getByRole('region', { name: '분류' }).getByRole('listitem').filter({ has: admin.getByLabel(`분류 ${category} 이름`) });
  await expect(item).toContainText('공간 2개 (만든 사람의 것이 아닌 공간 1개)');
  const asked = new Promise<string>((ok) =>
    admin.once('dialog', (d) => {
      ok(d.message());
      void d.accept();
    }),
  );
  await item.getByRole('button', { name: '지우기' }).click();
  expect(await asked).toContain('이 분류를 쓰는 공간 2개(휴지통 포함)가 "분류 없음"이 된다');
  await expect(admin.getByRole('status')).toHaveText(`분류 "${category}"을(를) 지웠다 — 쓰던 공간 2개는 분류 없음이 됐다.`);
  await admin.getByRole('searchbox').fill(teamName);
  const row = admin.getByRole('row').filter({ has: admin.getByRole('link', { name: teamName }) });
  await expect(row.locator('td').nth(4)).toHaveText('—');
  await owner.reload();
  await expect(ownerManage.getByLabel('분류', { exact: true })).toHaveValue('');
  for (const p of [maker, owner, admin]) await p.context().close();
});
