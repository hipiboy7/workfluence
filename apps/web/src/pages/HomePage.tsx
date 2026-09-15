import type { CategoryView, SpaceKind, SpaceView } from '@workfluence/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { SpaceBadges } from '../components/SpaceBadges';

const NEW_CATEGORY = '__new__';

/** 스페이스 목록: 기본 '개인', 버튼으로 '팀'과 전환 (prototype-v2). 새 스페이스는 분류(카테고리) 드롭다운 + 스페이스 명 */
export function HomePage() {
  const [scope, setScope] = useState<SpaceKind>('personal');
  const [spaces, setSpaces] = useState<SpaceView[] | null>(null);
  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<SpaceKind>('personal');
  const [categoryId, setCategoryId] = useState<string>('');
  const [newCategory, setNewCategory] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const loadSpaces = useCallback(
    () =>
      api<SpaceView[]>(`/api/spaces?scope=${scope}`)
        .then(setSpaces)
        .catch((e: Error) => setError(e.message)),
    [scope],
  );
  const loadCategories = useCallback(() => api<CategoryView[]>('/api/categories').then(setCategories).catch((e: Error) => setError(e.message)), []);

  useEffect(() => {
    setSpaces(null);
    void loadSpaces();
  }, [loadSpaces]);
  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);
  useEffect(() => setKind(scope), [scope]);

  const addCategory = async () => {
    setFormError(null);
    try {
      const c = await api<CategoryView>('/api/categories', { method: 'POST', json: { name: newCategory } });
      await loadCategories();
      setCategoryId(c.id);
      setNewCategory('');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '카테고리 생성 실패');
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (categoryId === NEW_CATEGORY) {
      setFormError('새 카테고리 이름을 입력하고 "추가"를 눌러 먼저 만든다');
      return;
    }
    try {
      const created = await api<SpaceView>('/api/spaces', {
        method: 'POST',
        json: { name, kind, categoryId: categoryId || null, description },
      });
      setName('');
      setDescription('');
      if (created.kind !== scope) setScope(created.kind);
      else await loadSpaces();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '생성 실패');
    }
  };

  return (
    <div className="two-col">
      <section>
        <div className="title-row">
          <h1>스페이스</h1>
          <span className="badge">{scope === 'personal' ? '개인' : '팀'}</span>
          <button type="button" className="toggle" onClick={() => setScope(scope === 'personal' ? 'team' : 'personal')}>
            {scope === 'personal' ? '팀 스페이스 보기' : '개인 스페이스 보기'}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {!spaces && !error && <p className="muted">불러오는 중…</p>}
        {spaces && spaces.length === 0 && (
          <p className="muted">{scope === 'personal' ? '개인 스페이스가 없다. 오른쪽에서 만들자.' : '참여 중인 팀 스페이스가 없다. 새로 만들거나 Crew로 초대받자.'}</p>
        )}
        <ul className="cards">
          {spaces?.map((s) => (
            <li key={s.id} className={`card ${s.status === 'suspended' ? 'suspended' : ''}`}>
              <Link to={`/spaces/${s.id}`} className="card-title">
                {s.name}
              </Link>
              <SpaceBadges space={s} />
              {s.description && <p className="muted small">{s.description}</p>}
            </li>
          ))}
        </ul>
      </section>
      <aside>
        <form className="card" onSubmit={create}>
          <h2>새 스페이스</h2>
          <fieldset className="radio-row">
            <legend>종류</legend>
            <label className="inline">
              <input type="radio" name="kind" checked={kind === 'personal'} onChange={() => setKind('personal')} /> 개인
            </label>
            <label className="inline">
              <input type="radio" name="kind" checked={kind === 'team'} onChange={() => setKind('team')} /> 팀
            </label>
          </fieldset>
          <label htmlFor="sp-category">분류</label>
          <select id="sp-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value={NEW_CATEGORY}>+ 새 카테고리 만들기</option>
            <option value="">(분류 없음)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {categoryId === NEW_CATEGORY && (
            <div className="inline-add">
              <input aria-label="새 카테고리 이름" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="카테고리 이름" />
              <button type="button" onClick={addCategory} disabled={!newCategory.trim()}>
                추가
              </button>
            </div>
          )}
          <label htmlFor="sp-name">스페이스 명</label>
          <input id="sp-name" value={name} onChange={(e) => setName(e.target.value)} required />
          <label htmlFor="sp-desc">설명 (선택)</label>
          <textarea id="sp-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          {formError && <p className="error">{formError}</p>}
          <button type="submit" className="primary">
            만들기
          </button>
        </form>
      </aside>
    </div>
  );
}
