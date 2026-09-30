import { expect, test, type Page } from '@playwright/test';
import { cleanup, createAdmin, createMember, newAdmin } from './fixtures';

const ADMIN = newAdmin('format');
const mate = { username: `e2e-format-mate-${Date.now()}`, displayName: 'E2E 서식동료', password: 'E2e-Mate-2026!' };

/**
 * **Phase 19 인수 기준 — 서식 단추 줄** (P19_설계서_Recovery B.2·D.3, F-013). "편집 화면의 본문 칸 위 서식 단추 줄로 제목·굵게·목록·인용·코드 블록·링크·표(행·열
 * 더하기·지우기)를 넣고 되돌리며, 실시간 편집에서도 동료에게 보이고 저장된다. 댓글 칸 위에는 짧은 줄이 있다."
 *
 * 단추는 편집기 명령을 부를 뿐이라 관문(P9·P12)이 받아야 한다 — **실제로 지나는지** 두 브라우저로 본다: 끊기지 않고, 동료에게 보이고, 저장본에 남는다
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

test('서식 단추로 제목·굵게·목록·링크·표를 넣으면 동료에게 보이고 끊기지 않고 저장된다 — 되돌리기는 내 편집만', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await login(a, ADMIN.username, ADMIN.password);

  const spaceName = `서식 공간 ${Date.now()}`;
  await a.goto('/');
  await a.getByLabel('이름').fill(spaceName);
  await a.getByRole('button', { name: '만들기', exact: true }).click();
  await a.getByRole('link', { name: spaceName }).click();
  await a.getByLabel('아이디로 Crew 추가').fill(mate.username);
  await a.getByRole('button', { name: '추가' }).click();
  await a.getByLabel('새 페이지 제목').fill(`서식 문서 ${Date.now()}`);
  await a.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(a.getByRole('heading', { name: '페이지 편집' })).toBeVisible();
  const pageId = /\/pages\/([0-9a-f-]+)/.exec(a.url())?.[1] ?? '';
  await login(b, mate.username, mate.password);
  await b.goto(`/pages/${pageId}/edit`);
  await expect(a.getByText(/같이 보는 사람/)).toBeVisible({ timeout: 15_000 });
  await expect(b.getByText(/같이 보는 사람/)).toBeVisible({ timeout: 15_000 });

  const bar = a.getByRole('toolbar', { name: '서식' });
  await expect(bar).toBeVisible();
  const editor = a.locator('.editor .ProseMirror');
  await editor.click();

  // 제목 1
  await bar.getByRole('combobox', { name: '문단 형식' }).selectOption('h1');
  await a.keyboard.type('서식 제목');
  await a.keyboard.press('Enter');
  // 굵게 — 켜고 쓰고 끈다
  await bar.getByRole('button', { name: '굵게' }).click();
  await expect(bar.getByRole('button', { name: '굵게' })).toHaveAttribute('aria-pressed', 'true');
  await a.keyboard.type('굵은글');
  await bar.getByRole('button', { name: '굵게' }).click();
  await a.keyboard.type(' 보통글');
  await a.keyboard.press('Enter');
  // 글머리 목록
  await bar.getByRole('button', { name: '글머리 목록' }).click();
  await a.keyboard.type('첫 항목');
  await a.keyboard.press('Enter');
  await a.keyboard.press('Enter');
  // 링크 — 고른 글이 없으면 주소를 글로 넣는다. 안 되는 주소는 까닭을 보이고 닫지 않는다
  await bar.getByRole('button', { name: '링크' }).click();
  const dialog = a.getByRole('dialog', { name: '링크' });
  await dialog.getByLabel('주소').fill('mailto:user@example.internal');
  await dialog.getByRole('button', { name: '링크 넣기' }).click();
  await expect(dialog.getByText('http(s)로 시작하는 주소나')).toBeVisible();
  await dialog.getByLabel('주소').fill('https://example.internal/서식');
  await dialog.getByRole('button', { name: '링크 넣기' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(editor.locator('a[href="https://example.internal/서식"]')).toHaveCount(1);
  await a.keyboard.press('End');
  await a.keyboard.press('Enter');

  // 되돌리기는 내 편집만 — 쉬었다 쓴 글 한 덩이를 되돌린다(Yjs의 되돌리기)
  await a.waitForTimeout(800);
  await a.keyboard.type('지울글');
  await expect(editor).toContainText('지울글');
  await a.waitForTimeout(800);
  await bar.getByRole('button', { name: '되돌리기' }).click();
  await expect(editor).not.toContainText('지울글');
  await expect(editor).toContainText('서식 제목');

  // 표 — 3×3(머리 줄), 표 안에서는 표 무리가 붙는다. 아래에 행을 하나 더한다
  await editor.click();
  await a.keyboard.press('Control+End');
  await bar.getByRole('button', { name: '표 넣기' }).click();
  const tableGroup = bar.getByRole('group', { name: '표' });
  await expect(tableGroup).toBeVisible();
  await a.keyboard.type('머리칸');
  await tableGroup.getByRole('button', { name: '아래에 행' }).click();
  await expect(editor.locator('table tr')).toHaveCount(4);

  // 동료에게 보인다 — 관문이 받았다
  const other = b.locator('.editor .ProseMirror');
  await expect(other.locator('h1')).toContainText('서식 제목', { timeout: 15_000 });
  await expect(other.locator('strong')).toContainText('굵은글');
  await expect(other.locator('ul li')).toContainText('첫 항목');
  await expect(other.locator('a[href="https://example.internal/서식"]')).toHaveCount(1);
  await expect(other.locator('table tr')).toHaveCount(4, { timeout: 15_000 });
  await expect(other.locator('th')).toContainText(['머리칸']);
  // 끊기지 않았다 — 거절·끊김 알림이 없다
  for (const p of [a, b]) {
    await expect(p.getByText('서버가 이 편집을 받지 않았다')).toHaveCount(0);
    await expect(p.getByText('연결이 끊겼다')).toHaveCount(0);
  }

  // 저장본에 남는다
  await a.getByRole('button', { name: '저장하고 보기로' }).click();
  await expect(a).not.toHaveURL(/\/edit$/, { timeout: 15_000 });
  const body = a.locator('.editor.readonly').first();
  await expect(body.locator('h1')).toContainText('서식 제목');
  await expect(body.locator('strong')).toContainText('굵은글');
  await expect(body.locator('ul li')).toContainText('첫 항목');
  await expect(body.locator('a[href="https://example.internal/서식"]')).toHaveCount(1);
  await expect(body.locator('table tr')).toHaveCount(4);
  await expect(body).not.toContainText('지울글');

  // 댓글 칸에는 짧은 줄 — 굵게로 쓴 댓글이 굵게 남는다
  const commentBar = a.getByRole('toolbar', { name: '서식' });
  await expect(commentBar.getByRole('button')).toHaveCount(6);
  await a.getByRole('textbox', { name: '댓글 쓰기' }).click();
  await commentBar.getByRole('button', { name: '굵게' }).click();
  await a.keyboard.type('굵은 댓글');
  await a.getByRole('button', { name: '등록' }).click();
  await expect(a.getByRole('region', { name: '댓글' }).locator('.editor.readonly strong')).toContainText('굵은 댓글');

  await ctxA.close();
  await ctxB.close();
});
