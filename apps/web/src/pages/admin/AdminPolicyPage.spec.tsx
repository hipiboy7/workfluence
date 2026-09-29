// @vitest-environment happy-dom
import { ALLOWED_UPLOAD_EXTENSIONS, POLICY_DEFAULTS } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLICY_NAMES, type PolicyNumberKey } from '../../components/policyNames';
import { AdminPolicyPage } from './AdminPolicyPage';

/**
 * 컴포넌트 시험 — 운영 설정 (P4_설계서_Admin C절 · P17 설계서 J.6 관리 다섯). 구획 폼 묶음 넷, 라벨은 "한글 이름 (키)"(J.9-9 — E2E는 키로
 * 찾는다), 단위는 라벨 밖. 판정은 서버와 같은 함수(`validatePolicyPatch`·`policyConsistencyProblems`)라 틀리면 보내지 않는다. 처음 읽기가
 * 실패하면 "불러오는 중…"에 멈추지 않고 까닭을 보인다. 서버는 가짜 `fetch`다
 */

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let readFails = false;
const CEILING = 50;

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  calls = [];
  readFails = false;
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined });
    if (method === 'GET' && url === '/api/settings/policy') {
      return Promise.resolve(readFails ? json(403, { message: '권한이 없다' }) : json(200, { ...POLICY_DEFAULTS, uploadCeilingMb: CEILING }));
    }
    if (method === 'PATCH' && url === '/api/settings/policy') return Promise.resolve(json(200, { ok: true }));
    return Promise.reject(new Error(`시험에 없는 요청: ${method} ${url}`));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminPolicyPage />
    </MemoryRouter>,
  );
const patches = () => calls.filter((c) => c.method === 'PATCH');
/** 라벨 "한글 이름 (키)"로 칸을 찾는다 */
const box = (k: PolicyNumberKey) => screen.getByLabelText(`${POLICY_NAMES[k].name} (${k})`) as HTMLInputElement;

describe('AdminPolicyPage', () => {
  it('**처음 읽기가 실패하면 까닭을 보인다** — "불러오는 중…"에 멈추지 않는다', async () => {
    readFails = true;
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toBe('권한이 없다');
    expect(screen.queryByText('불러오는 중…')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('운영 설정');
  });

  it('**묶음 넷, 라벨은 "한글 이름 (키)"** — 단위·도움말은 라벨 밖이고, 감사 기록 단계는 보이지 않는다', async () => {
    renderPage();
    await screen.findByLabelText('휴지통 보존 기간 (trashRetentionDays)');
    const groups = ['세션·계정', '업로드·첨부', '보존 기간', 'LLM 대화'];
    for (const g of groups) expect(screen.getByRole('group', { name: g })).toBeTruthy();
    const inGroup = (g: string) => within(screen.getByRole('group', { name: g })).getAllByRole('spinbutton').map((i) => i.id);
    expect(inGroup('세션·계정')).toEqual(['sessionIdleMinutes', 'sessionAbsoluteHours', 'passwordMinLength', 'passwordMinCharClasses', 'lockoutThreshold', 'lockoutMinutes']);
    expect(inGroup('업로드·첨부')).toEqual(['uploadMaxMb']);
    expect(inGroup('보존 기간')).toEqual(['trashRetentionDays', 'auditRetentionDays']);
    expect(inGroup('LLM 대화')).toEqual(['llmRetentionDays', 'llmConversationMax', 'llmPinnedMax']);
    // 감사 기록 단계는 감사로그 화면에서 시스템 관리자가 고른다 (P17 FR-1842)
    expect(screen.queryByLabelText(/auditLevel/)).toBeNull();
    expect(screen.getByText('감사 기록 단계는 감사로그 화면에서 시스템 관리자가 고른다.')).toBeTruthy();
    // 값은 서버가 준 것, 단위는 칸 뒤의 글 — 라벨에 들지 않는다
    expect(box('trashRetentionDays').value).toBe(String(POLICY_DEFAULTS.trashRetentionDays));
    expect(box('trashRetentionDays').parentElement!.textContent).toBe('일');
    // 이 서버의 천장은 칸의 도움말이다 — 칸이 도움말을 가리킨다
    const upload = box('uploadMaxMb');
    expect(document.getElementById(upload.getAttribute('aria-describedby')!)!.textContent).toBe(`이 서버의 천장 ${CEILING}MB — 그 위로는 올리지 못한다.`);
    // 허용 확장자는 체크 상자 묶음이다
    const exts = within(screen.getByRole('group', { name: '허용 확장자' })).getAllByRole('checkbox');
    expect(exts).toHaveLength(ALLOWED_UPLOAD_EXTENSIONS.length);
    // 저장은 폼 끝의 주 단추 하나
    expect(screen.getByRole('button', { name: '저장' }).className).toBe('primary');
  });

  it('**바꾼 값만 보낸다** — 저장하면 다음 요청부터 먹는다고 알리고 다시 읽는다', async () => {
    renderPage();
    await screen.findByLabelText('휴지통 보존 기간 (trashRetentionDays)');
    fireEvent.change(box('trashRetentionDays'), { target: { value: '15' } });
    fireEvent.click(within(screen.getByRole('group', { name: '허용 확장자' })).getByRole('checkbox', { name: 'hwp' }));
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect((await screen.findByRole('status')).textContent).toContain('바로 먹는다');
    expect(patches()).toEqual([
      { method: 'PATCH', url: '/api/settings/policy', body: { trashRetentionDays: 15, allowedExtensions: ALLOWED_UPLOAD_EXTENSIONS.filter((e) => e !== 'hwp') } },
    ]);
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2));
  });

  it('**범위를 넘으면 보내지 않고 까닭을 말한다** — 서버와 같은 함수다', async () => {
    renderPage();
    await screen.findByLabelText('업로드 최대 크기 (uploadMaxMb)');
    fireEvent.change(box('uploadMaxMb'), { target: { value: '9999' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect((await screen.findByRole('alert')).textContent).toContain('1024');
    expect(patches()).toEqual([]);
  });

  it('**짝 규칙은 바꾼 뒤의 전체로 본다** — 고정 수가 대화 수보다 작지 않으면 보내지 않는다 (P10 FR-1134)', async () => {
    renderPage();
    await screen.findByLabelText('사람마다 고정 수 (llmPinnedMax)');
    fireEvent.change(box('llmPinnedMax'), { target: { value: String(POLICY_DEFAULTS.llmConversationMax) } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect((await screen.findByRole('alert')).textContent).toContain('대화 수(llmConversationMax');
    expect(patches()).toEqual([]);
  });
});
