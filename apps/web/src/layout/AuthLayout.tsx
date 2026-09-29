import type { ReactNode } from 'react';
import { Outlet } from 'react-router';

/**
 * 카드 틀 (P17 설계서 J.3.1) — 로그인 전 화면과 비밀번호를 바꿔야 하는 동안. 회색 바탕 가운데에 카드를 둔다. 제품 이름은 화면이 `AuthBrand`로
 * 그린다 — 로그인 화면만 제목(h1)이고 카드 안의 "로그인"이 h2다(시험이 둘을 본다), 나머지 화면은 카드 제목이 h1이다
 */
export function AuthLayout({ children }: { children?: ReactNode }) {
  return (
    <div className="auth">
      <main id="main" className="auth-main">
        {children ?? <Outlet />}
      </main>
    </div>
  );
}

/** 카드 위의 제품 이름 */
export function AuthBrand({ heading = false }: { heading?: boolean }) {
  return heading ? <h1 className="auth-brand">workfluence</h1> : <p className="auth-brand">workfluence</p>;
}
