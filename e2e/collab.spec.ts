import { expect, test, type Page } from '@playwright/test';
import { cleanup, createAdmin, createMember, newAdmin } from './fixtures';

const ADMIN = newAdmin('collab');
const mate = { username: `e2e-collab-mate-${Date.now()}`, displayName: 'E2E 협업동료', password: 'E2e-Mate-2026!' };

/**
 * Phase 6 인수 기준 (P6_설계서_Collab B절).
 * "두 사람이 같은 페이지를 동시에 고치면 서로의 입력이 보이고, 편집이 멈추면 버전이 남는다.
 *  두 버전을 골라 무엇이 바뀌었는지 보고, HTML 한 파일로 내보낼 수 있다."
 */

test.beforeAll(async () => {
  await createAdmin(ADMIN);
  await createMember(mate);
});
test.afterAll(() => cleanup([ADMIN.username, mate.username]));

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(username);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test('두 사람이 같은 페이지를 동시에 고치면 서로 보이고, 멈추면 버전이 남는다', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await login(a, ADMIN.username, ADMIN.password);

  // 팀 스페이스와 페이지를 만들고 동료를 Crew에 넣는다
  const spaceName = `협업 공간 ${Date.now()}`;
  await a.goto('/');
  await a.getByLabel('이름').fill(spaceName);
  await a.getByRole('button', { name: '만들기' }).click();
  await a.getByRole('link', { name: spaceName }).click();
  await a.getByLabel('아이디로 Crew 추가 (editor)').fill(mate.username);
  await a.getByRole('button', { name: '추가' }).click();

  const pageTitle = `협업 문서 ${Date.now()}`;
  await a.getByLabel('새 페이지 제목').fill(pageTitle);
  await a.getByRole('button', { name: '만들기' }).click();
  // 만들면 **편집 화면으로 바로 간다** (Phase 2의 흐름)
  await expect(a.getByRole('heading', { name: '페이지 편집' })).toBeVisible();
  const pageId = /\/pages\/([0-9a-f-]+)/.exec(a.url())?.[1] ?? '';
  expect(pageId).not.toBe('');
  await login(b, mate.username, mate.password);
  await b.goto(`/pages/${pageId}/edit`);

  // **연결됐다고 화면이 말해야 한다** — 조용히 끊긴 채 쓰는 것이 가장 나쁜 실패다
  await expect(a.getByText(/같이 보는 사람/)).toBeVisible({ timeout: 15_000 });
  await expect(b.getByText(/같이 보는 사람/)).toBeVisible({ timeout: 15_000 });

  // A가 쓴 것이 B에 보인다
  const mark = `A가쓴글${Date.now()}`;
  await a.locator('.editor .ProseMirror').click();
  await a.keyboard.type(mark);
  await expect(b.locator('.editor .ProseMirror')).toContainText(mark, { timeout: 15_000 });

  // B가 쓴 것이 A에 보인다
  const markB = `B가쓴글${Date.now()}`;
  await b.locator('.editor .ProseMirror').click();
  await b.keyboard.press('End');
  await b.keyboard.type(markB);
  await expect(a.locator('.editor .ProseMirror')).toContainText(markB, { timeout: 15_000 });

  // 서로의 이름이 보인다 (FR-705) — **두 곳에서** 보여야 한다:
  // 같이 보는 사람 목록과, 그 사람 커서에 붙은 이름표
  await expect(a.getByText(`같이 보는 사람: ${mate.displayName}`)).toBeVisible({ timeout: 15_000 });
  await expect(a.locator('.collaboration-carets__label', { hasText: mate.displayName })).toBeVisible({ timeout: 15_000 });

  // 편집을 멈추면 버전이 남는다 (FR-706). 유휴 5초 + 여유
  await a.waitForTimeout(9_000);
  await a.goto(`/pages/${pageId}`);
  // 보기 화면에는 읽기 전용 편집기가 여럿 있다(본문·댓글). 첫 번째가 본문이다
  const body = a.locator('.editor.readonly').first();
  await expect(body).toContainText(mark);
  await expect(body).toContainText(markB);
  await expect(a.getByText(/버전 [2-9]/)).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

test('두 버전을 골라 비교하고 HTML로 내보낸다', async ({ page }) => {
  await login(page, ADMIN.username, ADMIN.password);

  const spaceName = `비교 공간 ${Date.now()}`;
  await page.goto('/');
  await page.getByLabel('이름').fill(spaceName);
  await page.getByRole('button', { name: '만들기' }).click();
  await page.getByRole('link', { name: spaceName }).click();

  const pageTitle = `비교 문서 ${Date.now()}`;
  await page.getByLabel('새 페이지 제목').fill(pageTitle);
  await page.getByRole('button', { name: '만들기' }).click();
  await expect(page.getByRole('heading', { name: '페이지 편집' })).toBeVisible();
  const pageId = /\/pages\/([0-9a-f-]+)/.exec(page.url())?.[1] ?? '';

  // 두 번 고쳐 버전을 셋으로 만든다 (실시간 편집이 자동 저장한다)
  for (const word of ['처음내용', '고친내용']) {
    await page.goto(`/pages/${pageId}/edit`);
    await expect(page.getByText(/같이 보는 사람|연결 중/)).toBeVisible({ timeout: 15_000 });
    await page.locator('.editor .ProseMirror').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(word);
    await page.waitForTimeout(8_000);
  }

  // 비교
  await page.goto(`/pages/${pageId}/history`);
  const boxes = page.getByRole('checkbox', { name: '비교' });
  await expect(boxes.first()).toBeVisible();
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.getByRole('button', { name: '비교하기' }).click();
  await expect(page.locator('.diff')).toBeVisible();
  await expect(page.locator('.diff')).toContainText(/변경|추가|삭제/);

  // 내보내기 — **파일로 내려와야 한다** (FR-730)
  await page.goto(`/pages/${pageId}`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'HTML로 내보내기' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.html$/);
});
