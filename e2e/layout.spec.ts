import { CSRF_HEADER, CSRF_HEADER_VALUE, DOCUMENT_SCHEMA_VERSION } from '@workfluence/shared';
import { expect, test, type Page } from '@playwright/test';
import { cleanup, createAdmin, newAdmin } from './fixtures';

const ROOT = newAdmin('layout');

/**
 * Phase 17 화면 전면의 기계 판정 (P17 설계서 J.8, FR-1851·1856·1860) — 사용자의 2번("모바일처럼 굉장히 좁음")과 4번("입력하는 창이 구분되어야 함")을
 * 사람의 눈 대신 수치로 본다. 1280px(1920×1080에 배율 150%)과 1920px에서 주요 화면 12곳을 열어
 * - 가로 스크롤이 없다
 * - 1280px에서 본문(main)이 900px 이상이다(예전 `.shell`은 560px)
 * - 1920px에서 표 화면의 본문 폭은 1440px에서 멈춘다
 * - 편집 화면의 제목 칸·본문 칸 테두리가 바탕과 3:1 이상이다(WCAG 1.4.11 — 예전 테두리는 1.35:1)
 * 화면은 `.local/tmp/playwright/layout/`에 남긴다 — 사람이 모양을 볼 때 쓴다(저장소에 넣지 않는다)
 */

test.beforeAll(async () => {
  await createAdmin(ROOT, 'root');
});
test.afterAll(() => cleanup([ROOT.username]));

/** 색 문자열(rgb/rgba) → 상대 휘도 (WCAG 2.x) */
function luminance(color: string): number {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(ROOT.username);
  await page.getByLabel('비밀번호').fill(ROOT.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * **데이터가 온 뒤에 잰다** (병합 전 검토 1) — 화면은 머리(h1)를 먼저 그리고 목록·표는 응답 뒤에 그린다. h1만 보고 재면 불러오는 중인 화면을 재고
 * 찍어, 표·거르기 줄이 들어온 뒤 넘쳐도 초록불이었다(T-066과 같은 모양). 요청이 멎고, 본문과 왼쪽 칸의 "불러오는 중…"이 모두 사라지고, 그 화면의
 * 내용(`ready` — 표·목록·빈 상태·본문)이 보일 때까지 기다린다
 */
async function settle(page: Page, ready?: string) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.app-body .loading')).toHaveCount(0);
  if (ready) await expect(page.locator(`#main :is(${ready})`).first()).toBeVisible();
}

/** 가로 스크롤과 본문 폭 */
async function measure(page: Page) {
  return page.evaluate(() => {
    const main = document.getElementById('main')!;
    const cs = getComputedStyle(main);
    const inner = main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const pageEl = main.querySelector('.page');
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      mainInner: Math.round(inner),
      pageWidth: pageEl ? Math.round(pageEl.getBoundingClientRect().width) : null,
    };
  });
}

test('PC 폭에서 모든 주요 화면이 넓고 가로로 넘치지 않으며, 편집 칸의 테두리가 보인다 (FR-1851·1856·1860)', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);

  // 스페이스·페이지를 만든다 — 스페이스 안의 화면(트리·보기·편집·이력)을 열기 위해
  const spaceName = `E2E 레이아웃 ${Date.now()}`;
  await page.getByLabel('이름').fill(spaceName);
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await page.getByRole('link', { name: spaceName }).click();
  const spaceId = /\/spaces\/([0-9a-f-]+)/.exec(page.url())?.[1] ?? '';
  expect(spaceId).not.toBe('');
  const body = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const created = await page.request.post('/api/pages', {
    headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE },
    data: {
      spaceId,
      title: '레이아웃 확인 문서',
      content: { type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: [body('본문 한 줄은 읽기 폭에서 접힌다. '.repeat(12)), body('둘째 문단')] },
    },
  });
  expect(created.ok()).toBe(true);
  const { id: pageId } = (await created.json()) as { id: string };

  // `ready` — 데이터가 왔다는 표시(표·목록·빈 상태·본문). 검색은 찾을 말이 없으면 칸만 있다
  const screens: { name: string; path: string; table?: boolean; ready?: string }[] = [
    { name: 'home', path: '/', table: true, ready: 'table, .empty-state' },
    // 팀 스페이스라 Crew 표가 있다
    { name: 'space', path: `/spaces/${spaceId}`, table: true, ready: 'table' },
    { name: 'page-view', path: `/pages/${pageId}`, ready: '.doc .editor' },
    { name: 'page-edit', path: `/pages/${pageId}/edit`, ready: '.paper .editor' },
    { name: 'history', path: `/pages/${pageId}/history`, table: true, ready: '.row-list' },
    { name: 'search', path: '/search', table: true },
    { name: 'notifications', path: '/notifications', table: true, ready: '.row-list, .empty-state' },
    { name: 'trash', path: '/trash', table: true, ready: '.row-list, .empty-state' },
    { name: 'llm', path: '/llm', ready: '.empty-state' },
    { name: 'admin-users', path: '/admin/users', table: true, ready: 'tbody tr' },
    { name: 'admin-audit', path: '/admin/audit', ready: 'tbody tr' },
    { name: 'admin-llm', path: '/admin/llm', table: true, ready: 'table' },
  ];

  for (const width of [1280, 1920]) {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 1080 });
    for (const s of screens) {
      await page.goto(s.path);
      await expect(page.locator('#main h1').first()).toBeVisible();
      await settle(page, s.ready);
      // 왼쪽 칸이 보인다 — 1280은 처음 접히는 폭(1280 미만)의 바로 위다
      await expect(page.locator('#side')).toBeVisible();
      const m = await measure(page);
      expect.soft(m.scrollWidth, `${s.name}@${width}: 가로 스크롤`).toBeLessThanOrEqual(m.innerWidth);
      if (width === 1280) expect.soft(m.mainInner, `${s.name}@1280: 본문 폭`).toBeGreaterThanOrEqual(900);
      if (width === 1920 && s.table && m.pageWidth !== null) expect.soft(m.pageWidth, `${s.name}@1920: 표 화면 상한`).toBeLessThanOrEqual(1440);
      await page.screenshot({ path: `.local/tmp/playwright/layout/${s.name}-${width}.png`, fullPage: false });
    }
  }

  // 편집 화면의 두 칸 — 테두리가 종이(흰 바탕)와 3:1 이상 (4번)
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/pages/${pageId}/edit`);
  await expect(page.getByRole('heading', { name: '페이지 편집' })).toBeVisible();
  const title = page.getByLabel('제목', { exact: true });
  const editor = page.getByRole('textbox', { name: '본문' });
  await expect(editor).toBeVisible();
  for (const [name, el] of [
    ['제목 칸', title],
    ['본문 칸', editor],
  ] as const) {
    const { border, bg } = await el.evaluate((node) => {
      const paper = node.closest('.paper') ?? document.body;
      return { border: getComputedStyle(node).borderTopColor, bg: getComputedStyle(paper).backgroundColor };
    });
    expect(contrast(border, bg), `${name} 테두리 대비`).toBeGreaterThanOrEqual(3);
  }
});
