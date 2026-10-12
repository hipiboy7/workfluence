import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../packages/shared/src/constants';
import { cleanup, createAdmin, createMember, newAdmin } from './fixtures';

const ADMIN = newAdmin('chat');
const mate = { username: `e2e-chat-mate-${Date.now()}`, displayName: 'E2E 채팅동료', password: 'E2e-Mate-2026!' };
const agent = { username: `e2e-chat-agent-${Date.now()}`, displayName: 'E2E 채팅에이전트', password: 'E2e-Agent-2026!' };

/**
 * Phase 21 인수 기준 (P21_설계서_Chat B절).
 * "사람이 새 메뉴 채팅에서 방을 만들고 메시지를 주고받는다. 사람 없이 도는 클라이언트가 API 토큰으로 같은 방에 WebSocket으로 접속해
 *  새 메시지를 받고 답한다."
 */

test.beforeAll(async () => {
  await createAdmin(ADMIN);
  await createMember(mate);
  await createMember(agent);
});
test.afterAll(() => cleanup([ADMIN.username, mate.username, agent.username]));

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(username);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** 1:1 방을 열고 그 방의 주소(id)를 돌려준다 */
async function openDirect(page: Page, otherName: string): Promise<string> {
  await page.goto('/chat');
  await page.getByRole('button', { name: /새 대화/ }).click();
  await page.getByLabel('사람 찾기').fill(otherName);
  await page.getByRole('button', { name: otherName, exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  return /\/chat\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
}

const pane = (page: Page) => page.getByRole('region', { name: '대화' });

test('두 사람이 채팅 화면에서 주고받는다 — 새로 고치지 않아도 보이고 안 읽은 수가 붙는다', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await login(a, ADMIN.username, ADMIN.password);
  await login(b, mate.username, mate.password);

  const roomId = await openDirect(a, mate.displayName);
  await expect(a.getByRole('heading', { name: mate.displayName })).toBeVisible();

  // B는 다른 화면에 있다 — 채팅 화면을 열기 전에 A가 보낸다
  const first = `안녕하세요 ${Date.now()}`;
  await a.getByLabel('메시지').fill(first);
  await expect(a.getByRole('button', { name: '보내기' })).toBeEnabled({ timeout: 15_000 }); // 연결이 붙어야 보낸다
  await a.getByRole('button', { name: '보내기' }).click();
  await expect(pane(a).getByText(first)).toBeVisible();

  // B가 채팅을 열면 방 목록에 안 읽은 수가 있다
  await b.goto('/chat');
  const list = b.getByRole('navigation', { name: '채팅 방 목록' });
  await expect(list.getByText('E2E 관리자')).toBeVisible();
  await expect(list.getByLabel('안 읽은 메시지 1개')).toBeVisible();
  await list.getByRole('link', { name: /E2E 관리자/ }).click();
  await expect(pane(b).getByText(first)).toBeVisible();
  await expect(list.getByLabel(/안 읽은 메시지/)).toHaveCount(0); // 열면 읽은 것이다

  // B의 답이 A 화면에 그 자리에서 뜬다
  const reply = `네 반갑습니다 ${Date.now()}`;
  await b.getByLabel('메시지').fill(reply);
  await expect(b.getByRole('button', { name: '보내기' })).toBeEnabled({ timeout: 15_000 });
  await b.getByLabel('메시지').press('Enter');
  await expect(pane(a).getByText(reply)).toBeVisible({ timeout: 15_000 });
  expect(a.url()).toContain(roomId);
});

test('사람 없이 도는 클라이언트가 토큰으로 WebSocket에 붙어 받고 답한다', async ({ browser, baseURL }) => {
  const human = await (await browser.newContext()).newPage();
  const bot = await (await browser.newContext()).newPage();
  await login(human, ADMIN.username, ADMIN.password);
  await login(bot, agent.username, agent.password);

  // 에이전트의 토큰 — 화면과 같은 API로 발급한다(토큰은 사람이 발급한다)
  const issued = await bot.request.post('/api/tokens', {
    headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE },
    data: { name: 'E2E 채팅 에이전트', scopes: ['read', 'write'], expiresInDays: 1 },
  });
  expect(issued.status()).toBe(201);
  const token = ((await issued.json()) as { token: string }).token;

  const roomId = await openDirect(human, agent.displayName);

  // 사람이 `ws` 패키지로 붙는다 — 브라우저가 아니라 Origin도 쿠키도 없다
  const WebSocket = createRequire(resolve(__dirname, '../apps/api/package.json'))('ws') as typeof import('ws').WebSocket;
  const url = `${(baseURL ?? 'http://127.0.0.1:3000').replace(/^http/, 'ws')}/api/v1/chat/ws`;
  const frames: { type: string; body?: string; roomId?: string }[] = [];
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  try {
    await expect.poll(() => frames.map((f) => f.type)).toContain('hello');

    const ask = `에이전트님 도와주세요 ${Date.now()}`;
    await human.getByLabel('메시지').fill(ask);
    await expect(human.getByRole('button', { name: '보내기' })).toBeEnabled({ timeout: 15_000 });
    await human.getByRole('button', { name: '보내기' }).click();
    await expect.poll(() => frames.find((f) => f.type === 'message' && f.body === ask)?.roomId, { timeout: 15_000 }).toBe(roomId);

    // 에이전트가 답한다 — 사람 화면에 그 자리에서 뜬다
    const answer = `확인했습니다 ${Date.now()}`;
    ws.send(JSON.stringify({ type: 'send', roomId, body: answer, clientMsgId: 'e2e-1' }));
    await expect(pane(human).getByText(answer)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => frames.some((f) => f.type === 'ack')).toBe(true);

    // 토큰을 폐기하면 그 연결이 그 자리에서 끊긴다 (FR-2411)
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    const tokens = (await (await bot.request.get('/api/tokens')).json()) as { id: string }[];
    expect((await bot.request.delete(`/api/tokens/${tokens[0]!.id}`, { headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE } })).ok()).toBe(true);
    expect(await closed).toBe(4401);
  } finally {
    ws.terminate();
  }
});
