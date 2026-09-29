// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_LEVEL_TEXT, AuditLevelCard } from './AuditLevelCard';

/**
 * 컴포넌트 시험 — 감사 기록 단계 (P17 F-010 10번). 시스템 관리자만 고르고, 나머지는 지금 단계만 본다. 감사로그 머리 아래의 접힌 구획이다(J.6).
 * 서버는 가짜 `fetch`다
 */

let sent: unknown[] = [];
let policyStatus = 200;
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  sent = [];
  policyStatus = 200;
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    if (String(input) !== '/api/settings/policy') return Promise.reject(new Error(`시험에 없는 요청: ${String(input)}`));
    if (init?.method === 'PATCH') {
      sent.push(JSON.parse(String(init.body)));
      return Promise.resolve(json(200, { ok: true }));
    }
    if (policyStatus !== 200) return Promise.resolve(json(policyStatus, { message: '권한이 없다: settings.manage' }));
    return Promise.resolve(json(200, { auditLevel: 3, trashRetentionDays: 30 }));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const panel = () => screen.getByRole('group', { name: '감사 기록 단계' }) as HTMLDetailsElement;

describe('AuditLevelCard', () => {
  it('**시스템 관리자는 단계를 골라 저장한다** — 지금은 3(전체), 1(최소)을 고르면 그 값만 보낸다. 단계마다 빠지는 행위를 한글 이름으로 보인다', async () => {
    render(<AuditLevelCard canChange />);
    // 접힌 줄에 지금 단계가 보인다 — 펴지 않아도 안다
    const current = await screen.findByText(AUDIT_LEVEL_TEXT[3].name, { selector: 'summary > strong' });
    expect(current.closest('summary')!.textContent).toBe(`기록 단계: ${AUDIT_LEVEL_TEXT[3].name} — 바꾸기`);
    expect(panel().tagName).toBe('DETAILS');
    expect(panel().open).toBe(false);
    const minimal = screen.getByRole('radio', { name: new RegExp(AUDIT_LEVEL_TEXT[1].name) });
    // 빠지는 것은 코드가 아니라 한글 이름 — 규칙(`AUDIT_MIN_LEVEL`)에서 뽑는다
    expect(screen.getByText('남기지 않는 것: 실시간 편집 자동 저장, 실시간 편집 바로 저장, 실시간 편집 제목 바꾸기')).toBeTruthy();
    expect(minimal.getAttribute('aria-describedby')).toBe('audit-level-1-dropped');
    expect(document.getElementById('audit-level-1-dropped')!.textContent).toBe(
      '남기지 않는 것: 첨부 받기, HTML 내보내기, 실시간 편집 자동 저장, 실시간 편집 바로 저장, 실시간 편집 제목 바꾸기, 메일 발송 성공, LLM 질문',
    );
    // 같은 단계로는 저장하지 않는다
    expect((screen.getByRole('button', { name: '단계 저장' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(minimal);
    fireEvent.click(screen.getByRole('button', { name: '단계 저장' }));
    await waitFor(() => expect(sent).toEqual([{ auditLevel: 1 }]));
    expect((await screen.findByRole('status')).textContent).toMatch(/^저장했다/);
    expect(screen.getByText(AUDIT_LEVEL_TEXT[1].name, { selector: 'summary > strong' })).toBeTruthy();
    // **표로 만들지 않는다** — 감사로그 화면의 표는 기록 목록 하나다
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('**다른 관리자는 지금 단계만 보고 고르지 못한다**', async () => {
    render(<AuditLevelCard canChange={false} />);
    await screen.findByText('단계는 시스템 관리자만 바꾼다.');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: '단계 저장' })).toBeNull();
    expect(screen.getByText(AUDIT_LEVEL_TEXT[3].name).closest('summary')!.textContent).toBe(`기록 단계: ${AUDIT_LEVEL_TEXT[3].name} — 보기`);
    expect(screen.getByText(`지금: ${AUDIT_LEVEL_TEXT[3].summary}`)).toBeTruthy();
  });

  it('**단계를 읽지 못하면 접힌 구획 밖에 알린다** — 접힌 채 오류가 숨지 않게', async () => {
    policyStatus = 403;
    render(<AuditLevelCard canChange />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('권한이 없다');
    expect(alert.closest('details')).toBeNull();
    expect(panel().querySelector('summary')!.textContent).toBe('기록 단계: 읽지 못했다');
    expect(screen.queryByRole('radio')).toBeNull();
  });
});
