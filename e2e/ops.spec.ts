import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { cleanup, createAdmin } from './fixtures';

/**
 * Phase 11 인수 기준 (scope-definition 5절, P11_설계서_Ops K.8).
 * "시스템 관리자가 사용자 관리에서 관리자 한 사람에게 LLM 연결 관리를 주면 그 관리자가 LLM을 등록할 수 있고, 거두면 다음 요청부터
 *  막힌다" · "오류 한 줄의 요청 식별자로 같은 요청의 … 감사로그 행을 찾는다"
 *
 * nginx를 거친 요청 번호(nginx가 만들어 넘긴다)는 컨테이너 확인이 본다 — 여기는 앱에 바로 붙는다.
 */

const STAMP = Date.now();
const ROOT = { username: `e2e-root-ops-${STAMP}`, password: 'E2e-Root-2026!' };
const BOSS = { username: `e2e-boss-ops-${STAMP}`, password: 'E2e-Boss-2026!' };
const LLM = `E2E 위임 LLM ${STAMP}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await createAdmin(ROOT, 'root');
  await createAdmin(BOSS, 'admin');
});
test.afterAll(async () => {
  await cleanup([ROOT.username, BOSS.username]);
});

async function login(page: Page, u: { username: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(u.username);
  await page.getByLabel('비밀번호').fill(u.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

const grantsResponse = (page: Page) => page.waitForResponse((r) => r.url().endsWith('/grants') && r.request().method() === 'PUT');

test('**시스템 관리자가 관리자에게 LLM 연결 관리를 주면** 그 관리자가 LLM을 등록한다 — 거두면 다음 요청부터 막힌다', async ({ page, browser }) => {
  const bossContext = await browser.newContext();
  const boss = await bossContext.newPage();
  await login(boss, BOSS);
  // 처음에는 관리자에게 LLM 연결 메뉴가 없다
  await expect(boss.getByRole('link', { name: '사용자 관리' })).toBeVisible();
  await expect(boss.getByRole('link', { name: 'LLM 연결' })).toHaveCount(0);

  // root가 준다
  await login(page, ROOT);
  await page.getByRole('link', { name: '사용자 관리' }).click();
  const box = page.getByRole('checkbox', { name: `${BOSS.username} LLM 연결 관리` });
  const [given] = await Promise.all([grantsResponse(page), box.click()]);
  expect(given.status()).toBe(200);
  await expect(box).toBeChecked();

  // **감사 행이 그 응답의 요청 번호를 가진다** (FR-1212) — 오류 한 줄에서 감사 행으로 가는 길
  const requestId = given.headers()['x-request-id'];
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  const db = new Client(process.env.WF_DATABASE_URL);
  await db.connect();
  try {
    const { rows } = await db.query<{ request_id: string; detail: Record<string, unknown> }>(
      `SELECT request_id, detail FROM audit_events WHERE action = 'user.grants.change'
         AND target_id = (SELECT id::text FROM users WHERE username = $1) ORDER BY created_at DESC LIMIT 1`,
      [BOSS.username],
    );
    expect(rows[0].request_id).toBe(requestId);
    expect(rows[0].detail).toMatchObject({ username: BOSS.username, before: [], after: ['llm.manage'] });
  } finally {
    await db.end();
  }

  // 관리자는 **다음 요청부터** — 새로 고치면 메뉴가 생기고, LLM을 등록한다
  await boss.reload();
  await boss.getByRole('link', { name: 'LLM 연결' }).click();
  await expect(boss.getByRole('heading', { name: 'LLM 연결' })).toBeVisible();
  await boss.getByLabel('이름').fill(LLM);
  // 닿지 않는 주소 — 등록은 되고 연결 확인은 "연결 안 됨"이다. 여기서 보는 것은 권한이다
  await boss.getByLabel(/^주소/).fill('http://127.0.0.1:9/v1');
  await boss.getByLabel('모델').fill('mock');
  await boss.getByRole('button', { name: '등록' }).click();
  await expect(boss.getByRole('row', { name: new RegExp(LLM) })).toBeVisible();

  // root가 거둔다 — 관리자의 다음 요청이 막힌다
  const [taken] = await Promise.all([grantsResponse(page), box.click()]);
  expect(taken.status()).toBe(200);
  await expect(box).not.toBeChecked();
  await boss.reload();
  await expect(boss.getByRole('alert')).toContainText('권한이 없다');
  await boss.goto('/');
  await expect(boss.getByRole('link', { name: '사용자 관리' })).toBeVisible();
  await expect(boss.getByRole('link', { name: 'LLM 연결' })).toHaveCount(0);
  await bossContext.close();
});

test('**요청마다 번호가 붙는다** — 받은 번호가 모양에 맞으면 그대로, 틀리면 새로 만든다 (FR-1210)', async ({ request }) => {
  const kept = await request.get('/api/health', { headers: { 'x-request-id': '0f1e2d3c4b5a69788796a5b4c3d2e1f0' } });
  expect(kept.headers()['x-request-id']).toBe('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
  const replaced = await request.get('/api/health', { headers: { 'x-request-id': 'bad id "x"' } });
  expect(replaced.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  const fresh = await request.get('/api/health');
  expect(fresh.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
});
