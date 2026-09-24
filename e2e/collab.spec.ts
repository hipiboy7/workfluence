import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { readPresence } from '../apps/api/src/pages/domain/presence';
import { CSRF_HEADER, CSRF_HEADER_VALUE, DOCUMENT_SCHEMA_VERSION } from '../packages/shared/src/constants';
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
  const caret = a.locator('.collaboration-carets__label', { hasText: mate.displayName });
  await expect(caret).toBeVisible({ timeout: 15_000 });
  // **색이 칠해져야 한다** — 캐럿은 `#rrggbb`가 아닌 색을 투명으로 그린다. 화면이 `hsl(…)`을 만들던 동안(Phase 6~9) 이름표는
  // 크기만 있고 투명했다 — 위의 "보인다"는 그것을 잡지 못했다 (P9 두 번째 자체 점검 5)
  await expect(caret).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

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
  // **요약줄을 확인하면 안 된다.** 요약줄은 아무것도 못 찾아도 늘 "변경 0 · 추가 0 · 삭제 0"을
  // 담으므로 그 단언은 절대 실패하지 않는다 — 실제로 비교가 마크 변경을 통째로 못 보고
  // 있었는데 이 E2E가 통과하고 있었다 (P6 코드 리뷰 12).
  // **찾아낸 낱말 자체**를 본다
  await expect(page.locator('.diff')).not.toContainText('두 버전의 내용이 같다');
  await expect(page.locator('.diff .w-added, .diff .diff-added')).not.toHaveCount(0);

  // 내보내기 — **파일로 내려와야 한다** (FR-730)
  await page.goto(`/pages/${pageId}`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'HTML로 내보내기' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.html$/);
});

/**
 * Phase 8 인수 기준 (P8_설계서_Mention G절, 보류 21).
 * "A가 `@B`를 치고 **그 뒤에 B가 다른 곳을 고쳐 마지막 작성자가 된다.** 버전이 남으면
 *  B의 알림함에 'A 님이 불렀다'가 뜬다." — 예전에는 B 자신의 이름이 떴다.
 */
test('A가 부르고 B가 마지막으로 고쳐도, 알림함은 A가 불렀다고 말한다', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await login(a, ADMIN.username, ADMIN.password);
  const spaceName = `멘션 공간 ${Date.now()}`;
  await a.goto('/');
  await a.getByLabel('이름').fill(spaceName);
  await a.getByRole('button', { name: '만들기' }).click();
  await a.getByRole('link', { name: spaceName }).click();
  await a.getByLabel('아이디로 Crew 추가 (editor)').fill(mate.username);
  await a.getByRole('button', { name: '추가' }).click();
  await a.getByLabel('새 페이지 제목').fill(`멘션 문서 ${Date.now()}`);
  await a.getByRole('button', { name: '만들기' }).click();
  await expect(a.getByRole('heading', { name: '페이지 편집' })).toBeVisible();
  const pageId = /\/pages\/([0-9a-f-]+)/.exec(a.url())?.[1] ?? '';

  await login(b, mate.username, mate.password);
  await b.goto(`/pages/${pageId}/edit`);
  await expect(a.getByText(/같이 보는 사람/)).toBeVisible({ timeout: 15_000 });
  await expect(b.getByText(/같이 보는 사람/)).toBeVisible({ timeout: 15_000 });

  // A가 B를 부른다
  const tag = `확인부탁${Date.now()}`;
  await a.locator('.editor .ProseMirror').click();
  await a.keyboard.type(`@${mate.username} ${tag}`);
  await expect(b.locator('.editor .ProseMirror')).toContainText(tag, { timeout: 15_000 });

  // **유휴 저장이 끼기 전에** B가 이어서 고친다 — 이제 마지막으로 키를 누른 사람은 B다
  await b.locator('.editor .ProseMirror').click();
  await b.keyboard.press('End');
  await b.keyboard.type(' B가덧붙임');
  await expect(a.locator('.editor .ProseMirror')).toContainText('B가덧붙임', { timeout: 15_000 });

  // 편집이 멈추면 버전이 남고 알림이 생긴다. 유휴 5초 + 여유
  await b.waitForTimeout(9_000);
  await b.goto('/notifications');
  const item = b.locator('li.card', { hasText: '님이 불렀다' }).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await expect(item.locator('strong')).toHaveText('E2E 관리자');

  await ctxA.close();
  await ctxB.close();
});

/**
 * Phase 9 (P9_설계서_Gate D.7, FR-1007·1008). **편집기가 만드는 것은 저장된다.**
 * 전에는 이메일 주소 하나(편집기가 `mailto:` 링크를 만들었다), 정렬된 표나 제목 붙은 링크를 붙여 넣은 것 하나로
 * 그 문서의 저장이 멈췄다 — 편집기와 서버 허용 목록이 달랐다. 이제 관문이 허용 목록 밖을 받지 않고 **끊으므로**,
 * 어긋나면 저장이 멈추는 대신 편집이 끊긴다. 둘 다 없어야 한다.
 */
test('이메일 주소를 치고 정렬된 표·제목 붙은 링크·rel=opener 링크를 붙여 넣어도 저장된다 — 이메일은 링크가 되지 않는다', async ({ page }) => {
  await login(page, ADMIN.username, ADMIN.password);
  const spaceName = `맞춤 공간 ${Date.now()}`;
  await page.goto('/');
  await page.getByLabel('이름').fill(spaceName);
  await page.getByRole('button', { name: '만들기' }).click();
  await page.getByRole('link', { name: spaceName }).click();
  await page.getByLabel('새 페이지 제목').fill(`맞춤 문서 ${Date.now()}`);
  await page.getByRole('button', { name: '만들기' }).click();
  await expect(page.getByText(/쓰는 대로 자동으로 저장된다/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/같이 보는 사람/)).toBeVisible({ timeout: 15_000 });

  const editor = page.locator('.editor .ProseMirror');
  await editor.click();
  await page.keyboard.type('연락처 user@example.internal 끝');
  await expect(editor).toContainText('user@example.internal');
  await expect(editor.locator('a[href^="mailto:"]')).toHaveCount(0);

  // 붙여 넣기 — 표 칸의 정렬(`align`)과 링크의 `title`·`rel`은 편집기가 붙여 넣은 HTML에서 만든다. `rel`의 `opener` 낱말은
  // 편집기가 뺀다 — 서버가 받지 않아 그대로 두면 이 사람이 끊긴다 (P9 세 번째 묶음)
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await editor.evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<p><a href="https://example.internal/doc" title="설명">제목 붙은 링크</a> <a href="https://example.internal/rel" rel="opener nofollow">열기 링크</a></p><table><tbody><tr><td align="center">가운데 칸</td></tr></tbody></table>');
    dt.setData('text/plain', '제목 붙은 링크 가운데 칸');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(editor.locator('a[href="https://example.internal/doc"]')).toHaveCount(1);
  await expect(editor.locator('a[href="https://example.internal/rel"]')).toHaveAttribute('rel', 'nofollow');
  await expect(editor.locator('td')).toContainText('가운데 칸');

  await page.getByRole('button', { name: '저장하고 보기로' }).click();
  // 저장되면 보기로 간다. 안 되면 편집 화면에 "저장되지 않았다: 까닭"이 남는다
  await expect(page).not.toHaveURL(/\/edit$/, { timeout: 15_000 });
  const body = page.locator('.editor.readonly').first();
  await expect(body).toContainText('user@example.internal');
  await expect(body).toContainText('제목 붙은 링크');
  await expect(body).toContainText('가운데 칸');
  await expect(body.locator('a[href="https://example.internal/rel"]')).toHaveAttribute('rel', 'nofollow');
});

/**
 * **Phase 9 인수 기준** (P9_설계서_Gate, 보류 22·23·24).
 * "조작한 연결이 편집기가 만들지 않는 노드·속성을 보내거나 남의 클라이언트 ID로 써도, 그것은 문서에 들어가지 않고
 *  그 연결만 끊긴다. 두 사람은 계속 서로의 편집을 보고 자동 저장이 이어진다. 거절은 감사로그에 남는다."
 *
 * 조작한 연결은 **로그인한 브라우저 안에서 연 WebSocket**이다 — Origin·세션 쿠키가 실제 화면과 같다. 보낼 변경은
 * 이 시험(Node)이 Yjs로 만든다.
 */
test('조작한 연결이 보낸 것은 문서에 들어가지 않고 그 연결만 끊긴다 — 두 사람의 편집은 계속 오간다', async ({ browser }) => {
  const require_ = createRequire(resolve(__dirname, '../apps/api/package.json'));
  const Y = require_('yjs') as typeof import('yjs');
  const frameOf = (build: (d: import('yjs').Doc) => void, clientID: number): number[] => {
    const d = new Y.Doc();
    d.clientID = clientID;
    build(d);
    return [0, ...Y.encodeStateAsUpdate(d)];
  };

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await login(a, ADMIN.username, ADMIN.password);
  const spaceName = `관문 공간 ${Date.now()}`;
  await a.goto('/');
  await a.getByLabel('이름').fill(spaceName);
  await a.getByRole('button', { name: '만들기' }).click();
  await a.getByRole('link', { name: spaceName }).click();
  await a.getByLabel('아이디로 Crew 추가 (editor)').fill(mate.username);
  await a.getByRole('button', { name: '추가' }).click();
  await a.getByLabel('새 페이지 제목').fill(`관문 문서 ${Date.now()}`);
  await a.getByRole('button', { name: '만들기' }).click();
  await expect(a.getByRole('heading', { name: '페이지 편집' })).toBeVisible();
  const pageId = /\/pages\/([0-9a-f-]+)/.exec(a.url())?.[1] ?? '';

  // 조작한 연결 — A의 세션으로 같은 페이지에 WebSocket을 하나 더 연다
  const evil = await ctxA.newPage();
  await evil.goto('/');
  await evil.evaluate((id) => {
    const w = window as unknown as { evilWs: WebSocket; evilIn: number[][]; evilClosed: Promise<number> };
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/pages/${id}`);
    ws.binaryType = 'arraybuffer';
    w.evilWs = ws;
    w.evilIn = [];
    ws.onmessage = (e) => w.evilIn.push([...new Uint8Array(e.data as ArrayBuffer)]);
    w.evilClosed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
    return new Promise((r) => (ws.onopen = r));
  }, pageId);

  // B가 들어와 커서를 둔다 — B의 화면은 **열자마자** 사람 표시로 자기 클라이언트 ID를 알린다
  await login(b, mate.username, mate.password);
  await b.goto(`/pages/${pageId}/edit`);
  await expect(b.getByText(/같이 보는 사람/)).toBeVisible({ timeout: 15_000 });
  await b.locator('.editor .ProseMirror').click();
  // 조작한 연결이 받은 사람 표시에서 B의 클라이언트 ID를 읽는다
  let bClient: number | undefined;
  await expect
    .poll(async () => {
      const frames = await evil.evaluate(() => (window as unknown as { evilIn: number[][] }).evilIn.filter((f) => f[0] === 1));
      for (const f of frames) for (const e of readPresence(Uint8Array.from(f.slice(1)))) if ((e.state as { user?: { name?: string } } | null)?.user?.name === mate.displayName) bClient = e.client;
      return bClient;
    }, { timeout: 15_000 })
    .not.toBeUndefined();

  // ① B의 클라이언트 ID로 먼저 쓴다(보류 24) — B가 아직 아무것도 치지 않았다
  const claim = frameOf((d) => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.insert(0, '가로챈 글');
    d.getXmlFragment('default').insert(0, [p]);
  }, bClient!);
  const code1 = await evil.evaluate(async (bytes) => {
    const w = window as unknown as { evilWs: WebSocket; evilClosed: Promise<number> };
    w.evilWs.send(Uint8Array.from(bytes));
    return w.evilClosed;
  }, claim);
  expect(code1).toBe(4400);

  // ②③ 편집기가 만들지 않는 노드(보류 23), 보이지 않는 속성(보류 22) — 연결마다 하나씩, 매번 끊긴다
  const hook = frameOf((d) => d.getXmlFragment('default').insert(0, [new Y.XmlHook('evil') as never]), 424242);
  const hidden = frameOf((d) => {
    const p = new Y.XmlElement('paragraph');
    p.setAttribute('onclick', 'x()');
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.insert(0, '숨은 속성 글');
    d.getXmlFragment('default').insert(0, [p]);
  }, 515151);
  for (const bytes of [hook, hidden]) {
    const code = await evil.evaluate(
      ([id, frame]) =>
        new Promise<number>((resolveCode) => {
          const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/pages/${id as string}`);
          ws.binaryType = 'arraybuffer';
          ws.onopen = () => ws.send(Uint8Array.from(frame as number[]));
          ws.onclose = (e) => resolveCode(e.code);
        }),
      [pageId, bytes] as const,
    );
    expect(code).toBe(4400);
  }

  // 두 사람의 편집은 계속 오간다 — B는 자기 클라이언트 ID 그대로 쓰고, 그 글이 서버를 거쳐 A에게 간다
  await a.goto(`/pages/${pageId}/edit`);
  await expect(a.getByText(/같이 보는 사람/)).toBeVisible({ timeout: 15_000 });
  const fromB = `B의글${Date.now()}`;
  await b.locator('.editor .ProseMirror').click();
  await b.keyboard.type(fromB);
  await expect(a.locator('.editor .ProseMirror')).toContainText(fromB, { timeout: 15_000 });
  const fromA = `A의글${Date.now()}`;
  await a.locator('.editor .ProseMirror').click();
  await a.keyboard.press('End');
  await a.keyboard.type(fromA);
  await expect(b.locator('.editor .ProseMirror')).toContainText(fromA, { timeout: 15_000 });
  for (const p of [a, b]) await expect(p.getByText(/서버가 이 편집을 받지 않았다/)).toHaveCount(0);

  // 자동 저장이 이어지고, 저장본에는 조작한 것이 없다
  await a.waitForTimeout(9_000);
  const c = new Client(process.env.WF_DATABASE_URL);
  await c.connect();
  try {
    const saved = await c.query<{ content: string }>(
      `SELECT v.content_json::text AS content FROM page_versions v JOIN pages p ON p.id = v.page_id AND v.version_no = p.current_version_no WHERE p.id = $1`,
      [pageId],
    );
    expect(saved.rows[0].content).toContain(fromB);
    expect(saved.rows[0].content).toContain(fromA);
    for (const bad of ['가로챈 글', '숨은 속성 글', 'onclick', 'evil']) expect(saved.rows[0].content).not.toContain(bad);
    const rejected = await c.query<{ rule: string }>(
      `SELECT detail->>'rule' AS rule FROM audit_events WHERE action = 'page.collab.reject' AND target_id = $1 ORDER BY created_at`,
      [pageId],
    );
    expect(rejected.rows.map((r) => r.rule)).toEqual(['owner', 'structure', 'structure']);
  } finally {
    await c.end();
  }
  await ctxA.close();
  await ctxB.close();
});

/**
 * **자동 저장이 멈추면 화면이 말한다** (P9_설계서_Gate FR-1011).
 *
 * Phase 9 전에 남은 실시간 상태에는 지금 허용 목록 밖의 속성(`textAlign` — 스키마 버전 2에서 뺐다)이 들어 있을 수 있다.
 * 관문이 생기기 전에 들어간 것이라 문 앞에서 막을 수 없고, 그 상태로는 자동 저장이 검증에 걸린다. 전에는 서버 로그에만
 * 남아 편집하는 사람은 저장되는 줄 알았다. 그 문단을 고치면 편집기가 모르는 속성을 지우므로 다시 저장된다.
 */
test('남은 옛 상태로 자동 저장이 멈추면 화면이 까닭을 말하고, 그 문단을 고치면 다시 저장되며 알림이 사라진다', async ({ page }) => {
  const require_ = createRequire(resolve(__dirname, '../apps/api/package.json'));
  const Y = require_('yjs') as typeof import('yjs');

  await login(page, ADMIN.username, ADMIN.password);
  const spaceName = `옛 상태 공간 ${Date.now()}`;
  await page.goto('/');
  await page.getByLabel('이름').fill(spaceName);
  await page.getByRole('button', { name: '만들기' }).click();
  await page.getByRole('link', { name: spaceName }).click();
  const spaceId = /\/spaces\/([0-9a-f-]+)/.exec(page.url())?.[1] ?? '';
  expect(spaceId).not.toBe('');
  // 편집 화면을 거치지 않고 만든다 — 열면 방이 생겨 아래에서 넣는 옛 상태를 읽지 않는다
  const created = await page.request.post('/api/pages', {
    headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE },
    data: {
      spaceId,
      title: `옛 상태 문서 ${Date.now()}`,
      content: { type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '정본 문단' }] }] },
    },
  });
  expect(created.ok()).toBe(true);
  const { id: pageId, currentVersionNo } = (await created.json()) as { id: string; currentVersionNo: number };

  // Phase 9 전의 실시간 상태 — 가운데 정렬(`textAlign`)이 붙은 문단과 평범한 문단
  const old = new Y.Doc();
  const aligned = new Y.XmlElement('paragraph');
  aligned.setAttribute('textAlign', 'center');
  aligned.insert(0, [new Y.XmlText('옛 가운데 정렬 문단')]);
  const plain = new Y.XmlElement('paragraph');
  plain.insert(0, [new Y.XmlText('다른 문단')]);
  old.getXmlFragment('default').insert(0, [aligned, plain]);
  const c = new Client(process.env.WF_DATABASE_URL);
  await c.connect();
  try {
    await c.query(`INSERT INTO page_realtime (page_id, state, version_no, authors) VALUES ($1, $2, $3, '{}'::jsonb)`, [
      pageId,
      Buffer.from(Y.encodeStateAsUpdate(old)),
      currentVersionNo,
    ]);

    await page.goto(`/pages/${pageId}/edit`);
    await expect(page.getByText(/같이 보는 사람/)).toBeVisible({ timeout: 15_000 });
    const editor = page.locator('.editor .ProseMirror');
    await expect(editor).toContainText('옛 가운데 정렬 문단');
    // **들어가자마자 안다** — 서버가 방을 열 때 한 번 검증한다 (P9 D.9, 두 번째 코드 리뷰 4)
    const banner = page.getByText(/자동 저장이 멈췄다: .*'textAlign'/);
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // 다른 문단을 고친다 — 정렬이 붙은 문단은 그대로라 유휴 뒤의 판정도 검증에 걸린다. 알림은 그대로 남는다
    await editor.getByText('다른 문단').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 덧붙임');
    await page.waitForTimeout(7_000); // 유휴 5초 + 판정 주기
    await expect(banner).toBeVisible();

    // 그 문단을 고친다 — 편집기가 모르는 속성을 지워 보낸다. 다음 판정에서 저장되고 알림이 사라진다
    await editor.getByText('옛 가운데 정렬 문단').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 고침');
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    // 알림은 검증을 지난 순간 풀린다 — 버전은 그 뒤 트랜잭션에서 남으므로 기다려 본다
    const current = async (): Promise<{ n: number; content: string }> =>
      (
        await c.query<{ n: number; content: string }>(
          `SELECT p.current_version_no AS n, v.content_json::text AS content FROM pages p JOIN page_versions v ON v.page_id = p.id AND v.version_no = p.current_version_no WHERE p.id = $1`,
          [pageId],
        )
      ).rows[0];
    await expect.poll(async () => Number((await current()).n), { timeout: 15_000 }).toBe(currentVersionNo + 1);
    const saved = await current();
    expect(saved.content).toContain('고침');
    expect(saved.content).toContain('덧붙임');
    expect(saved.content).not.toContain('textAlign');
  } finally {
    await c.end();
  }
});
