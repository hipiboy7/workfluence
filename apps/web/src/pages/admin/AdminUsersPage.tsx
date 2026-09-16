import { PASSWORD_POLICY, ROLES, can, canAssignRole, canManageUser, type Role, type UserView } from '@workfluence/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { CopyableSecret } from '../../components/CopyableSecret';
import { PasswordInput } from '../../components/PasswordInput';
import { USER_STATUS_LABEL, fmtDate } from './format';

/** 사용자 관리: ID·이름·역할·email·생성일자·상태 + 승인·잠금 해제·비밀번호 초기화·역할 변경 + 직접 생성 */
export function AdminUsersPage() {
  const { me } = useAuth();
  const [users, setUsers] = useState<UserView[]>([]);
  const [form, setForm] = useState({ username: '', displayName: '', email: '', password: '', role: 'member' as Role });
  const [reset, setReset] = useState<{ username: string; temporaryPassword: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<UserView[]>('/api/users?limit=500').then(setUsers).catch((e: Error) => setError(e.message)), []);
  useEffect(() => {
    if (me && can(me, 'user.manage')) void load();
  }, [me, load]);

  if (me && !can(me, 'user.manage')) return <Navigate to="/" replace />;
  if (!me) return null;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '실패');
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void act(() => api<UserView>('/api/users', { method: 'POST', json: form })).then(() => setForm({ username: '', displayName: '', email: '', password: '', role: 'member' }));
  };

  const resetPassword = (u: UserView) => {
    if (!window.confirm('비밀번호가 초기화 됩니다. 임시 비밀번호로 로그인 후 비밀번호를 변경하세요.')) return;
    void act(async () => {
      const r = await api<{ user: UserView; temporaryPassword: string }>(`/api/users/${u.id}/reset-password`, { method: 'POST' });
      setReset({ username: u.username, temporaryPassword: r.temporaryPassword });
    });
  };

  const assignable = ROLES.filter((r) => canAssignRole(me, r));

  return (
    <div className="two-col">
      <section>
        <p className="crumb">
          <Link to="/admin">관리</Link> › 사용자
        </p>
        <h1>사용자</h1>
        {error && <p className="error">{error}</p>}
        {reset && (
          <div className="notice info">
            <strong>{reset.username}</strong> 임시 비밀번호: <CopyableSecret value={reset.temporaryPassword} label={`reset-${reset.username}`} />
            <span className="muted small"> 이 값은 지금만 보인다. 본인에게 전달하고 첫 로그인에서 바꾸게 한다.</span>
            <button type="button" className="small" onClick={() => setReset(null)}>
              닫기
            </button>
          </div>
        )}
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>이름</th>
              <th>역할</th>
              <th>email</th>
              <th>생성일자</th>
              <th>상태</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const manageable = canManageUser(me, u.role) && u.id !== me.id;
              return (
                <tr key={u.id}>
                  <td>{u.username}</td>
                  <td>{u.displayName}</td>
                  <td>
                    {manageable && can(me, 'user.role.change') ? (
                      <select
                        aria-label={`${u.username} 역할`}
                        value={u.role}
                        onChange={(e) => void act(() => api(`/api/users/${u.id}/role`, { method: 'PATCH', json: { role: e.target.value } }))}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r} disabled={!canAssignRole(me, r)}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      u.role
                    )}
                  </td>
                  <td>{u.email ?? '-'}</td>
                  <td>{fmtDate(u.createdAt)}</td>
                  <td>
                    <span className={`badge status-${u.status}`}>{USER_STATUS_LABEL[u.status]}</span>
                    {u.mustChangePassword && <span className="badge">비밀번호 변경 대기</span>}
                  </td>
                  <td className="row-actions">
                    {manageable && u.status === 'pending' && (
                      <button type="button" className="primary small" onClick={() => void act(() => api(`/api/users/${u.id}/approve`, { method: 'POST' }))}>
                        승인
                      </button>
                    )}
                    {manageable && u.status === 'locked' && (
                      <button type="button" className="small" onClick={() => void act(() => api(`/api/users/${u.id}/unlock`, { method: 'POST' }))}>
                        잠금 해제
                      </button>
                    )}
                    {manageable && (
                      <button type="button" className="small" onClick={() => resetPassword(u)}>
                        비밀번호 초기화
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <aside>
        <form className="card" onSubmit={create}>
          <h2>사용자 직접 생성</h2>
          <p className="muted small">가입 요청 없이 관리자가 만드는 계정은 바로 활성이다.</p>
          <label htmlFor="nu-username">ID</label>
          <input id="nu-username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
          <label htmlFor="nu-name">이름</label>
          <input id="nu-name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />
          <label htmlFor="nu-email">email</label>
          <input id="nu-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <label htmlFor="nu-password">초기 비밀번호 ({PASSWORD_POLICY.minLength}자 이상, {PASSWORD_POLICY.minCharClasses}종)</label>
          <PasswordInput id="nu-password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} required />
          <label htmlFor="nu-role">역할</label>
          <select id="nu-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {assignable.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button type="submit" className="primary">
            만들기
          </button>
        </form>
      </aside>
    </div>
  );
}
