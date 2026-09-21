import { expect, test } from '@playwright/test';
import { cleanup, createAdmin, createMember, newAdmin } from './fixtures';

const ADMIN = newAdmin('space');

/**
 * Phase 2 인수 기준 (P2_설계서_Page A.6절).
 * "팀 스페이스를 만들고 Crew를 넣고, 페이지를 작성·편집·이동하고, 이전 버전을 복원할 수 있다.
 *  두 사람이 같은 버전을 저장하면 뒤가 충돌 안내를 받는다"
 */

const mate = { username: `e2e-mate-${Date.now()}`, displayName: 'E2E 동료', password: 'E2e-Mate-2026!' };

test.beforeAll(async () => {
  await createAdmin(ADMIN);
  // 동료는 Crew에 넣을 계정이 필요할 뿐이다. 가입 흐름은 `auth.spec.ts`가 본다 —
  // 가입은 IP별 rate limit이 걸려 있어 스펙마다 부르면 뒤에 도는 것이 먼저 막힌다
  await createMember(mate);
});
test.afterAll(() => cleanup([ADMIN.username, mate.username]));

async function login(page: import('@playwright/test').Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(username);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  // 로그인이 끝나기를 기다린다. 바로 goto하면 진행 중인 요청이 취소된다 (T-019)
  await expect(page).not.toHaveURL(/\/login/);
}

test('스페이스 → Crew → 페이지 작성·편집 → 충돌 → 복원', async ({ page }) => {
  await login(page, ADMIN.username, ADMIN.password);

  // 1) 팀 스페이스를 만든다
  const spaceName = `E2E 공간 ${Date.now()}`;
  await page.goto('/');
  await page.getByLabel('이름').fill(spaceName);
  await page.getByRole('button', { name: '만들기' }).click();
  await expect(page.getByRole('link', { name: spaceName })).toBeVisible();
  await page.getByRole('link', { name: spaceName }).click();

  // 2) Crew를 넣는다
  await page.getByLabel('아이디로 Crew 추가 (editor)').fill(mate.username);
  await page.getByRole('button', { name: '추가' }).click();
  await expect(page.getByText(mate.displayName)).toBeVisible();

  // 3) 페이지를 만든다 → 편집 화면으로 간다
  await page.getByLabel('새 페이지 제목').fill('회의록');
  await page.getByRole('button', { name: '만들기' }).click();
  await expect(page.getByRole('heading', { name: '페이지 편집' })).toBeVisible();

  // 4) 편집하고 저장한다 (v1 → v2)
  await page.locator('.editor .ProseMirror').click();
  await page.keyboard.type('첫 줄이다');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByText('버전 2')).toBeVisible();

  const pageUrl = page.url();

  // 5) **충돌**: 편집 화면을 연 채로 다른 경로에서 먼저 저장하면 뒤가 막힌다
  await page.goto(`${pageUrl}/edit`);
  await expect(page.getByText('편집을 시작한 버전: v2')).toBeVisible();
  // 다른 탭이 먼저 저장한 상황을 API로 만든다 (두 사람이 동시에 편집한 것과 같다)
  const pageId = pageUrl.split('/pages/')[1];
  const res = await page.request.patch(`/api/pages/${pageId}`, {
    headers: { 'x-workfluence-request': '1' },
    data: { title: '먼저 저장됨', content: { type: 'doc', schemaVersion: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '먼저' }] }] }, baseVersionNo: 2 },
  });
  expect(res.status()).toBe(200);

  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByText('다른 사람이 먼저 저장했다')).toBeVisible();
  // **덮어쓰기 버튼을 주지 않는다** (FR-343)
  await expect(page.getByRole('button', { name: /덮어/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '최신 내용 불러오기' })).toBeVisible();

  // 6) 이력에서 v1으로 복원 → 새 버전이 생긴다
  await page.goto(`${pageUrl}/history`);
  await expect(page.getByText('v3')).toBeVisible();
  await page
    .getByRole('listitem')
    .filter({ hasText: /^v1/ })
    .getByRole('button', { name: '이 버전으로 복원' })
    .click();
  await expect(page.getByText('버전 4')).toBeVisible();
});

test('Crew가 아니면 스페이스가 보이지 않는다', async ({ page }) => {
  // 이 테스트는 앞 테스트가 만든 팀 스페이스를 **동료가 못 보는지**가 핵심이다.
  // 개인 스페이스가 보이는 것만 단언하면 제목이 말하는 것을 검증하지 않는다
  const outsider = { username: `e2e-out-${Date.now()}`, displayName: 'E2E 외부인', password: 'E2e-Out-2026!' };
  outsiders.push(outsider.username);
  await createMember(outsider);

  await login(page, outsider.username, outsider.password);
  // 자기 개인 스페이스는 보인다 (FR-309)
  await expect(page.getByText(`${outsider.displayName}의 공간`)).toBeVisible();
  // **앞 테스트의 팀 스페이스는 보이지 않는다** — Crew가 아니다
  await expect(page.getByRole('link', { name: /^E2E 공간/ })).toHaveCount(0);
});

const outsiders: string[] = [];
test.afterAll(() => cleanup(outsiders));
