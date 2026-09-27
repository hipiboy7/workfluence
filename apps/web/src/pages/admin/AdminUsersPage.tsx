import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  DELEGABLE_ACTIONS,
  ROLES,
  USER_LIST_FILTERS,
  can,
  canManageUser,
  type DelegableAction,
  type Principal,
  type Role,
  type UserListFilter,
  type UserListView,
  type UserStatusView,
  type UserView,
} from '@workfluence/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';

/** 위임할 수 있는 행위의 이름 — 목록이 늘면 타입이 여기를 채우라고 한다 (P11 D.1) */
const GRANT_LABELS: Record<DelegableAction, string> = { 'llm.manage': 'LLM 연결 관리' };

/** 상태의 이름 (P13 C.6) — 예전에는 저장값(`active` 등)을 그대로 보였다 */
const STATUS_LABELS: Record<UserStatusView, string> = { pending: '승인 대기', active: '활성', locked: '잠김', suspended: '정지' };

/** 한 번에 받는 사람 수 — 서버 기본값과 같다(`listUsersDto`) */
const PAGE = 100;

/** 입력을 멈추고 이만큼 뒤에 찾는다 */
const SEARCH_DELAY_MS = 300;

/** 관리할 수 없는 행의 조치에 붙는 설명 */
const CANNOT_MANAGE = '이 사용자를 관리할 권한이 없다 — 시스템 관리자에게 맡긴다';

/**
 * 사용자 관리 (FR-230~234, FR-243). **위임** — 관리자 행마다 root가 주고 거두는 체크(P11_설계서_Ops D.1·G절). 다른 관리자에게는
 * 보이기만 한다. 판정은 서버의 가드와 같은 `can()`이다.
 *
 * **관리할 수 없는 행의 조치는 누르지 못한다** — root 행, 그리고 자기에게 없는 위임을 가진 관리자의 행(P11 보안 검토 1). 판정은 서버와
 * 같은 `canManageUser()`다 — 서버가 막는 것을 화면이 누르게 두면 403만 본다.
 *
 * **찾기·상태 거르기·더 보기** (P13 C.6, FR-1450~1452). 서버가 찾고 거르고 100명씩 나눈다 — 예전에는 처음 100명에서 조용히 끊겨 300명
 * 규모에서 200명을 이 화면에서 관리하지 못했다. **정지·정지 해제** (P13 C.5) — 정지하면 그 사람의 세션과 편집 연결이 그 자리에서 끊긴다
 */
export function AdminUsersPage() {
  const { me } = useAuth();
  const principal: Principal | null = me ? { id: me.id, role: me.role, grants: me.grants } : null;
  const canGrant = can(principal, 'user.grants.change');
  const manageable = (u: UserView) => principal !== null && canManageUser(principal, { role: u.role, grants: u.grants });
  const [rows, setRows] = useState<UserView[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<UserListFilter | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [temporary, setTemporary] = useState<{ username: string; password: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 늦게 온 옛 응답이 새 찾기의 결과를 덮지 않게 — 마지막 요청만 받는다
  const seq = useRef(0);

  const fetchPage = useCallback((offset: number, query: string, status: UserListFilter | '') => {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (query.trim()) params.set('q', query.trim());
    if (status) params.set('status', status);
    return api<UserListView>(`/api/users?${params.toString()}`);
  }, []);

  /** 처음부터 다시 읽는다 — 찾기·거르기가 바뀌었거나 조치 뒤에 */
  const load = useCallback(() => {
    const mine = ++seq.current;
    fetchPage(0, q, filter)
      .then((r) => {
        if (mine !== seq.current) return;
        setRows(r.items);
        setTotal(r.total);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [fetchPage, q, filter]);

  // 입력을 멈추면 찾는다 — 글자마다 서버를 부르지 않는다
  useEffect(() => {
    const t = setTimeout(load, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [load]);

  const more = () => {
    const mine = ++seq.current;
    fetchPage(rows.length, q, filter)
      .then((r) => {
        if (mine !== seq.current) return;
        setRows((prev) => [...prev, ...r.items]);
        setTotal(r.total);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const suspend = (u: UserView) => {
    // 되돌릴 수 있지만 그 사람의 편집이 그 자리에서 끊긴다 — 한 번 묻는다
    if (!window.confirm(`${u.displayName}(${u.username})님을 정지한다. 세션과 편집 연결이 그 자리에서 끊긴다.`)) return;
    void act(async () => {
      await api(`/api/users/${encodeURIComponent(u.id)}/suspend`, { method: 'POST' });
      setNotice(`${u.displayName}님을 정지했다.`);
    });
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
      <form className="card row" role="search" onSubmit={(e) => e.preventDefault()}>
        <label>
          찾기{' '}
          <input type="search" value={q} placeholder="아이디·이름·email" onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>
          상태{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value as UserListFilter | '')}>
            <option value="">전체</option>
            {USER_LIST_FILTERS.map((f) => <option key={f} value={f}>{STATUS_LABELS[f]}</option>)}
          </select>
        </label>
        <span className="muted small" aria-live="polite">전체 {total}명 · {rows.length}명 보는 중</span>
      </form>
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
              <td><span className={`badge ${u.status === 'active' ? 'ok' : 'fail'}`}>{STATUS_LABELS[u.status]}</span></td>
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
                {(u.status === 'active' || u.status === 'locked') && (
                  <button
                    type="button"
                    disabled={!manageable(u) || u.id === me?.id}
                    title={u.id === me?.id ? '자기 자신은 정지할 수 없다' : manageable(u) ? undefined : CANNOT_MANAGE}
                    onClick={() => suspend(u)}
                  >
                    정지
                  </button>
                )}
                {u.status === 'suspended' && (
                  <button
                    type="button"
                    disabled={!manageable(u)}
                    title={manageable(u) ? undefined : CANNOT_MANAGE}
                    onClick={() => void act(() => api(`/api/users/${encodeURIComponent(u.id)}/unsuspend`, { method: 'POST' }))}
                  >
                    정지 해제
                  </button>
                )}
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
      {rows.length < total && (
        <p>
          <button type="button" onClick={more}>더 보기</button>
        </p>
      )}
      <p className="muted small">
        정지된 사람은 로그인하지 못한다. 쓴 문서·댓글·공간 소속은 남고, 정지를 풀면 그대로 이어진다.
      </p>
      <p className="muted small">
        위임은 시스템 관리자가 관리자 한 사람씩 주고 거둔다. 관리자가 아니게 되면 사라진다. 자기에게 없는 위임을 가진 관리자는 시스템 관리자만 관리한다.
      </p>
    </main>
  );
}
