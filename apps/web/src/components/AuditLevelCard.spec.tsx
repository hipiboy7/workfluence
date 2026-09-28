// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_LEVEL_TEXT, AuditLevelCard } from './AuditLevelCard';

/** 컴포넌트 시험 — 감사 기록 단계 (P17 F-010 10번). 시스템 관리자만 고르고, 나머지는 지금 단계만 본다. 서버는 가짜 `fetch`다 */

let sent: unknown[] = [];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  sent = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    if (String(input) !== '/api/settings/policy') return Promise.reject(new Error(`시험에 없는 요청: ${String(input)}`));
    if (init?.method === 'PATCH') {
      sent.push(JSON.parse(String(init.body)));
      return Promise.resolve(json(200, { ok: true }));
    }
    return Promise.resolve(json(200, { auditLevel: 3, trashRetentionDays: 30 }));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AuditLevelCard', () => {
  it('**시스템 관리자는 단계를 골라 저장한다** — 지금은 3(전체), 1(최소)을 고르면 그 값만 보낸다. 단계마다 빠지는 행위를 보인다', async () => {
    render(<AuditLevelCard canChange />);
    await screen.findByText(AUDIT_LEVEL_TEXT[3].name, { selector: 'p > strong' });
    const minimal = screen.getByRole('radio', { name: new RegExp(AUDIT_LEVEL_TEXT[1].name) });
    expect(screen.getByText(/남기지 않는 것: page\.collab\.save, page\.collab\.flush, page\.collab\.title\)$/)).toBeTruthy();
    fireEvent.click(minimal);
    fireEvent.click(screen.getByRole('button', { name: '단계 저장' }));
    await waitFor(() => expect(sent).toEqual([{ auditLevel: 1 }]));
    await screen.findByRole('status');
  });

  it('**다른 관리자는 지금 단계만 보고 고르지 못한다**', async () => {
    render(<AuditLevelCard canChange={false} />);
    await screen.findByText('단계는 시스템 관리자만 바꾼다.');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText(AUDIT_LEVEL_TEXT[3].name)).toBeTruthy();
  });
});
