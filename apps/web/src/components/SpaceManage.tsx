import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { CategoryView, SpaceView } from '@workfluence/shared';
import { api } from '../api';
import { CategoryList } from './CategoryList';

/**
 * 중지를 묻는 말 — 스페이스 화면의 관리 칸과 관리 콘솔이 같이 쓴다(같은 말을 두 곳에 적으면 한쪽만 바뀐다). **열어 둔 편집 창은 곧바로 끊기지
 * 않는다** — 주기 재판정(`WF_COLLAB_RECHECK_MS`, 기본 5분)이 끊는다(병합 전 자체 점검 15)
 */
export function confirmSuspendText(name: string): string {
  return `"${name}"을(를) 중지한다. 모두 읽기만 되고(열어 둔 편집 창은 몇 분 안에 끊긴다), 다시 쓰기로 되돌릴 수 있다.`;
}

/**
 * 스페이스 화면의 **관리** 칸 (P14_설계서_Spaces D.3, FR-1510·1511 · P15_설계서_Grants D.5). 보이는 조건은 응답의 `access`다(P2 FR-345) — 화면은
 * 규칙을 다시 만들지 않는다. 이름·설명·분류는 `canEditInfo`(주인과 관리자), 중지·다시 쓰기는 `canChangeStatus`(지금 상태에서 바꿀 수 있는가),
 * 지우기는 `canDelete`. 중지된 스페이스는 이름·설명·분류를 바꿀 수 없다(서버 규칙).
 *
 * **새 분류**를 여기서 만든다(P15 FR-1620) — 만든 것이 고른 상태가 되고, 공간에 붙는 것은 **저장**을 눌렀을 때다(A.1-8). 아래 **분류 관리**는 내가
 * **만들었고** 이름을 바꾸거나 지울 수 있는 분류들이다(`CategoryList`) — 관리자는 모든 분류를 바꾸지만 그것을 공간마다 늘어놓지 않는다(관리 콘솔의
 * 스페이스 관리가 모든 분류를 보인다). 중지된 공간에는 누가 중지했는지 보이고, 관리자가 건 중지를 풀지 못하는 주인에게는 그 까닭을 보인다(FR-1612).
 *
 * 중지와 지우기는 한 번 더 묻는다(A.1-7). 지우면 스페이스 목록으로 간다 — 되살리기는 관리자가 휴지통에서 한다
 */
export function SpaceManage({
  space,
  meId,
  onChanged,
  onDeleted,
}: {
  space: SpaceView;
  meId: string | undefined;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description);
  const [categoryId, setCategoryId] = useState(space.categoryId ?? '');
  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [newCategory, setNewCategory] = useState('');
  // 만들기를 두 번 누르면 같은 이름이 두 번 간다 — 앞의 것이 끝날 때까지 받지 않는다
  const creating = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = space.status === 'active';
  const { canEditInfo, canChangeStatus, canDelete, isOwner } = space.access;
  // 중지된 공간의 주인에게도 보인다 — 풀지 못해도 까닭은 들어야 한다 (P15 FR-1612)
  const visible = canEditInfo || canChangeStatus || canDelete;

  // **서버의 값이 바뀌었을 때만** 칸을 맞춘다 — 부모는 Crew를 바꿀 때도 스페이스를 다시 읽는데, 그때마다 맞추면 치던 이름·설명이 지워졌다(병합 전 검토)
  useEffect(() => {
    setName(space.name);
    setDescription(space.description);
    setCategoryId(space.categoryId ?? '');
  }, [space.id, space.name, space.description, space.categoryId]);
  const loadCategories = useCallback(() => {
    api<CategoryView[]>('/api/categories')
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);
  useEffect(() => {
    // 이름·분류를 바꿀 수 있을 때만 읽는다. 분류를 못 읽어도 나머지 관리는 된다 — 화면 오류로 올리지 않는다
    if (canEditInfo) loadCategories();
  }, [canEditInfo, loadCategories]);

  if (!visible) return null;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api(`/api/spaces/${space.id}`, { method: 'PATCH', json: { name, description, categoryId: categoryId || null } }), '저장했다.');
  };

  // 새 분류 — 만들거나(같은 이름이면 있던 것을) 고른다. 저장을 눌러야 붙는다 (P15 A.1-8)
  const addCategory = () => {
    const n = newCategory.trim();
    if (!n || creating.current) return;
    creating.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    api<CategoryView>('/api/categories', { method: 'POST', json: { name: n } })
      .then((c) => {
        const existed = categories.some((x) => x.id === c.id);
        setCategories((list) => (list.some((x) => x.id === c.id) ? list : [...list, c].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))));
        setCategoryId(c.id);
        setNewCategory('');
        setNotice(existed ? `있던 분류 "${c.name}"을(를) 골랐다 — 저장을 누르면 붙는다.` : `분류 "${c.name}"을(를) 만들어 골랐다 — 저장을 누르면 붙는다.`);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        creating.current = false;
        setBusy(false);
      });
  };

  const changeStatus = (status: 'active' | 'suspended') => {
    if (status === 'suspended' && !window.confirm(confirmSuspendText(space.name))) return;
    void run(
      () => api(`/api/spaces/${space.id}/status`, { method: 'PATCH', json: { status } }),
      status === 'suspended' ? '중지했다 — 읽기만 된다.' : '다시 쓸 수 있게 했다.',
    );
  };

  const remove = async () => {
    if (!window.confirm(`"${space.name}"을(를) 지운다. 스페이스와 그 안의 페이지가 보이지 않게 된다 — 되살리기는 관리자가 휴지통에서 한다.`)) return;
    setError(null);
    try {
      await api(`/api/spaces/${space.id}`, { method: 'DELETE' });
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="card" aria-label="스페이스 관리">
      <h2>관리</h2>
      {error && <p className="badge fail" role="alert">{error}</p>}
      {notice && <p className="badge" role="status">{notice}</p>}
      {!active && (
        <p className="small" role="note">
          {space.suspendedByOwner ? '주인이 중지한 스페이스다.' : '관리자가 중지한 스페이스다.'}
          {!canChangeStatus && isOwner && (
            <>
              {' '}
              주인도 다시 쓰기로 풀지 못한다 — 관리자에게 부탁하거나, 관리자에게 <strong>관리자가 건 중지 풀기</strong>를 받는다.
            </>
          )}
        </p>
      )}
      {canEditInfo && (
        <>
          <form onSubmit={save}>
            <label htmlFor="sp-name">이름</label>
            <input id="sp-name" value={name} onChange={(e) => setName(e.target.value)} required disabled={!active} />
            <label htmlFor="sp-desc">설명</label>
            <textarea id="sp-desc" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!active} />
            <label htmlFor="sp-cat">분류</label>
            <select id="sp-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={!active}>
              <option value="">분류 없음</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {active && (
              <p className="row">
                <label htmlFor="sp-cat-new">새 분류</label>{' '}
                <input
                  id="sp-cat-new"
                  value={newCategory}
                  maxLength={50}
                  onChange={(e) => setNewCategory(e.target.value)}
                  onKeyDown={(e) => {
                    // 이 칸의 Enter는 저장이 아니라 만들기다 — 저장하지 않은 이름·설명과 따로 논다
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCategory();
                    }
                  }}
                />{' '}
                <button type="button" onClick={addCategory} disabled={busy || !newCategory.trim()}>
                  분류 만들기
                </button>
              </p>
            )}
            <button type="submit" disabled={!active}>
              저장
            </button>
            {!active && <p className="muted small">중지된 스페이스는 이름·설명·분류를 바꿀 수 없다. 먼저 다시 쓸 수 있게 한다.</p>}
          </form>
          <h3>분류 관리</h3>
          <CategoryList
            categories={categories.filter((c) => c.createdBy === meId)}
            editableOnly
            onNotice={setNotice}
            onError={setError}
            emptyText="내가 만들어 이름을 바꾸거나 지울 수 있는 분류가 없다 — 남의 공간이 쓰는 분류는 관리자가 바꾼다."
            onChanged={() => {
              loadCategories();
              onChanged();
            }}
          />
        </>
      )}
      {canChangeStatus && (
        <p>
          {active ? (
            <button type="button" onClick={() => changeStatus('suspended')}>
              중지
            </button>
          ) : (
            <button type="button" onClick={() => changeStatus('active')}>
              다시 쓰기
            </button>
          )}
        </p>
      )}
      {canDelete ? (
        <p>
          <button type="button" onClick={() => void remove()}>
            지우기
          </button>
        </p>
      ) : (
        <p className="muted small">지우기는 활성 스페이스에서 Crew가 본인뿐인 주인, 또는 중지된 스페이스에서 관리자(와 스페이스 관리 전체를 받은 사람)가 할 수 있다.</p>
      )}
    </section>
  );
}
