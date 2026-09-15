import { can } from '@workfluence/shared';
import { useState, type FormEvent } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth';

const ROLE_LABEL: Record<string, string> = { root: 'root', admin: 'admin', member: '사용자' };

export function Layout() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
  };

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          workfluence
        </Link>
        <form onSubmit={onSearch} className="search-form">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="페이지 검색" aria-label="검색" />
        </form>
        <nav className="topnav">
          {me && can(me, 'user.manage') && <Link to="/admin">관리</Link>}
          {me && can(me, 'system.manage') && <Link to="/system">시스템</Link>}
          <Link to="/change-password">비밀번호 변경</Link>
          <span className="muted">
            {me?.displayName} <span className="badge">{me ? ROLE_LABEL[me.role] : ''}</span>
          </span>
          <button type="button" className="link" onClick={() => void logout().then(() => navigate('/login'))}>
            로그아웃
          </button>
        </nav>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
