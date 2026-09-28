// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { RootIdHelpPage } from './RootIdHelpPage';

/** 컴포넌트 시험 — 시스템 관리자 아이디 찾기(P17 F-010 7번). 안내만 하고 서버에 묻지 않는다(계정이 있는지 드러내지 않는다) */
afterEach(cleanup);

describe('RootIdHelpPage', () => {
  it('**설치 때 정한 값과 확인하는 법을 안내하고, 로그인으로 돌아간다** — 서버에 아무것도 묻지 않는다', () => {
    render(
      <MemoryRouter>
        <RootIdHelpPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: '시스템 관리자 아이디 찾기' })).toBeTruthy();
    expect(screen.getByText('WF_ROOT_USERNAME')).toBeTruthy();
    expect(screen.getByRole('link', { name: '← 로그인으로' }).getAttribute('href')).toBe('/login');
    expect(screen.getByRole('link', { name: '아이디·비밀번호 찾기' }).getAttribute('href')).toBe('/find-account');
  });
});
