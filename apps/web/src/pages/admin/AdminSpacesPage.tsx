import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { CATEGORY_NAME_MAX, LIST_SEARCH_MAX, SPACE_LIST_MAX, SPACE_STATUSES, can, type CategoryView, type SpaceStatus, type SpaceView } from '@workfluence/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { CategoryList } from '../../components/CategoryList';
import { useConfirm } from '../../components/ConfirmDialog';
import { canTakeOver, deleteSpaceConfirm, suspendConfirm, takeoverConfirm } from '../../components/SpaceManage';
import { Field, FilterBar, Loading, Notice, Page, PageHeader, StatusBadge } from '../../components/ui';
import { SEARCH_DELAY_MS } from '../../timing';

const STATUS_LABELS: Record<SpaceStatus, string> = { active: '활성', suspended: '중지' };

/** 결과를 보일 구획 — 조치한 구획 바로 위에 둔다(P17 J.5.7). 표의 조치는 표 위, 분류의 조치는 분류 구획 안 */
type Area = 'spaces' | 'category';

/**
 * 관리 콘솔의 **스페이스** (P14_설계서_Spaces D.3, FR-1513~1515 · P15_설계서_Grants D.5). 모든 스페이스를 이름·키로 찾고 상태로 거른다 — **서버가
 * 찾고 거른다**(`q`·`status`, 한 번에 `SPACE_LIST_MAX`개). 화면에서만 거르면 상한 밖의 스페이스를 찾지 못한다(T-051). 줄마다 중지·다시 쓰기·지우기 —
 * 보이는 조건은 응답의 `access`다(중지된 것만 지운다 — P2 `spaceAccess`). 아래에 **분류** — 만들기와 이름 바꾸기·지우기(`CategoryList` — 줄마다
 * 할 수 있는지는 응답이 말한다. 지우면 쓰던 공간은 분류 없음이 된다).
 *
 * 여는 사람은 관리자·root와, 관리자가 **스페이스 관리 전체**나 **분류 관리**를 맡긴 member다. 모든 스페이스 표는 스페이스 관리 전체일 때만 보인다.
 *
 * 모양 (P17 J.6 관리 다섯): 머리 → 모든 스페이스(알림띠 → 거르기 줄 → 표) → 분류 구획(알림띠 → 줄 목록 → 새 분류 한 줄). 표의 열 순서는 바꾸지
 * 않는다 — 시험이 칸 순서로 본다(J.5.5). 줄의 조치는 접지 않고 늘어놓는다. 중지·지우기·넘겨받기는 확인 대화로 묻는다(J.5.10) — 묻는 말과 확정
 * 단추는 스페이스 화면의 관리 칸과 같다(`SpaceManage`의 `suspendConfirm` 등 — 같은 말을 두 곳에 적으면 한쪽만 바뀐다)
 */
export function AdminSpacesPage() {
  const { me } = useAuth();
  const principal = me ? { id: me.id, role: me.role, grants: me.grants } : null;
  const overseer = principal ? can(principal, 'space.oversee') : false;
  const allowed = overseer || (principal ? can(principal, 'category.manage') : false);
  const [rows, setRows] = useState<SpaceView[]>([]);
  // 첫 목록이 오기 전에는 표를 그리지 않는다 — 빈 표를 "맞는 스페이스가 없다"로 읽게 된다
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<SpaceStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  // 목록 찾기의 실패는 따로 둔다 — 찾기가 되면 그것만 지운다. 하나로 두면 찾기가 될 때 분류 읽기·조치의 실패까지 지웠다(반영분 점검 5)
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [area, setArea] = useState<Area>('spaces');
  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [newCategory, setNewCategory] = useState('');
  // 만들기를 두 번 누르면 같은 이름이 두 번 간다 — 앞의 것이 끝날 때까지 받지 않는다
  const creating = useRef(false);
  const [busy, setBusy] = useState(false);
  // 늦게 온 옛 응답이 새 찾기의 결과를 덮지 않게 — 마지막 찾기만 받는다
  const seq = useRef(0);
  const [confirm, dialog] = useConfirm();

  const load = useCallback(() => {
    const mine = ++seq.current;
    const params = new URLSearchParams({ scope: 'all', limit: String(SPACE_LIST_MAX) });
    if (q.trim()) params.set('q', q.trim());
    if (status) params.set('status', status);
    api<SpaceView[]>(`/api/spaces?${params.toString()}`)
      .then((r) => {
        if (mine !== seq.current) return;
        setRows(r);
        setLoaded(true);
        // 찾기가 다시 되면 앞선 찾기의 실패는 지난 일이다 (병합 전 검토)
        setListError(null);
      })
      .catch((e: unknown) => {
        // 늦게 온 옛 찾기의 실패도 받지 않는다 — 성공처럼 마지막 찾기만
        if (mine === seq.current) setListError(e instanceof Error ? e.message : String(e));
      });
  }, [q, status]);

  const loadCategories = useCallback(() => {
    api<CategoryView[]>('/api/categories')
      .then(setCategories)
      .catch((e: unknown) => {
        setArea('category');
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  // 입력을 멈추면 찾는다 — 글자마다 서버를 부르지 않는다. 모든 스페이스는 스페이스 관리 전체만 읽는다(분류 관리만 받은 사람은 403이다)
  useEffect(() => {
    if (!overseer) return;
    const t = setTimeout(load, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [overseer, load]);
  useEffect(() => {
    if (allowed) loadCategories();
  }, [allowed, loadCategories]);

  const act = async (fn: () => Promise<unknown>, done: string, after: () => void = load) => {
    setArea('spaces');
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      after();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // 그 사이 누가 바꿔 거절됐으면(409) 지금 상태를 다시 읽는다 — 옛 단추가 남으면 다시 눌러도 같은 거절이다(P15 병합 전 코드 리뷰 12)
      after();
    }
  };

  const changeStatus = async (s: SpaceView, next: SpaceStatus) => {
    // 다시 쓰기는 묻지 않는다 — 되돌리는 쪽이다
    if (next === 'suspended' && !(await confirm(suspendConfirm(s.name)))) return;
    await act(
      () => api(`/api/spaces/${s.id}/status`, { method: 'PATCH', json: { status: next } }),
      next === 'suspended' ? `"${s.name}"을(를) 중지했다.` : `"${s.name}"을(를) 다시 쓸 수 있게 했다.`,
    );
  };

  const remove = async (s: SpaceView) => {
    if (!(await confirm(deleteSpaceConfirm(s.name)))) return;
    await act(() => api(`/api/spaces/${s.id}`, { method: 'DELETE' }), `"${s.name}"을(를) 지웠다 — 휴지통에 있다.`);
  };

  // 주인이 건 중지를 관리자가 건 중지로 — 같은 상태를 다시 보내면 서버가 넘겨받는다 (P15 A.1-12, 병합 전 보안 검토 1)
  const takeOver = async (s: SpaceView) => {
    if (!(await confirm(takeoverConfirm(s.name)))) return;
    // 화면이 본 상태(주인이 건 중지)를 싣는다 — 그 사이 주인이 풀었으면 서버가 새 중지로 만들지 않고 409다(좁은 재검토 12)
    await act(() => api(`/api/spaces/${s.id}/status`, { method: 'PATCH', json: { status: 'suspended', takeover: true } }), `"${s.name}"을(를) 관리자가 건 중지로 바꿨다.`);
  };

  const addCategory = (e: FormEvent) => {
    e.preventDefault();
    const name = newCategory.trim();
    if (!name || creating.current) return;
    creating.current = true;
    setBusy(true);
    // 같은 이름이 이미 있으면 서버는 있던 것을 돌려준다 — "만들었다"고 하지 않는다 (병합 전 검토)
    setArea('category');
    setError(null);
    setNotice(null);
    api<CategoryView>('/api/categories', { method: 'POST', json: { name } })
      .then((c) => {
        setNotice(categories.some((x) => x.id === c.id) ? `분류 "${c.name}"은(는) 이미 있다.` : `분류 "${c.name}"을(를) 만들었다.`);
        setNewCategory('');
        loadCategories();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        creating.current = false;
        setBusy(false);
      });
  };

  /** 그 구획의 결과·거절 — 방금의 결과는 하나다(칸이 둘이면 어느 것이 방금의 결과인지 헷갈린다) */
  const notices = (where: Area) =>
    area === where && (
      <>
        {error && <Notice kind="error">{error}</Notice>}
        {notice && <Notice kind="success">{notice}</Notice>}
      </>
    );

  if (!allowed) {
    return (
      <Page>
        <PageHeader title="스페이스 관리" />
        <Notice kind="error">권한이 없다 — 스페이스 관리는 관리자와, 관리자가 스페이스 관리 전체나 분류 관리를 맡긴 사람이 한다.</Notice>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="스페이스 관리"
        // 지운 스페이스는 스페이스 관리 전체가 되살린다 — 분류 관리만 받은 사람의 휴지통에는 그 칸이 없다 (병합 전 문서 정합성 24).
        // 휴지통은 위 막대의 주 메뉴에 있다 — 본문에 같은 이름의 링크를 두지 않는다(J.8-1)
        description={
          overseer
            ? '모든 스페이스를 찾아 중지·다시 쓰기·지우기를 하고 분류를 관리한다. 지운 스페이스는 휴지통에서 되살린다.'
            : '분류를 만들고 이름을 바꾸고 지운다.'
        }
      />

      {overseer && (
        <>
          <h2>모든 스페이스</h2>
          {listError && <Notice kind="error">{listError}</Notice>}
          {notices('spaces')}
          <FilterBar
            label="스페이스 찾기"
            count={loaded ? `${rows.length}개${rows.length >= SPACE_LIST_MAX ? ` — 한 번에 ${SPACE_LIST_MAX}개까지 보인다. 찾기로 좁힌다` : ''}` : ''}
          >
            <Field id="admin-spaces-q" label="찾기">
              <input id="admin-spaces-q" type="search" className="w-m" value={q} placeholder="이름·키" maxLength={LIST_SEARCH_MAX} onChange={(e) => setQ(e.target.value)} />
            </Field>
            <Field id="admin-spaces-status" label="상태">
              <select id="admin-spaces-status" className="w-s" value={status} onChange={(e) => setStatus(e.target.value as SpaceStatus | '')}>
                <option value="">전체</option>
                {SPACE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
          </FilterBar>

          {loaded ? (
            // 넘칠 때만 가로로 민다 — 키보드로도 밀 수 있게 초점을 받는다(J.5.5)
            <div className="table-scroll" tabIndex={0}>
              <table aria-label="모든 스페이스">
                <thead>
                  <tr>
                    <th>이름</th>
                    <th>키</th>
                    <th>종류</th>
                    <th>상태</th>
                    <th>분류</th>
                    <th className="num">Crew</th>
                    <th>만든 사람</th>
                    <th>조치</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link to={`/spaces/${s.id}`}>{s.name}</Link>
                      </td>
                      <td className="mono">{s.key}</td>
                      <td>{s.kind === 'personal' ? '개인' : '팀'}</td>
                      <td>
                        {s.status === 'active' ? (
                          <StatusBadge kind="ok">{STATUS_LABELS.active}</StatusBadge>
                        ) : (
                          <>
                            <StatusBadge kind="paused">{STATUS_LABELS.suspended}</StatusBadge>{' '}
                            {/* 누가 걸었나 — 관리자가 건 중지는 권한을 받은 주인만 푼다 (P15 FR-1612) */}
                            <span className="muted small">{s.suspendedByOwner ? '주인이 걸었다' : '관리자가 걸었다'}</span>
                          </>
                        )}
                      </td>
                      <td>{s.categoryName ?? '—'}</td>
                      <td className="num">{s.kind === 'team' ? s.memberCount : '—'}</td>
                      <td>{s.createdByUsername}</td>
                      <td className="actions-cell">
                        <div className="actions">
                          {s.access.canChangeStatus &&
                            (s.status === 'active' ? (
                              <button type="button" className="danger sm" onClick={() => void changeStatus(s, 'suspended')}>
                                중지
                              </button>
                            ) : (
                              <button type="button" className="sm" onClick={() => void changeStatus(s, 'active')}>
                                다시 쓰기
                              </button>
                            ))}
                          {canTakeOver(s) && (
                            <button type="button" className="sm" onClick={() => void takeOver(s)}>
                              관리자가 건 중지로 바꾸기
                            </button>
                          )}
                          {s.access.canDelete && (
                            <button type="button" className="danger sm" onClick={() => void remove(s)}>
                              지우기
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="empty">
                        맞는 스페이스가 없다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            !listError && <Loading />
          )}
        </>
      )}

      <section className="card" aria-label="분류">
        <h2>분류</h2>
        <p className="muted small">분류를 지우면 쓰던 스페이스(휴지통 포함)는 분류 없음이 된다 — 어느 스페이스였는지 감사로그에 남는다.</p>
        {notices('category')}
        <CategoryList
          categories={categories}
          meId={me?.id}
          onNotice={(t) => {
            setArea('category');
            setNotice(t);
          }}
          onError={(t) => {
            setArea('category');
            setError(t);
          }}
          onChanged={() => {
            loadCategories();
            if (overseer) load();
          }}
        />
        {/* 칸 하나 + 단추 한 줄 (J.5.4) */}
        <form className="inline-form" onSubmit={addCategory}>
          <Field id="cat-new" label="새 분류">
            <input id="cat-new" className="w-m" value={newCategory} maxLength={CATEGORY_NAME_MAX} onChange={(e) => setNewCategory(e.target.value)} required />
          </Field>
          <button type="submit" className="primary" disabled={busy}>
            만들기
          </button>
        </form>
      </section>
      {dialog}
    </Page>
  );
}
