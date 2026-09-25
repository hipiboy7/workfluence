import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DELEGABLE_ACTIONS, ROLES, can, canManageUser, type DelegableAction, type Principal, type Role, type UserView } from '@workfluence/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';

/** 위임할 수 있는 행위의 이름 — 목록이 늘면 타입이 여기를 채우라고 한다 (P11 D.1) */
const GRANT_LABELS: Record<DelegableAction, string> = { 'llm.manage': 'LLM 연결 관리' };

/** 관리할 수 없는 행의 조치에 붙는 설명 */
const CANNOT_MANAGE = '이 사용자를 관리할 권한이 없다 — 시스템 관리자에게 맡긴다';

/**
 * 사용자 관리 (FR-230~234, FR-243). **위임** — 관리자 행마다 root가 주고 거두는 체크(P11_설계서_Ops D.1·G절). 다른 관리자에게는
 * 보이기만 한다. 판정은 서버의 가드와 같은 `can()`이다.
 *
 * **관리할 수 없는 행의 조치는 누르지 못한다** — root 행, 그리고 자기에게 없는 위임을 가진 관리자의 행(P11 보안 검토 1). 판정은 서버와
 * 같은 `canManageUser()`다 — 서버가 막는 것을 화면이 누르게 두면 403만 본다
 */
export function AdminUsersPage() {
  const { me } = useAuth();
  const principal: Principal | null = me ? { id: me.id, role: me.role, grants: me.grants } : null;
  const canGrant = can(principal, 'user.grants.change');
  const manageable = (u: UserView) => principal !== null && canManageUser(principal, { role: u.role, grants: u.grants });
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
          <tr><th>아이디</th><th>이름</th><th>역할</th><th>상태</th><th>위임</th><th>조치</th></tr>
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
                  disabled={!manageable(u)}
                  title={manageable(u) ? undefined : CANNOT_MANAGE}
                  onChange={(e) => void act(() => api(`/api/users/${u.id}/role`, { method: 'PATCH', json: { role: e.target.value as Role } }))}
                >
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </td>
              <td><span className={`badge ${u.status === 'active' ? 'ok' : 'fail'}`}>{u.status}</span></td>
              <td>
                {/* 위임은 관리자만 받는다 — 관리자가 아니게 되면 서버가 비운다 (P11 A.1-4) */}
                {u.role === 'admin'
                  ? DELEGABLE_ACTIONS.map((a) => (
                      <label key={a} className="small">
                        <input
                          type="checkbox"
                          aria-label={`${u.username} ${GRANT_LABELS[a]}`}
                          checked={u.grants.includes(a)}
                          disabled={!canGrant}
                          title={canGrant ? undefined : '시스템 관리자만 주고 거둔다'}
                          onChange={(e) => {
                            const grants = e.target.checked ? [...u.grants, a] : u.grants.filter((g) => g !== a);
                            void act(() => api(`/api/users/${encodeURIComponent(u.id)}/grants`, { method: 'PUT', json: { grants } }));
                          }}
                        />{' '}
                        {GRANT_LABELS[a]}
                      </label>
                    ))
                  : <span className="muted small">—</span>}
              </td>
              <td>
                {u.status === 'pending' && (
                  <button type="button" disabled={!manageable(u)} title={manageable(u) ? undefined : CANNOT_MANAGE} onClick={() => void act(() => api(`/api/users/${u.id}/approve`, { method: 'POST' }))}>승인</button>
                )}
                {u.status === 'locked' && (
                  <button type="button" disabled={!manageable(u)} title={manageable(u) ? undefined : CANNOT_MANAGE} onClick={() => void act(() => api(`/api/users/${u.id}/unlock`, { method: 'POST' }))}>잠금 해제</button>
                )}
                <button
                  type="button"
                  disabled={!manageable(u)}
                  title={manageable(u) ? undefined : CANNOT_MANAGE}
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
                  disabled={!manageable(u)}
                  title={manageable(u) ? undefined : CANNOT_MANAGE}
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
      <p className="muted small">
        위임은 시스템 관리자가 관리자 한 사람씩 주고 거둔다. 관리자가 아니게 되면 사라진다. 자기에게 없는 위임을 가진 관리자는 시스템 관리자만 관리한다.
      </p>
    </main>
  );
}
