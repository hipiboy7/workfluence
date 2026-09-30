// @vitest-environment happy-dom
import type { NotificationView } from '@workfluence/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { NotificationText } from './NotificationText';

/**
 * 컴포넌트 시험 — 계정 찾기 알림의 글 (P17 FR-1801 · P19 FR-2001·2009). **본인의 요청이라고 말하지 않는다** — 로그인 없이 이름·email(초기화) 또는
 * 아이디·이름(email 확인)으로 누구나 만든다. 사용자 관리에서 그 아이디를 찾는 링크가 있다
 */
const base: NotificationView = {
  id: 'n1',
  kind: 'password.reset.request',
  pageId: null,
  commentId: null,
  actorName: '앨리스',
  actorUsername: 'alice',
  pageTitle: null,
  readAt: null,
  createdAt: '2026-09-30T00:00:00.000Z',
};
afterEach(cleanup);

const renderText = (n: NotificationView) =>
  render(
    <MemoryRouter>
      <p>
        <NotificationText n={n} />
      </p>
    </MemoryRouter>,
  );

describe('NotificationText — 계정 찾기 알림', () => {
  it('**초기화 요청은 "이름·email로"** (P19 FR-2000 — 예전에는 아이디·email)', () => {
    const { container } = renderText(base);
    expect(container.textContent).toBe('앨리스 (alice)님의 이름·email로 비밀번호 초기화가 요청됐다 — 본인에게 확인한 뒤 초기화한다 · 사용자 관리에서 초기화');
    expect(screen.getByRole('link', { name: '사용자 관리에서 초기화' }).getAttribute('href')).toBe('/admin/users?q=alice');
  });

  it('**email 확인 요청은 "아이디·이름으로"** — 본인에게 확인한 뒤 알려 준다(FR-2009)', () => {
    const { container } = renderText({ ...base, kind: 'email.confirm.request' });
    expect(container.textContent).toBe('앨리스 (alice)님의 아이디·이름으로 email 확인이 요청됐다 — 본인에게 확인한 뒤 알려 준다 · 사용자 관리에서 보기');
    expect(screen.getByRole('link', { name: '사용자 관리에서 보기' }).getAttribute('href')).toBe('/admin/users?q=alice');
  });
});
