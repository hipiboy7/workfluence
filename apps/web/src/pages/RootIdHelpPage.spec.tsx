// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RootIdHelpPage } from './RootIdHelpPage';

/**
 * 컴포넌트 시험 — 시스템 관리자 아이디 찾기(P17 F-010 7번). 안내만 하고 서버에 묻지 않는다(계정이 있는지 드러내지 않는다).
 * P17 J.6 — 카드 틀의 안내 카드: 카드 제목이 화면의 h1 하나, 명령은 코드 블록
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RootIdHelpPage', () => {
  it('**설치 때 정한 값과 확인하는 법을 안내하고, 로그인으로 돌아간다** — 서버에 아무것도 묻지 않는다', () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('이 화면은 서버에 묻지 않는다')));
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = render(
      <MemoryRouter>
        <RootIdHelpPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('시스템 관리자 아이디 찾기');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('WF_ROOT_USERNAME')).toBeTruthy();
    // 데이터베이스에서 보는 명령은 그대로 옮겨 치도록 코드 블록에 있다
    expect(container.querySelector('pre code')?.textContent).toMatch(/^docker exec workfluence-postgres psql .*role = 'root'"$/);
    expect(screen.getByRole('link', { name: '← 로그인으로' }).getAttribute('href')).toBe('/login');
    expect(screen.getByRole('link', { name: '아이디·비밀번호 찾기' }).getAttribute('href')).toBe('/find-account');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
