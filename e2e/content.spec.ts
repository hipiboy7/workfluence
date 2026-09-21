import { expect, test } from '@playwright/test';
import { cleanup, createAdmin, createMember, newAdmin } from './fixtures';

const ADMIN = newAdmin('content');

/**
 * Phase 3 인수 기준 (scope-definition 5절).
 * "한글 질의로 페이지가 검색되고 파일이 첨부된다"
 */

test.beforeAll(async () => {
  await createAdmin(ADMIN);
  await createMember(OUTSIDER);
});
test.afterAll(() => cleanup([ADMIN.username, OUTSIDER.username]));

const OUTSIDER = { username: `e2e-out3-${Date.now()}`, displayName: 'E2E 외부인3', password: 'E2e-Out3-2026!' };

async function login(page: import('@playwright/test').Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(username);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  // **로그인이 끝나기를 기다린다.** 바로 goto하면 진행 중인 요청이 취소돼
  // 로그인하지 않은 채로 다음 화면에 간다 (실제로 겪었다 — T-018)
  await expect(page).not.toHaveURL(/\/login/);
}

// 한글 두 글자로 찾을 말. 다른 실행과 섞이지 않게 뒤에 시각을 붙인 제목을 쓴다
const STAMP = Date.now();
const TITLE = `결산 보고 ${STAMP}`;

test('검색 → 첨부 → 댓글', async ({ page }) => {
  await login(page, ADMIN.username, ADMIN.password);

  // 1) 스페이스와 페이지를 만들고 본문에 한글을 넣는다
  const spaceName = `E2E 내용 ${STAMP}`;
  await page.goto('/');
  await page.getByLabel('이름').fill(spaceName);
  await page.getByRole('button', { name: '만들기' }).click();
  await page.getByRole('link', { name: spaceName }).click();

  await page.getByLabel('새 페이지 제목').fill(TITLE);
  await page.getByRole('button', { name: '만들기' }).click();
  await expect(page.getByRole('heading', { name: '페이지 편집' })).toBeVisible();
  await page.locator('.editor .ProseMirror').click();
  await page.keyboard.type('올해 결산 내용을 적는다');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByText('버전 2')).toBeVisible();
  const pageUrl = page.url();

  // 2) **한글 두 글자로 찾는다** (인수 기준)
  await page.goto('/');
  await page.getByRole('link', { name: '검색' }).click();
  await page.getByLabel('찾을 말').fill('결산');
  await page.getByRole('button', { name: '찾기' }).click();
  await expect(page.getByRole('link', { name: TITLE })).toBeVisible();
  await expect(page.getByText(spaceName)).toBeVisible();
  await page.getByRole('link', { name: TITLE }).click();

  // 3) 파일을 첨부하고 내려받는다
  await page.getByLabel('첨부할 파일').setInputFiles({ name: '보고서.txt', mimeType: 'text/plain', buffer: Buffer.from('합성 데이터다') });
  const link = page.getByRole('link', { name: '보고서.txt' });
  await expect(link).toBeVisible();

  const href = await link.getAttribute('href');
  const dl = await page.request.get(href!);
  expect(dl.status()).toBe(200);
  // 브라우저가 내용을 보고 형식을 짐작해 실행하지 않게 한다 (FR-417)
  expect(dl.headers()['x-content-type-options']).toBe('nosniff');
  expect(dl.headers()['content-disposition']).toContain('attachment');
  expect(await dl.text()).toBe('합성 데이터다');

  // 허용하지 않는 확장자는 막힌다 (FR-414)
  await page.getByLabel('첨부할 파일').setInputFiles({ name: 'bad.exe', mimeType: 'application/pdf', buffer: Buffer.from('MZ') });
  await expect(page.getByRole('alert')).toContainText('허용하지 않는 확장자');

  // 4) 댓글과 대댓글
  await page.locator('section[aria-label="댓글"] .editor .ProseMirror').click();
  await page.keyboard.type('확인했다');
  await page.getByRole('button', { name: '등록' }).click();
  await expect(page.locator('section[aria-label="댓글"]').getByText('확인했다')).toBeVisible();

  await page.getByRole('button', { name: '답하기' }).click();
  await page.locator('section[aria-label="댓글"] .editor .ProseMirror').last().click();
  await page.keyboard.type('고맙다');
  await page.getByRole('button', { name: '등록' }).click();
  await expect(page.locator('section[aria-label="댓글"]').getByText('고맙다')).toBeVisible();
  // 대댓글에는 답하기가 없다 (FR-421) — 원 댓글 하나에만 있다
  await expect(page.getByRole('button', { name: '답하기' })).toHaveCount(1);

  await expect(page).toHaveURL(pageUrl);
});

test('볼 수 없는 스페이스의 페이지는 검색 결과에 없다 (인수 기준)', async ({ page }) => {
  // 앞 테스트가 만든 팀 스페이스의 페이지를 찾아본다. 이 사람은 Crew가 아니다
  await login(page, OUTSIDER.username, OUTSIDER.password);
  await page.goto('/search?q=결산');
  await expect(page.getByText('찾은 것이 없다', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: TITLE })).toHaveCount(0);
});
