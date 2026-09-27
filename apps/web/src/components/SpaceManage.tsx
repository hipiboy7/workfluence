import { useEffect, useState, type FormEvent } from 'react';
import type { CategoryView, SpaceView } from '@workfluence/shared';
import { api } from '../api';

/**
 * 중지를 묻는 말 — 스페이스 화면의 관리 칸과 관리 콘솔이 같이 쓴다(같은 말을 두 곳에 적으면 한쪽만 바뀐다). **열어 둔 편집 창은 곧바로 끊기지
 * 않는다** — 주기 재판정(`WF_COLLAB_RECHECK_MS`, 기본 5분)이 끊는다(병합 전 자체 점검 15)
 */
export function confirmSuspendText(name: string): string {
  return `"${name}"을(를) 중지한다. 모두 읽기만 되고(열어 둔 편집 창은 몇 분 안에 끊긴다), 다시 쓰기로 되돌릴 수 있다.`;
}

/**
 * 스페이스 화면의 **관리** 칸 (P14_설계서_Spaces D.3, FR-1510·1511). 보이는 조건은 응답의 `access`다(P2 FR-345) — 화면은 규칙을 다시 만들지
 * 않는다. 이름·설명·분류와 중지·다시 쓰기는 `canChangeStatus`, 지우기는 `canDelete`. 중지된 스페이스는 이름·설명·분류를 바꿀 수 없다(서버 규칙).
 *
 * 중지와 지우기는 한 번 더 묻는다(A.1-7). 지우면 스페이스 목록으로 간다 — 되살리기는 관리자가 휴지통에서 한다
 */
export function SpaceManage({ space, onChanged, onDeleted }: { space: SpaceView; onChanged: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description);
  const [categoryId, setCategoryId] = useState(space.categoryId ?? '');
  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = space.status === 'active';
  const visible = space.access.canChangeStatus || space.access.canDelete;

  // **서버의 값이 바뀌었을 때만** 칸을 맞춘다 — 부모는 Crew를 바꿀 때도 스페이스를 다시 읽는데, 그때마다 맞추면 치던 이름·설명이 지워졌다(병합 전 검토)
  useEffect(() => {
    setName(space.name);
    setDescription(space.description);
    setCategoryId(space.categoryId ?? '');
  }, [space.id, space.name, space.description, space.categoryId]);
  useEffect(() => {
    // 관리 칸이 보일 때만 읽는다. 분류를 못 읽어도 나머지 관리는 된다 — 화면 오류로 올리지 않는다
    if (!visible) return;
    api<CategoryView[]>('/api/categories')
      .then(setCategories)
      .catch(() => setCategories([]));
  }, [visible]);

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
      {space.access.canChangeStatus && (
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
            <button type="submit" disabled={!active}>
              저장
            </button>
            {!active && <p className="muted small">중지된 스페이스는 이름·설명·분류를 바꿀 수 없다. 먼저 다시 쓸 수 있게 한다.</p>}
          </form>
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
        </>
      )}
      {space.access.canDelete ? (
        <p>
          <button type="button" onClick={() => void remove()}>
            지우기
          </button>
        </p>
      ) : (
        <p className="muted small">지우기는 활성 스페이스에서 Crew가 본인뿐인 주인, 또는 중지된 스페이스에서 관리자가 할 수 있다.</p>
      )}
    </section>
  );
}
