import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ROLES, type Role, type UserView } from '@workfluence/shared';
import { api } from '../../api';

/** 사용자 관리 (FR-230~234, FR-243) */
export function AdminUsersPage() {
  const [rows, setRows] = useState<UserView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [temporary, setTemporary] = useState<{ username: string; password: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api<UserView[]>('/api/users')
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main className="shell">
      <h1>사용자 관리</h1>
      <p className="muted small"><Link to="/">← 홈</Link></p>
      {error && <p className="badge fail" role="alert">{error}</p>}
      {notice && <p className="badge" role="status">{notice}</p>}
      {temporary && (
        <section className="card">
          <h2>임시 비밀번호</h2>
          <p><strong>{temporary.username}</strong> · <code>{temporary.password}</code></p>
          <p className="badge fail">이 값은 다시 볼 수 없다. 지금 전달한다.</p>
          <button type="button" onClick={() => setTemporary(null)}>닫기</button>
        </section>
      )}
      <table className="card">
        <thead>
          <tr><th>아이디</th><th>이름</th><th>역할</th><th>상태</th><th>조치</th></tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>{u.displayName}</td>
              <td>
                <select
                  value={u.role}
                  aria-label={`${u.username} 역할`}
                  onChange={(e) => void act(() => api(`/api/users/${u.id}/role`, { method: 'PATCH', json: { role: e.target.value as Role } }))}
                >
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </td>
              <td><span className={`badge ${u.status === 'active' ? 'ok' : 'fail'}`}>{u.status}</span></td>
              <td>
                {u.status === 'pending' && (
                  <button type="button" onClick={() => void act(() => api(`/api/users/${u.id}/approve`, { method: 'POST' }))}>승인</button>
                )}
                {u.status === 'locked' && (
                  <button type="button" onClick={() => void act(() => api(`/api/users/${u.id}/unlock`, { method: 'POST' }))}>잠금 해제</button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    void act(async () => {
                      const r = await api<{ temporaryPassword: string }>(`/api/users/${u.id}/reset-password`, { method: 'POST' });
                      setTemporary({ username: u.username, password: r.temporaryPassword });
                    })
                  }
                >
                  비밀번호 초기화
                </button>
                {/* 관리자 강제 종료 (scope-definition 4.1절 #4). 서버측 세션을 파기한다 */}
                <button
                  type="button"
                  onClick={() =>
                    void act(async () => {
                      const r = await api<{ count: number }>(`/api/users/${u.id}/terminate-sessions`, { method: 'POST' });
                      setNotice(`${u.displayName}님의 세션 ${r.count}개를 끊었다.`);
                    })
                  }
                >
                  세션 강제 종료
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
