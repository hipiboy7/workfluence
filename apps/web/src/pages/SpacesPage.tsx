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
  // 안 읽은 알림 수(FR-505)는 모든 화면의 알림 영역이 보인다 — 예전에는 이 머리말에만 있었다 (P17 F-010 8번, `NotificationBell`)

  if (!me) return null;
  // 위임까지 함께 넘긴다 — "LLM 연결"은 root, 그리고 root가 위임한 관리자 (P11 D.1)
  const principal = { id: me.id, role: me.role, grants: me.grants };

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
        {/* 모든 스페이스와 분류 (P14 FR-1513~1515) — 스페이스 관리 전체나 분류 관리를 받은 member에게도 보인다 (P15 D.5) */}
        {(can(principal, 'space.oversee') || can(principal, 'category.manage')) && <> · <Link to="/admin/spaces">스페이스 관리</Link></>}
        {' · '}<Link to="/search">검색</Link>
        {' · '}<Link to="/trash">휴지통</Link>
        {' · '}<Link to="/llm">LLM 질문</Link>
        {can(principal, 'settings.manage') && <> · <Link to="/admin/policy">운영 설정</Link></>}
        {/* LLM 연결 관리 — root, 그리고 root가 위임한 관리자 (P11_설계서_Ops D.1). 판정은 서버의 가드와 같은 `can()` */}
        {can(principal, 'llm.manage') && <> · <Link to="/admin/llm">LLM 연결</Link></>}
        {/* 사내 계정은 비밀번호가 없다 — IdP에서 바꾼다 (P13 FR-1471) */}
        {me.hasPassword && <>{' · '}<Link to="/change-password">비밀번호 변경</Link></>}
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
