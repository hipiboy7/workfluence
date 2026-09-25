import { expect, test, type Page } from '@playwright/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { cleanup, createAdmin, createMember } from './fixtures';

/**
 * Phase 10 인수 기준 (scope-definition 5절, P10_설계서_Llm K.5).
 * "시스템 관리자가 사내 LLM을 등록하면 누구나 메뉴에서 묻고 답이 흘러나온다. 사람마다 지시문을 저장해 고른다. 대화는 기간·개수
 *  만큼 남고 고정한 것은 풀 때까지 남는다. 위키 페이지를 텍스트·마크다운으로 복사해 붙인다. API 키는 다시 보이지 않는다"
 *
 * **사내 LLM 대신 가짜 vLLM 서버를 이 시험 프로세스 안에 띄운다**(OpenAI 호환 SSE). 앱은 같은 기계에서 그 주소를 부른다.
 * 실연동은 보류 29다 — 여기 통과는 "우리가 가정한 모양으로 끝까지 간다"까지다.
 */

const STAMP = Date.now();
const ROOT = { username: `e2e-root-llm-${STAMP}`, password: 'E2e-Root-2026!' };
const MEMBER = { username: `e2e-llm-${STAMP}`, displayName: 'E2E 질문자', password: 'E2e-Llm-2026!' };
const PROVIDER = `E2E Qwen ${STAMP}`;
const KEY = `e2e-key-${STAMP}`;

type Seen = { method: string; url: string; auth: string | undefined; messages: { role: string; content: string }[]; closedEarly: boolean };
const seen: Seen[] = [];
let mock: Server;
let mockBase = '';

/** 가짜 vLLM — `/v1/models`와 `/v1/chat/completions`(SSE). 질문에 `[천천히]`가 있으면 끝없이 천천히 흘린다(중지 시험) */
function handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
  const body = raw ? (JSON.parse(raw) as { messages?: { role: string; content: string }[] }) : {};
  const s: Seen = { method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, messages: body.messages ?? [], closedEarly: false };
  seen.push(s);
  if (s.method === 'GET' && s.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-qwen3' }] }));
    return;
  }
  if (s.method !== 'POST' || s.url !== '/v1/chat/completions') {
    res.writeHead(404);
    res.end();
    return;
  }
  const last = s.messages.at(-1)?.content ?? '';
  const slow = last.includes('[천천히]');
  // 답 앞의 <think>…</think>는 서버가 떼어 생각 과정으로 흘린다 (FR-1119)
  const chunks = slow ? Array.from({ length: 200 }, (_, i) => `조각${i} `) : ['<think>질문을 읽는다</think>\n\n', '받은 질문: ', last.slice(0, 40), ' — 끝'];
  let finished = false;
  res.on('close', () => {
    if (!finished) s.closedEarly = true;
  });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  let i = 0;
  const tick = () => {
    if (res.destroyed) return;
    if (i < chunks.length) {
      send({ choices: [{ index: 0, delta: { content: chunks[i++] }, finish_reason: null }] });
      setTimeout(tick, slow ? 300 : 400);
      return;
    }
    send({ choices: [], usage: { prompt_tokens: 12, completion_tokens: chunks.length } });
    finished = true;
    res.end('data: [DONE]\n\n');
  };
  tick();
}

const chats = () => seen.filter((s) => s.url === '/v1/chat/completions');

test.describe.configure({ mode: 'serial' });
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.beforeAll(async () => {
  await createAdmin(ROOT, 'root');
  await createMember(MEMBER);
  mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => handle(req, res, raw));
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`;
});
test.afterAll(async () => {
  await cleanup([ROOT.username, MEMBER.username]);
  await new Promise<void>((r) => mock.close(() => r()));
});

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(username);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** LLM 질문 화면에서 이 실행이 등록한 LLM을 고른다 — 개발 DB에 다른 LLM이 있어도 흔들리지 않게 */
async function chooseProvider(page: Page) {
  await page.getByLabel('LLM', { exact: true }).selectOption({ label: `${PROVIDER} · mock-qwen3` });
}

test('시스템 관리자가 LLM을 등록하면 곧바로 연결을 확인한다 — 키는 다시 보이지 않는다', async ({ page }) => {
  await login(page, ROOT.username, ROOT.password);
  await page.getByRole('link', { name: 'LLM 연결' }).click();
  // **화면이 바뀐 뒤에 채운다** — 홈에도 '이름' 칸(팀 스페이스 만들기)이 있어, 기다리지 않으면 그쪽에 쓴다
  await expect(page.getByRole('heading', { name: 'LLM 연결' })).toBeVisible();
  await page.getByLabel('이름').fill(PROVIDER);
  await page.getByLabel(/^주소/).fill(mockBase);
  await page.getByLabel('모델').fill('mock-qwen3');
  await page.getByLabel(/^API 키/).fill(KEY);
  await page.getByRole('button', { name: '등록' }).click();

  await expect(page.getByText('연결됨')).toBeVisible();
  await expect(page.getByLabel(/^API 키/)).toHaveValue('');
  await expect(page.getByRole('row', { name: new RegExp(PROVIDER) })).toContainText('있음');
  await expect(page.locator('body')).not.toContainText(KEY);
  // 연결 확인은 키를 들고 `/v1/models`를 불렀다
  expect(seen.find((s) => s.url === '/v1/models')?.auth).toBe(`Bearer ${KEY}`);
});

test('지시문을 고르고 물으면 답이 흘러나오고, 고정하고 이어 묻는다', async ({ page }) => {
  await login(page, MEMBER.username, MEMBER.password);
  // 일반 사용자에게는 LLM 연결 메뉴가 없다
  await expect(page.getByRole('link', { name: 'LLM 연결' })).toHaveCount(0);

  await page.goto('/llm/prompts');
  await page.getByLabel('이름').fill('요약가');
  await page.getByLabel('지시').fill('세 줄로 요약한다');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByRole('region', { name: '요약가' })).toBeVisible();

  await page.getByRole('link', { name: '← LLM 질문' }).click();
  await page.getByLabel('지시문').selectOption({ label: '요약가' });
  await chooseProvider(page);
  await page.getByLabel('질문', { exact: true }).fill('첫 질문입니다');
  await page.getByRole('button', { name: '보내기' }).click();

  // **흘러나오는 동안** — 끝나기 전에 앞 조각이 보인다 (FR-1111)
  await expect(page.getByRole('button', { name: '중지' })).toBeVisible();
  const live = page.getByLabel('흘러나오는 답');
  await expect(live).toContainText('받은 질문:');
  await expect(live).not.toContainText('— 끝');
  await expect(live).toContainText('생각 과정');

  // 끝나면 저장된 대화로 옮긴다
  await expect(page).toHaveURL(/\/llm\/[0-9a-f-]{36}$/);
  const messages = page.getByRole('list', { name: '메시지' });
  await expect(messages).toContainText('받은 질문: 첫 질문입니다 — 끝');
  // **생각 과정은 저장하지 않는다** (FR-1119)
  await expect(messages).not.toContainText('질문을 읽는다');
  expect(chats().at(-1)?.messages).toEqual([
    { role: 'system', content: '세 줄로 요약한다' },
    { role: 'user', content: '첫 질문입니다' },
  ]);
  expect(chats().at(-1)?.auth).toBe(`Bearer ${KEY}`);

  // 고정한다 — 상한 표시가 바뀐다 (FR-1133). 상한 값은 정책이다 — 기본값(20)을 전제하지 않는다 (3절 "사람이 바꿀 수 있는 것을 전제하지 않는다")
  await page.getByRole('button', { name: '첫 질문입니다 고정', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '대화 목록' })).toContainText(/고정 1\/\d+/);

  // 이어 묻는다 — 앞 이력(생각 과정을 뺀 답)과 시작할 때의 지시문이 간다
  await page.getByLabel('질문', { exact: true }).fill('둘째 질문');
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(messages).toContainText('받은 질문: 둘째 질문 — 끝');
  // **흐름이 끝나 저장된 대화로 다시 그려질 때까지 기다린다** — 글자는 흘러나오는 중에 먼저 보인다. 저장·감사는 끝 줄 직전에 커밋된다
  await expect(page.getByLabel('흘러나오는 답')).toHaveCount(0);
  const second = chats().at(-1);
  expect(second?.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  expect(second?.messages[2].content).toBe('받은 질문: 첫 질문입니다 — 끝');

  // **감사로그에는 물었다는 사실만 — 내용은 없다** (FR-1118)
  const db = new Client(process.env.WF_DATABASE_URL);
  await db.connect();
  try {
    const { rows } = await db.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events WHERE action = 'llm.ask' AND actor_id = (SELECT id FROM users WHERE username = $1) ORDER BY created_at`,
      [MEMBER.username],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.detail.status)).toEqual(['done', 'done']);
    // 토큰 수가 남는다 — 가짜 vLLM이 알린 그대로 (FR-1118, 검토 반영: 이름에 token이 들어가면 비밀 거르기가 버렸다)
    expect(rows[0].detail.usage).toEqual({ prompt: 12, completion: 4 });
    expect(JSON.stringify(rows)).not.toContain('첫 질문입니다');
    expect(JSON.stringify(rows)).not.toContain(KEY);
  } finally {
    await db.end();
  }
});

test('중지하면 LLM 요청을 끊고 거기까지 남긴다', async ({ page }) => {
  await login(page, MEMBER.username, MEMBER.password);
  await page.goto('/llm');
  await chooseProvider(page);
  await page.getByLabel('질문', { exact: true }).fill('[천천히] 긴 답을 써 줘');
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(page.getByLabel('흘러나오는 답')).toContainText('조각1');
  await page.getByRole('button', { name: '중지' }).click();

  await expect(page.getByText('중지했다 — 거기까지 저장했다')).toBeVisible();
  await expect(page.getByRole('list', { name: '메시지' })).toContainText('중지됨');
  // 서버가 LLM 요청을 끊었다 — GPU를 놀리지 않는다 (FR-1113)
  await expect.poll(() => chats().at(-1)?.closedEarly).toBe(true);
});

test('**페이지를 떠나면 받던 답을 멈춘다** — 받은 데까지 남고, 돌아와 곧바로 다시 묻는다 (검토 반영)', async ({ page }) => {
  await login(page, MEMBER.username, MEMBER.password);
  await page.goto('/llm');
  await chooseProvider(page);
  await page.getByLabel('질문', { exact: true }).fill('[천천히] 떠나기 전의 답');
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(page.getByLabel('흘러나오는 답')).toContainText('조각1');
  const before = chats().length;
  await page.getByRole('link', { name: '내 지시문' }).click();
  await expect(page.getByRole('heading', { name: '내 지시문' })).toBeVisible();
  // 브라우저가 요청을 끊었고, 서버가 그것을 알아채 LLM 요청도 끊었다 — GPU를 놀리지 않는다
  await expect.poll(() => chats().at(-1)?.closedEarly).toBe(true);

  // 자리가 풀렸다 — "이미 답을 받고 있다"(409)가 아니다
  await page.getByRole('link', { name: '← LLM 질문' }).click();
  await chooseProvider(page);
  await page.getByLabel('질문', { exact: true }).fill('돌아와서 묻는다');
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(page.getByRole('list', { name: '메시지' })).toContainText('받은 질문: 돌아와서 묻는다 — 끝');
  expect(chats().length).toBe(before + 1);
  // 떠나기 전의 답은 받은 데까지 남았다 (FR-1122)
  await expect(page.getByRole('complementary', { name: '대화 목록' })).toContainText('[천천히] 떠나기 전의 답');
});

test('위키 페이지를 마크다운으로 복사해 질문에 붙인다', async ({ page }) => {
  await login(page, MEMBER.username, MEMBER.password);
  const title = `복사할 문서 ${STAMP}`;
  await page.goto('/');
  await page.getByRole('link', { name: `${MEMBER.displayName}의 공간` }).click();
  await page.getByLabel('새 페이지 제목').fill(title);
  await page.getByRole('button', { name: '만들기' }).click();
  await expect(page.getByRole('heading', { name: '페이지 편집' })).toBeVisible();
  await page.locator('.editor .ProseMirror').click();
  await page.keyboard.type('예산 초안을 검토한다');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByText('버전 2')).toBeVisible();

  await page.goto(page.url().replace(/\/edit$/, ''));
  await page.getByRole('button', { name: '마크다운 복사' }).click();
  await expect(page.getByText('마크다운을 복사했다')).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`# ${title}\n\n예산 초안을 검토한다`);

  await page.getByRole('button', { name: '텍스트 복사' }).click();
  await expect(page.getByText('텍스트를 복사했다')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${title}\n\n예산 초안을 검토한다`);

  // 붙여 넣어 묻는다 — 무엇이 LLM 서버로 가는지 사람이 보고 붙인다 (쟁점 4)
  await page.goto('/llm');
  await chooseProvider(page);
  await page.getByLabel('질문', { exact: true }).fill(copied);
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(page.getByRole('list', { name: '메시지' })).toContainText(`받은 질문: # ${title}`);
  expect(chats().at(-1)?.messages.at(-1)?.content).toBe(copied);
});
