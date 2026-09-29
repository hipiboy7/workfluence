import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  DELEGABLE_ACTIONS,
  DELEGATION,
  LIST_SEARCH_MAX,
  ROLES,
  USER_LIST_FILTERS,
  USER_LIST_MAX,
  USER_LIST_PAGE,
  canGrant,
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
import { useConfirm } from '../../components/ConfirmDialog';
import { ROLE_NAMES, withCode } from '../../components/displayNames';
import { CodeBlock, Field, FilterBar, Loading, Notice, Page, PageHeader, StatusBadge } from '../../components/ui';
import { SEARCH_DELAY_MS } from '../../timing';

/** 위임할 수 있는 행위의 이름 — 목록이 늘면 타입이 여기를 채우라고 한다 (P11 D.1) */
const GRANT_LABELS: Record<DelegableAction, string> = {
  'llm.manage': 'LLM 연결 관리',
  'category.manage': '분류 관리',
  'space.unsuspend': '관리자가 건 중지 풀기',
  'space.oversee': '스페이스 관리 전체',
};

/** 상태의 이름 (P13 C.6) — 예전에는 저장값(`active` 등)을 그대로 보였다 */
const STATUS_LABELS: Record<UserStatusView, string> = { pending: '승인 대기', active: '활성', locked: '잠김', suspended: '정지' };
/** 상태 배지의 뜻 색 (J.5.8) — 활성 ✓ · 승인 대기 ○ · 잠김·정지 ⊘ */
const STATUS_KIND: Record<UserStatusView, 'ok' | 'wait' | 'bad'> = { pending: 'wait', active: 'ok', locked: 'bad', suspended: 'bad' };

/** 관리할 수 없는 행의 조치에 붙는 설명 — 단추의 `title`과 조치 칸의 글 둘로 보인다(J.5.2 "누를 수 없는 까닭은 옆에 글로도") */
const CANNOT_MANAGE = '이 사용자를 관리할 권한이 없다 — 시스템 관리자에게 맡긴다';
const CANNOT_SUSPEND_SELF = '자기 자신은 정지할 수 없다';

/**
 * 사용자 관리 (FR-230~234, FR-243). **위임** — 관리자 행마다 root가 주고 거두는 체크(P11_설계서_Ops D.1·G절). 다른 관리자에게는
 * 보이기만 한다. 판정은 서버의 가드와 같은 `can()`이다.
 *
 * **관리할 수 없는 행의 조치는 누르지 못한다** — root 행, 그리고 자기에게 없는 위임을 가진 관리자의 행(P11 보안 검토 1). 판정은 서버와
 * 같은 `canManageUser()`다 — 서버가 막는 것을 화면이 누르게 두면 403만 본다.
 *
 * **찾기·상태 거르기·더 보기** (P13 C.6, FR-1450~1452). 서버가 찾고 거르고 100명씩 나눈다 — 예전에는 처음 100명에서 조용히 끊겨 300명
 * 규모에서 200명을 이 화면에서 관리하지 못했다. **정지·정지 해제** (P13 C.5) — 정지하면 그 사람의 세션과 편집 연결이 그 자리에서 끊긴다.
 *
 * 모양은 관리 다섯의 공통 순서(P17 J.6) — 머리 → 알림띠 → 거르기 줄 → 표. **표의 열 순서와 `td .badge`는 바꾸지 않는다** — 시험이 칸 순서와 배지로 본다.
 * 역할 고르기의 글은 "일반 사용자 (member)" 꼴이고 값은 코드 그대로다(J.9-9)
 */
export function AdminUsersPage() {
  const { me } = useAuth();
  const [confirm, dialog] = useConfirm();
  const principal: Principal | null = me ? { id: me.id, role: me.role, grants: me.grants } : null;
  const manageable = (u: UserView) => principal !== null && canManageUser(principal, { role: u.role, grants: u.grants });
  const [rows, setRows] = useState<UserView[]>([]);
  const [total, setTotal] = useState(0);
  // 한 번이라도 받았는가 — 받기 전에 거절되면(권한 없음) 거르기 줄과 표 없이 알림띠만 보인다
  const [loaded, setLoaded] = useState(false);
  // 알림의 "사용자 관리에서 초기화"가 찾기 칸에 아이디를 넣어 연다 (P17 F-010 8번, `?q=`)
  const [params] = useSearchParams();
  const asked = params.get('q');
  const [q, setQ] = useState(asked ?? '');
  useEffect(() => {
    if (asked !== null) setQ(asked);
  }, [asked]);
  const [filter, setFilter] = useState<UserListFilter | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [temporary, setTemporary] = useState<{ username: string; password: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 늦게 온 옛 응답이 새 찾기의 결과를 덮지 않게 — 마지막 찾기만 받는다
  const seq = useRef(0);
  // **지금 보이는 목록의 조건** — "더 보기"는 입력 칸이 아니라 이 조건으로 이어 받는다. 찾기가 목록을 바꿀 때마다 새 값이 된다 (병합 전 코드 리뷰 10)
  const shown = useRef<{ q: string; filter: UserListFilter | '' }>({ q: '', filter: '' });
  const [moreBusy, setMoreBusy] = useState(false);

  const fetchPage = useCallback((offset: number, query: string, status: UserListFilter | '', limit: number = USER_LIST_PAGE) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (query.trim()) params.set('q', query.trim());
    if (status) params.set('status', status);
    return api<UserListView>(`/api/users?${params.toString()}`);
  }, []);

  /** 처음부터 다시 읽는다 — 찾기·거르기가 바뀌었거나 조치 뒤에(그때는 보던 만큼 — `limit`) */
  const load = useCallback(
    (limit: number = USER_LIST_PAGE) => {
      const mine = ++seq.current;
      fetchPage(0, q, filter, limit)
        .then((r) => {
          if (mine !== seq.current) return;
          shown.current = { q, filter };
          setRows(r.items);
          setTotal(r.total);
          setLoaded(true);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    },
    [fetchPage, q, filter],
  );

  // 입력을 멈추면 찾는다 — 글자마다 서버를 부르지 않는다
  useEffect(() => {
    const t = setTimeout(() => load(), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [load]);

  /**
   * 뒤를 이어 받는다 — **보이는 목록의 조건으로.** 예전에는 입력 칸의 새 조건으로 옛 목록 뒤를 받아 붙이고, 찾기의 순번을 올려 오는 중이던
   * 새 찾기의 결과를 버렸다. 받는 사이 새 찾기가 목록을 바꿨으면 이것을 버린다 (병합 전 코드 리뷰 10)
   */
  const more = () => {
    const at = shown.current;
    setMoreBusy(true);
    fetchPage(rows.length, at.q, at.filter)
      .then((r) => {
        if (shown.current !== at) return;
        setRows((prev) => [...prev, ...r.items]);
        setTotal(r.total);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setMoreBusy(false));
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    // **보던 만큼 다시 읽는다** — 처음 100명으로 돌아가면 뒤쪽에서 조치한 사람이 화면에서 사라졌다 (병합 전 코드 리뷰 10). 실패해도 다시 읽는다 —
    // 그 사이 누가 바꿔 거절됐으면(409) 옛 칸을 그대로 두면 다시 눌러도 같은 거절이다 (P15 병합 전 코드 리뷰 12)
    const reload = () => load(Math.min(USER_LIST_MAX, Math.max(USER_LIST_PAGE, rows.length)));
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      reload();
    }
  };

  // 위임을 보내는 동안 그 줄의 칸을 막는다 — 빨리 둘을 누르면 둘째가 첫째의 결과를 보지 못한 목록을 보낸다(서버는 409로 막는다)
  const [grantPending, setGrantPending] = useState<ReadonlySet<string>>(new Set());
  const changeGrant = (u: UserView, a: DelegableAction, on: boolean) => {
    const grants = on ? [...u.grants, a] : u.grants.filter((g) => g !== a);
    setGrantPending((p) => new Set(p).add(u.id));
    setError(null);
    // **화면이 본 목록을 함께 보낸다** — 서버의 목록과 다르면 409다. 목록 전체를 보내므로 옛 화면이 방금 남이 거둔 위임을 되살렸다 (병합 전 보안 검토 2).
    // **응답으로 그 줄을 곧바로 바꾼 뒤에** 칸을 푼다 — 목록 다시 읽기를 기다리지 않고 풀면 옛 줄로 그려져 연달아 누른 둘째가 거짓 409를 받았다(좁은 재검토 2)
    api<UserView>(`/api/users/${encodeURIComponent(u.id)}/grants`, { method: 'PUT', json: { grants, expected: u.grants } })
      .then((next) => setRows((prev) => prev.map((r) => (r.id === next.id ? next : r))))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        load(Math.min(USER_LIST_MAX, Math.max(USER_LIST_PAGE, rows.length)));
      })
      .finally(() =>
        setGrantPending((p) => {
          const next = new Set(p);
          next.delete(u.id);
          return next;
        }),
      );
  };

  /**
   * 그 역할로 바꾸면 사라지는 위임을 거둘 수 없는가 — 서버가 403으로 막는 선택을 화면이 먼저 막는다(좁은 재검토 14). LLM 연결 관리를 가진 관리자를 member로
   * 내리는 것은 root만 한다(위임을 거두는 것은 규칙표의 주는 사람)
   */
  const blockedRole = (u: UserView, next: Role): boolean =>
    principal !== null && u.grants.some((g) => DELEGATION[g].holder !== next && !canGrant(principal, g, u.role));

  const suspend = async (u: UserView) => {
    // 되돌릴 수 있지만 그 사람의 편집이 그 자리에서 끊긴다 — 한 번 묻는다(J.5.10). 확정 단추는 줄의 "정지"를 품지 않는다
    const ok = await confirm({
      title: '이 사용자를 정지할까요?',
      body: `${u.displayName}(${u.username})님을 정지한다. 세션과 편집 연결이 그 자리에서 끊긴다. 정지 해제로 되돌린다.`,
      confirmLabel: '멈춘다',
    });
    if (!ok) return;
    void act(async () => {
      await api(`/api/users/${encodeURIComponent(u.id)}/suspend`, { method: 'POST' });
      setNotice(`${u.displayName}님을 정지했다.`);
    });
  };

  const resetPassword = async (u: UserView) => {
    // 되돌릴 수 없고 그 사람의 세션과 편집 연결이 그 자리에서 끊긴다 — 한 번 묻는다(J.5.10, P17 병합 전 검토 22). 초기화 요청 알림은 본인의 요청이라는
    // 보증이 아니다(아이디·email만으로 누구나 보낸다) — 본인 확인을 여기서도 말한다. 확정 단추는 줄의 "비밀번호 초기화"를 품지 않는다
    const ok = await confirm({
      title: '이 사용자의 비밀번호를 초기화할까요?',
      body: `${u.displayName}(${u.username})님의 비밀번호를 임시 값으로 바꾼다. 세션과 편집 연결이 그 자리에서 끊기고, 임시 비밀번호는 이 화면에 한 번만 보인다. 요청을 받고 하는 것이면 본인이 요청했는지 먼저 확인한다.`,
      confirmLabel: '새로 만든다',
    });
    if (!ok) return;
    void act(async () => {
      const r = await api<{ temporaryPassword: string }>(`/api/users/${u.id}/reset-password`, { method: 'POST' });
      setTemporary({ username: u.username, password: r.temporaryPassword });
    });
  };

  // 받기 전에 거절됐다 — 권한이 없거나 서버에 닿지 않는다. 같은 틀에 알림띠만 둔다
  const failed = !loaded && error !== null;

  return (
    <Page width="wide">
      {dialog}
      <PageHeader title="사용자 관리" description="가입을 승인하고, 역할·위임을 바꾸고, 잠금·정지·세션을 다룬다." />
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}
      {temporary && (
        // 한 번만 보이는 값 — 닫거나 다른 사람을 초기화하면 사라진다. 찾기용 글 "임시 비밀번호"는 이 구획에 한 번만 둔다
        <Notice kind="warning">
          <p>
            <strong>임시 비밀번호</strong> · {temporary.username}
          </p>
          <CodeBlock label={`${temporary.username}의 임시 값`}>{temporary.password}</CodeBlock>
          <p>이 값은 다시 볼 수 없다. 지금 전달한다.</p>
          <div className="actions">
            <button type="button" className="sm" onClick={() => setTemporary(null)}>
              닫기
            </button>
          </div>
        </Notice>
      )}
      {!failed && (
        <FilterBar label="사용자 찾기" count={`전체 ${total}명 · ${rows.length}명 보는 중`}>
          <Field id="user-q" label="찾기">
            <input id="user-q" type="search" className="w-m" value={q} placeholder="아이디·이름·email" maxLength={LIST_SEARCH_MAX} onChange={(e) => setQ(e.target.value)} />
          </Field>
          <Field id="user-status" label="상태">
            <select id="user-status" className="w-s" value={filter} onChange={(e) => setFilter(e.target.value as UserListFilter | '')}>
              <option value="">전체</option>
              {USER_LIST_FILTERS.map((f) => (
                <option key={f} value={f}>
                  {STATUS_LABELS[f]}
                </option>
              ))}
            </select>
          </Field>
        </FilterBar>
      )}
      {!loaded ? (
        !failed && <Loading />
      ) : (
        <div className="table-scroll" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">아이디</th>
                <th scope="col">이름</th>
                <th scope="col">역할</th>
                <th scope="col">상태</th>
                <th scope="col">위임</th>
                <th scope="col">조치</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    찾는 조건에 맞는 사람이 없다.
                  </td>
                </tr>
              )}
              {rows.map((u) => {
                const manages = manageable(u);
                const self = u.id === me?.id;
                const reason = manages ? undefined : CANNOT_MANAGE;
                return (
                  <tr key={u.id}>
                    <td className="break-any">{u.username}</td>
                    <td>{u.displayName}</td>
                    <td>
                      <select
                        className="w-m"
                        value={u.role}
                        aria-label={`${u.username} 역할`}
                        disabled={!manages}
                        title={reason}
                        onChange={(e) => void act(() => api(`/api/users/${u.id}/role`, { method: 'PATCH', json: { role: e.target.value as Role } }))}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r} disabled={r !== u.role && blockedRole(u, r)}>
                            {withCode(ROLE_NAMES[r], r)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <StatusBadge kind={STATUS_KIND[u.status]}>{STATUS_LABELS[u.status]}</StatusBadge>
                    </td>
                    <td>
                      {/* 그 역할이 받을 수 있는 위임만 — 관리자는 LLM 연결 관리, member는 셋, root는 없다(규칙표, P15 D.1). 역할이 바뀌면 서버가 비운다.
                          칸마다 한 줄 — 옆으로 늘어놓으면 1280px에서 표가 넘친다 */}
                      {DELEGABLE_ACTIONS.some((a) => DELEGATION[a].holder === u.role) ? (
                        DELEGABLE_ACTIONS.filter((a) => DELEGATION[a].holder === u.role).map((a) => {
                          const allowed = principal !== null && canGrant(principal, a, u.role) && manages;
                          return (
                            <div key={a}>
                              <label>
                                <input
                                  type="checkbox"
                                  aria-label={`${u.username} ${GRANT_LABELS[a]}`}
                                  checked={u.grants.includes(a)}
                                  disabled={!allowed || grantPending.has(u.id)}
                                  title={allowed ? undefined : DELEGATION[a].grantor === 'root' ? '시스템 관리자만 주고 거둔다' : CANNOT_MANAGE}
                                  onChange={(e) => changeGrant(u, a, e.target.checked)}
                                />
                                {GRANT_LABELS[a]}
                              </label>
                            </div>
                          );
                        })
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <div className="actions">
                        {u.status === 'pending' && (
                          <button type="button" className="primary sm" disabled={!manages} title={reason} onClick={() => void act(() => api(`/api/users/${u.id}/approve`, { method: 'POST' }))}>
                            승인
                          </button>
                        )}
                        {u.status === 'locked' && (
                          <button type="button" className="sm" disabled={!manages} title={reason} onClick={() => void act(() => api(`/api/users/${u.id}/unlock`, { method: 'POST' }))}>
                            잠금 해제
                          </button>
                        )}
                        <button
                          type="button"
                          className="danger sm"
                          disabled={!manages}
                          title={reason}
                          onClick={() => void resetPassword(u)}
                        >
                          비밀번호 초기화
                        </button>
                        {(u.status === 'active' || u.status === 'locked') && (
                          <button type="button" className="danger sm" disabled={!manages || self} title={self ? CANNOT_SUSPEND_SELF : reason} onClick={() => void suspend(u)}>
                            정지
                          </button>
                        )}
                        {u.status === 'suspended' && (
                          <button
                            type="button"
                            className="sm"
                            disabled={!manages}
                            title={reason}
                            onClick={() => void act(() => api(`/api/users/${encodeURIComponent(u.id)}/unsuspend`, { method: 'POST' }))}
                          >
                            정지 해제
                          </button>
                        )}
                        {/* 관리자 강제 종료 (scope-definition 4.1절 #4). 서버측 세션을 파기한다 */}
                        <button
                          type="button"
                          className="sm"
                          disabled={!manages}
                          title={reason}
                          onClick={() =>
                            void act(async () => {
                              const r = await api<{ count: number }>(`/api/users/${u.id}/terminate-sessions`, { method: 'POST' });
                              setNotice(`${u.displayName}님의 세션 ${r.count}개를 끊었다.`);
                            })
                          }
                        >
                          세션 강제 종료
                        </button>
                      </div>
                      {/* 누를 수 없는 까닭은 글로도 보인다(J.5.2) — 관리할 수 없는 줄은 전부, 자기 줄은 정지만 */}
                      {!manages ? <p className="muted small">{CANNOT_MANAGE}</p> : self && (u.status === 'active' || u.status === 'locked') && <p className="muted small">{CANNOT_SUSPEND_SELF}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {loaded && rows.length < total && (
        <div className="actions">
          <button type="button" onClick={more} disabled={moreBusy}>
            더 보기
          </button>
        </div>
      )}
      {!failed && (
        <>
          <p className="muted small">정지된 사람은 로그인하지 못한다. 쓴 문서·댓글·공간 소속은 남고, 정지를 풀면 그대로 이어진다.</p>
          <p className="muted small">
            위임은 사람마다 주고 거둔다 — LLM 연결 관리는 시스템 관리자가 관리자에게, 분류 관리·관리자가 건 중지 풀기·스페이스 관리 전체는 관리자가 일반 사용자에게. 그 역할이 아니게 되면 사라진다. 자기에게 없는 위임을 가진 관리자는 시스템 관리자만 관리한다.
          </p>
        </>
      )}
    </Page>
  );
}
