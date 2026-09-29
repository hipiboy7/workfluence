// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { RequireUuidParam } from './RequireUuidParam';

/** 컴포넌트 시험 (P10 종료 루틴 — 경로 조작). 주소의 id가 식별자 모양이 아니면 그 화면을 그리지 않는다 */

afterEach(cleanup);

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/pages/:id"
          element={
            <RequireUuidParam>
              <p>페이지 화면</p>
            </RequireUuidParam>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

describe('RequireUuidParam', () => {
  it('식별자면 그 화면을 그린다', () => {
    renderAt('/pages/3f2a7b1c-9d4e-4f60-8a1b-2c3d4e5f6a7b');
    expect(screen.getByText('페이지 화면')).toBeTruthy();
  });

  it('**`%2F`로 하위 경로를 붙인 id는 그리지 않는다** — 화면이 그 id로 API를 부르지 않는다', () => {
    renderAt('/pages/3f2a7b1c-9d4e-4f60-8a1b-2c3d4e5f6a7b%2Flabels%2Fx');
    expect(screen.queryByText('페이지 화면')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/찾을 수 없다/);
  });

  it('**잘못된 주소 화면에도 h1이 하나 있다** — 제목으로 화면을 찾는 보조기기에 잡힌다. 탭 제목도 같다 (FR-1854, 병합 전 검토 10)', async () => {
    renderAt('/pages/not-an-id');
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['찾을 수 없다']);
    // 알림띠는 머리 아래다
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.compareDocumentPosition(screen.getByRole('alert')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('link', { name: '← 홈' }).getAttribute('href')).toBe('/');
    await waitFor(() => expect(document.title).toBe('찾을 수 없다 - 스페이스 - workfluence'));
  });

  it('**`:id`가 없는 경로는 그대로 그리고, 같은 화면의 두 경로 사이를 옮겨도 화면을 새로 만들지 않는다** — 알림·상태가 남는다', async () => {
    const ID = '3f2a7b1c-9d4e-4f60-8a1b-2c3d4e5f6a7b';
    function Stateful() {
      const [n, setN] = useState(0);
      const nav = useNavigate();
      return (
        <>
          <button type="button" onClick={() => setN(n + 1)}>
            더하기 {n}
          </button>
          <button type="button" onClick={() => void nav(`/llm/${ID}`)}>
            옮기기
          </button>
        </>
      );
    }
    render(
      <MemoryRouter initialEntries={['/llm']}>
        <Routes>
          <Route
            path="/llm"
            element={
              <RequireUuidParam>
                <Stateful />
              </RequireUuidParam>
            }
          />
          <Route
            path="/llm/:id"
            element={
              <RequireUuidParam>
                <Stateful />
              </RequireUuidParam>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '더하기 0' }));
    fireEvent.click(screen.getByRole('button', { name: '옮기기' }));
    expect(await screen.findByRole('button', { name: '더하기 1' })).toBeTruthy();
  });

  it('식별자가 아닌 것도 — 점 조각·아무 글자', () => {
    for (const path of ['/pages/..%2F..%2Fapi%2Fusers', '/pages/not-an-id']) {
      renderAt(path);
      expect(screen.queryByText('페이지 화면')).toBeNull();
      cleanup();
    }
  });
});
