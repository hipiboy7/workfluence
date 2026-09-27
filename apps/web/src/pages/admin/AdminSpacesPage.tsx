import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { SPACE_LIST_MAX, SPACE_STATUSES, can, type CategoryView, type SpaceStatus, type SpaceView } from '@workfluence/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';

/** 입력을 멈추고 이만큼 뒤에 찾는다 — 사용자 관리와 같다 */
const SEARCH_DELAY_MS = 300;

const STATUS_LABELS: Record<SpaceStatus, string> = { active: '활성', suspended: '중지' };

/**
 * 관리 콘솔의 **스페이스** (P14_설계서_Spaces D.3, FR-1513~1515). 모든 스페이스를 이름·키로 찾고 상태로 거른다 — **서버가 찾고 거른다**(`q`·`status`,
 * 한 번에 `SPACE_LIST_MAX`개). 화면에서만 거르면 상한 밖의 스페이스를 찾지 못한다(T-051). 줄마다 중지·다시 쓰기·지우기 — 보이는 조건은 응답의
 * `access`다(관리자는 중지된 것만 지운다 — P2 `spaceAccess`). 아래에 **분류** — 만들기·이름 바꾸기·지우기(쓰는 스페이스가 있으면 서버가 거절한다)
 */
export function AdminSpacesPage() {
  const { me } = useAuth();
  const allowed = me ? can({ id: me.id, role: me.role, grants: me.grants }, 'space.manage') : false;
  const [rows, setRows] = useState<SpaceView[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<SpaceStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [newCategory, setNewCategory] = useState('');
  const [renaming, setRenaming] = useState<Record<string, string>>({});
  // 늦게 온 옛 응답이 새 찾기의 결과를 덮지 않게 — 마지막 찾기만 받는다
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    const params = new URLSearchParams({ scope: 'all', limit: String(SPACE_LIST_MAX) });
    if (q.trim()) params.set('q', q.trim());
    if (status) params.set('status', status);
    api<SpaceView[]>(`/api/spaces?${params.toString()}`)
      .then((r) => {
        if (mine === seq.current) setRows(r);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [q, status]);

  const loadCategories = useCallback(() => {
    api<CategoryView[]>('/api/categories')
      .then(setCategories)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // 입력을 멈추면 찾는다 — 글자마다 서버를 부르지 않는다
  useEffect(() => {
    if (!allowed) return;
    const t = setTimeout(load, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [allowed, load]);
  useEffect(() => {
    if (allowed) loadCategories();
  }, [allowed, loadCategories]);

  const act = async (fn: () => Promise<unknown>, done: string, after: () => void = load) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      after();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const changeStatus = (s: SpaceView, next: SpaceStatus) => {
    if (next === 'suspended' && !window.confirm(`"${s.name}"을(를) 중지한다. 모두 읽기만 되고, 다시 쓰기로 되돌릴 수 있다.`)) return;
    void act(
      () => api(`/api/spaces/${s.id}/status`, { method: 'PATCH', json: { status: next } }),
      next === 'suspended' ? `"${s.name}"을(를) 중지했다.` : `"${s.name}"을(를) 다시 쓸 수 있게 했다.`,
    );
  };

  const remove = (s: SpaceView) => {
    if (!window.confirm(`"${s.name}"을(를) 지운다. 스페이스와 그 안의 페이지가 보이지 않게 된다 — 휴지통에서 되살린다.`)) return;
    void act(() => api(`/api/spaces/${s.id}`, { method: 'DELETE' }), `"${s.name}"을(를) 지웠다 — 휴지통에 있다.`);
  };

  const addCategory = (e: FormEvent) => {
    e.preventDefault();
    const name = newCategory.trim();
    if (!name) return;
    void act(() => api('/api/categories', { method: 'POST', json: { name } }), `분류 "${name}"을(를) 만들었다.`, () => {
      setNewCategory('');
      loadCategories();
    });
  };

  const renameCategory = (c: CategoryView) => {
    const name = (renaming[c.id] ?? c.name).trim();
    if (!name || name === c.name) return;
    void act(() => api(`/api/categories/${c.id}`, { method: 'PATCH', json: { name } }), `분류 이름을 "${name}"(으)로 바꿨다.`, () => {
      setRenaming((r) => {
        const next = { ...r };
        delete next[c.id];
        return next;
      });
      loadCategories();
      load();
    });
  };

  const removeCategory = (c: CategoryView) => {
    if (!window.confirm(`분류 "${c.name}"을(를) 지운다.`)) return;
    void act(() => api(`/api/categories/${c.id}`, { method: 'DELETE' }), `분류 "${c.name}"을(를) 지웠다.`, loadCategories);
  };

  if (!allowed) {
    return (
      <main className="shell">
        <h1>스페이스 관리</h1>
        <p className="badge fail" role="alert">권한이 없다 — 스페이스 관리는 관리자만 한다.</p>
        <p className="muted small"><Link to="/">← 홈</Link></p>
      </main>
    );
  }

  return (
    <main className="shell">
      <h1>스페이스 관리</h1>
      <p className="muted small"><Link to="/">← 홈</Link> · 지운 스페이스는 <Link to="/trash">휴지통</Link>에서 되살린다</p>
      {error && <p className="badge fail" role="alert">{error}</p>}
      {notice && <p className="badge" role="status">{notice}</p>}

      <form className="card row" role="search" onSubmit={(e) => e.preventDefault()}>
        <label>
          찾기{' '}
          <input type="search" value={q} placeholder="이름·키" onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>
          상태{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value as SpaceStatus | '')}>
            <option value="">전체</option>
            {SPACE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small" aria-live="polite">
          {rows.length}개{rows.length >= SPACE_LIST_MAX ? ` — 한 번에 ${SPACE_LIST_MAX}개까지 보인다. 찾기로 좁힌다` : ''}
        </span>
      </form>

      <table className="card" aria-label="모든 스페이스">
        <thead>
          <tr><th>이름</th><th>키</th><th>종류</th><th>상태</th><th>분류</th><th>Crew</th><th>만든 사람</th><th>조치</th></tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td><Link to={`/spaces/${s.id}`}>{s.name}</Link></td>
              <td>{s.key}</td>
              <td>{s.kind === 'personal' ? '개인' : '팀'}</td>
              <td>{s.status === 'active' ? STATUS_LABELS.active : <span className="badge fail">{STATUS_LABELS.suspended}</span>}</td>
              <td>{s.categoryName ?? '—'}</td>
              <td>{s.kind === 'team' ? s.memberCount : '—'}</td>
              <td>{s.createdByUsername}</td>
              <td>
                {s.access.canChangeStatus &&
                  (s.status === 'active' ? (
                    <button type="button" onClick={() => changeStatus(s, 'suspended')}>중지</button>
                  ) : (
                    <button type="button" onClick={() => changeStatus(s, 'active')}>다시 쓰기</button>
                  ))}
                {s.access.canDelete && (
                  <>
                    {' '}
                    <button type="button" onClick={() => remove(s)}>지우기</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">맞는 스페이스가 없다.</p>}

      <section className="card" aria-label="분류">
        <h2>분류</h2>
        <p className="muted small">스페이스가 쓰는 분류는 지울 수 없다 — 먼저 그 스페이스들의 분류를 바꾼다.</p>
        <ul>
          {categories.map((c) => (
            <li key={c.id}>
              <input
                aria-label={`분류 ${c.name} 이름`}
                value={renaming[c.id] ?? c.name}
               
                onChange={(e) => setRenaming((r) => ({ ...r, [c.id]: e.target.value }))}
              />{' '}
              <button type="button" onClick={() => renameCategory(c)} disabled={(renaming[c.id] ?? c.name).trim() === c.name}>
                이름 바꾸기
              </button>{' '}
              <button type="button" onClick={() => removeCategory(c)}>지우기</button>
            </li>
          ))}
        </ul>
        {categories.length === 0 && <p className="muted">분류가 없다.</p>}
        <form onSubmit={addCategory}>
          <label htmlFor="cat-new">새 분류</label>
          <input id="cat-new" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} required />
          <button type="submit">만들기</button>
        </form>
      </section>
    </main>
  );
}
