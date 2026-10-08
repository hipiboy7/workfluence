// @vitest-environment happy-dom
import type { ApiTokenView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiTokenList, API_SCOPE_NAMES } from './ApiTokenList';

/**
 * 컴포넌트 시험 — API 토큰 목록 (docs/spinoff/public-api 설계서 FR-2222). 내 정보의 토큰 화면과 사용자 관리의 그 사람 토큰이 **같은 목록**을 쓴다.
 * 값(토큰 문자열)은 어디에도 없다 — 목록에는 이름·권한·상태·날짜뿐이다.
 */

const base: ApiTokenView = {
  id: 't1',
  name: '보고서 봇',
  scopes: ['read', 'write'],
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2026-12-30T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
};

afterEach(cleanup);

describe('ApiTokenList', () => {
  it('이름·권한(사람의 말)·상태·날짜를 보이고, 쓴 적이 없으면 그렇게 말한다', () => {
    render(<ApiTokenList tokens={[base]} onRevoke={() => undefined} />);
    const row = screen.getByRole('row', { name: /보고서 봇/ });
    expect(within(row).getByText(API_SCOPE_NAMES.read)).toBeTruthy();
    expect(within(row).getByText(API_SCOPE_NAMES.write)).toBeTruthy();
    expect(within(row).getByText('사용 중')).toBeTruthy();
    expect(within(row).getByText('쓴 적 없음')).toBeTruthy();
  });

  it('마지막으로 쓴 때가 있으면 그 시각을 보인다', () => {
    render(<ApiTokenList tokens={[{ ...base, lastUsedAt: '2026-10-05T03:00:00.000Z' }]} onRevoke={() => undefined} />);
    expect(screen.queryByText('쓴 적 없음')).toBeNull();
    expect(screen.getByText(new Date('2026-10-05T03:00:00.000Z').toLocaleString('ko-KR'))).toBeTruthy();
  });

  it('**폐기 단추는 쓰고 있는 토큰에만 있다** — 폐기된 것·만료된 것은 상태만 말한다', () => {
    render(
      <ApiTokenList
        tokens={[base, { ...base, id: 't2', name: '옛 토큰', status: 'revoked', revokedAt: '2026-10-02T00:00:00.000Z' }, { ...base, id: 't3', name: '끝난 토큰', status: 'expired' }]}
        onRevoke={() => undefined}
      />,
    );
    expect(screen.getAllByRole('button', { name: '폐기' })).toHaveLength(1);
    expect(within(screen.getByRole('row', { name: /옛 토큰/ })).getByText('폐기됨')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /끝난 토큰/ })).getByText('만료됨')).toBeTruthy();
  });

  it('폐기를 누르면 그 토큰을 넘긴다', () => {
    const onRevoke = vi.fn();
    render(<ApiTokenList tokens={[base]} onRevoke={onRevoke} />);
    fireEvent.click(screen.getByRole('button', { name: '폐기' }));
    expect(onRevoke).toHaveBeenCalledWith(base);
  });

  it('`busyId`인 토큰의 단추는 누를 수 없다 — 두 번 누르지 않게', () => {
    render(<ApiTokenList tokens={[base]} onRevoke={() => undefined} busyId="t1" />);
    expect((screen.getByRole('button', { name: /폐기/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('토큰이 없으면 빈 상태를 말한다', () => {
    render(<ApiTokenList tokens={[]} onRevoke={() => undefined} emptyText="발급한 토큰이 없다" />);
    expect(screen.getByText('발급한 토큰이 없다')).toBeTruthy();
  });
});
