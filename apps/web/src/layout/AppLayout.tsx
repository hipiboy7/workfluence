import { can, type MeView } from '@workfluence/shared';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth';
import { MenuIcon } from '../components/icons';
import { ROLE_NAMES } from '../components/labels';
import { NotificationBell } from '../components/NotificationBell';

/**
 * 한 틀 (P17 설계서 J.3, FR-1850) — 로그인한 모든 화면이 위 막대 + 왼쪽 칸 + 본문이다. 화면은 틀을 스스로 그리지 않는다(중첩 경로가 씌운다).
 *
 * **왼쪽 칸의 내용은 화면이 정한다** — 화면이 `SideSlot` 안에 그린 것이 왼쪽 칸에 간다(React 포털). 스페이스 안의 화면은 페이지 트리를,
 * LLM 화면은 대화 목록을 넣는다. 아무 화면도 넣지 않으면 기본 문맥(바로가기·관리)이다(J.3.3). 상태는 그 화면에 그대로 있다 — 포털이라
 * 트리의 펼침·대화 목록의 고정 같은 조작이 화면의 상태로 돈다. 틀 없이 그린 화면(컴포넌트 시험)에서는 제자리에 그린다
 */

type SideSlotState = { el: HTMLElement | null; claim: () => () => void };
const SideContext = createContext<SideSlotState | null>(null);

/** 왼쪽 칸에 그린다. 틀 밖(컴포넌트 시험)이면 제자리에 그린다 */
export function SideSlot({ children }: { children: ReactNode }) {
  const ctx = useContext(SideContext);
  const claim = ctx?.claim;
  useLayoutEffect(() => (claim ? claim() : undefined), [claim]);
  if (!ctx) return <div className="side-inline">{children}</div>;
  return ctx.el ? createPortal(children, ctx.el) : null;
}

/** 관리 화면 — 권한 있는 것만 보인다. 판정은 서버의 가드와 같은 `can()`(위임까지 — P11 D.1·P15 D.5) */
export function adminLinks(me: MeView): { to: string; label: string }[] {
  const p = { id: me.id, role: me.role, grants: me.grants };
  const out: { to: string; label: string }[] = [];
  if (can(p, 'user.manage')) out.push({ to: '/admin/users', label: '사용자 관리' });
  if (can(p, 'audit.read')) out.push({ to: '/admin/audit', label: '감사로그' });
  if (can(p, 'space.oversee') || can(p, 'category.manage')) out.push({ to: '/admin/spaces', label: '스페이스 관리' });
  if (can(p, 'settings.manage')) out.push({ to: '/admin/policy', label: '운영 설정' });
  if (can(p, 'llm.manage')) out.push({ to: '/admin/llm', label: 'LLM 연결' });
  return out;
}

/** 주 메뉴의 지금 구역 */
function currentSection(pathname: string): string {
  if (pathname === '/' || pathname.startsWith('/spaces') || pathname.startsWith('/pages')) return 'spaces';
  if (pathname.startsWith('/search') || pathname.startsWith('/labels')) return 'search';
  if (pathname.startsWith('/llm')) return 'llm';
  if (pathname.startsWith('/trash')) return 'trash';
  if (pathname.startsWith('/admin')) return 'admin';
  return '';
}

const SIDE_KEY = 'wf:side-collapsed';
/** 이 폭보다 좁으면 왼쪽 칸이 처음에 접혀 있다 (J.3.6) */
const SIDE_AUTO_COLLAPSE_BELOW = 1280;

function initialCollapsed(): boolean {
  try {
    const saved = window.localStorage.getItem(SIDE_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch {
    // 저장소를 쓸 수 없으면 폭으로만 정한다
  }
  return window.innerWidth < SIDE_AUTO_COLLAPSE_BELOW;
}

/** 편집기·입력칸 안에서는 단축키를 먹지 않는다 */
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function AppLayout({ children }: { children?: ReactNode }) {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);

  const toggle = useCallback(() => {
    setCollapsed((v) => {
      try {
        window.localStorage.setItem(SIDE_KEY, v ? '0' : '1');
      } catch {
        // 기억하지 못해도 접기는 된다
      }
      return !v;
    });
  }, []);

  // Ctrl+[ — 왼쪽 칸 접기·펴기 (J.3.3)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '[' && !typing(e.target)) {
        e.preventDefault();
        toggle();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggle]);

  const claim = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => n - 1);
  }, []);
  const side = useMemo<SideSlotState>(() => ({ el: slotEl, claim }), [slotEl, claim]);

  if (!me) return null;
  const admin = adminLinks(me);
  const section = currentSection(pathname);
  const here = (key: string) => (section === key ? ('page' as const) : undefined);

  return (
    <SideContext.Provider value={side}>
      <a className="skip-link" href="#main">
        본문 바로가기
      </a>
      <header className="topbar">
        <button
          type="button"
          className="icon"
          aria-label={collapsed ? '왼쪽 칸 펴기' : '왼쪽 칸 접기'}
          aria-expanded={!collapsed}
          aria-controls="side"
          title="왼쪽 칸 접기·펴기 (Ctrl+[)"
          onClick={toggle}
        >
          <MenuIcon />
        </button>
        <Link className="brand" to="/">
          workfluence
        </Link>
        <nav className="mainnav" aria-label="주 메뉴">
          <ul>
            <li>
              <Link to="/" aria-current={here('spaces')}>
                스페이스
              </Link>
            </li>
            <li>
              <Link to="/search" aria-current={here('search')}>
                검색
              </Link>
            </li>
            <li>
              <Link to="/llm" aria-current={here('llm')}>
                LLM 질문
              </Link>
            </li>
            <li>
              <Link to="/trash" aria-current={here('trash')}>
                휴지통
              </Link>
            </li>
            {admin.length > 0 && (
              <li>
                <Link to={admin[0].to} aria-current={here('admin')}>
                  관리
                </Link>
              </li>
            )}
          </ul>
        </nav>
        <div className="topbar-right">
          <NotificationBell />
          <span className="me" title={`${me.displayName}님 (${ROLE_NAMES[me.role]})`}>
            {me.displayName}님 <span className="muted">({ROLE_NAMES[me.role]})</span>
          </span>
          {/* 사내 계정은 비밀번호가 없다 — IdP에서 바꾼다 (P13 FR-1471) */}
          {me.hasPassword && <Link to="/change-password">비밀번호 변경</Link>}
          <button type="button" onClick={() => void logout().then(() => nav('/login'))}>
            로그아웃
          </button>
        </div>
      </header>
      <div className={`app-body${collapsed ? ' side-collapsed' : ''}`}>
        <div className="side" id="side">
          {claims === 0 && <DefaultSideNav admin={admin} pathname={pathname} />}
          <div ref={setSlotEl} />
        </div>
        <main className="app-main" id="main" tabIndex={-1}>
          {children ?? <Outlet />}
        </main>
      </div>
    </SideContext.Provider>
  );
}

/** 기본 문맥의 왼쪽 칸 — 바로가기와 관리 (J.3.3). 제목(heading)을 두지 않는다 — 묶음 이름은 nav의 이름과 작은 회색 글이다 */
function DefaultSideNav({ admin, pathname }: { admin: { to: string; label: string }[]; pathname: string }) {
  const cur = (to: string) => (pathname === to ? ('page' as const) : undefined);
  return (
    <>
      <nav className="side-group" aria-label="바로가기">
        <p className="side-label" aria-hidden="true">
          바로가기
        </p>
        <ul>
          <li>
            <Link className="side-item" to="/notifications" aria-current={cur('/notifications')}>
              알림함
            </Link>
          </li>
          <li>
            <Link className="side-item" to="/llm/prompts" aria-current={cur('/llm/prompts')}>
              내 지시문
            </Link>
          </li>
        </ul>
      </nav>
      {admin.length > 0 && (
        <nav className="side-group" aria-label="관리">
          <p className="side-label" aria-hidden="true">
            관리
          </p>
          <ul>
            {admin.map((a) => (
              <li key={a.to}>
                <Link className="side-item" to={a.to} aria-current={cur(a.to)}>
                  {a.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </>
  );
}
