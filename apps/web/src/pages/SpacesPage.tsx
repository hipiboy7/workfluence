import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { can, type SpaceView } from '@workfluence/shared';
import { api } from '../api';
import { useAuth } from '../auth';

/** 스페이스 목록 (FR-340). 버튼 노출은 응답의 access를 쓴다 (FR-345) */
export function SpacesPage() {
  const { me, logout } = useAuth();
  const [rows, setRows] = useState<SpaceView[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api<SpaceView[]>('/api/spaces?scope=personal'), api<SpaceView[]>('/api/spaces?scope=team')])
      .then(([p, t]) => setRows([...p, ...t]))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  if (!me) return null;
  const principal = { id: me.id, role: me.role };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/spaces', { method: 'POST', json: { name, kind: 'team' } });
      setName('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="shell">
      <h1>workfluence</h1>
      <p className="muted">
        {me.displayName}님 ({me.role})
        {can(principal, 'user.manage') && <> · <Link to="/admin/users">사용자 관리</Link></>}
        {can(principal, 'audit.read') && <> · <Link to="/admin/audit">감사로그</Link></>}
        {' · '}<Link to="/change-password">비밀번호 변경</Link>
        {' · '}<button type="button" className="linklike" onClick={() => void logout()}>로그아웃</button>
      </p>
      {error && <p className="badge fail" role="alert">{error}</p>}

      <section className="card">
        <h2>스페이스</h2>
        <ul>
          {rows.map((s) => (
            <li key={s.id}>
              <Link to={`/spaces/${s.id}`}>{s.name}</Link>{' '}
              <span className="muted small">
                {s.kind === 'personal' ? '개인' : '팀'} · {s.key} · Crew {s.memberCount}
                {s.status !== 'active' && <span className="badge fail"> 중지</span>}
              </span>
            </li>
          ))}
          {rows.length === 0 && <li className="muted">아직 스페이스가 없다.</li>}
        </ul>
      </section>

      {can(principal, 'space.create') && (
        <form className="card" onSubmit={create}>
          <h2>팀 스페이스 만들기</h2>
          <label htmlFor="sp-name">이름</label>
          <input id="sp-name" value={name} onChange={(e) => setName(e.target.value)} required />
          <button type="submit">만들기</button>
        </form>
      )}
    </main>
  );
}
