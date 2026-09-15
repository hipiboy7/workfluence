import type { SpaceView } from '@workfluence/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';

export function HomePage() {
  const [spaces, setSpaces] = useState<SpaceView[] | null>(null);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => api<SpaceView[]>('/api/spaces').then(setSpaces).catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api<SpaceView>('/api/spaces', { method: 'POST', json: { key: key.toUpperCase(), name } });
      setKey('');
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '생성 실패');
    }
  };

  return (
    <div className="two-col">
      <section>
        <h1>스페이스</h1>
        {!spaces && !error && <p className="muted">불러오는 중…</p>}
        {spaces && spaces.length === 0 && <p className="muted">스페이스가 없다. 오른쪽에서 만들자.</p>}
        <ul className="cards">
          {spaces?.map((s) => (
            <li key={s.id} className="card">
              <Link to={`/spaces/${s.id}`}>
                <span className="key">{s.key}</span> {s.name}
              </Link>
              {s.description && <p className="muted">{s.description}</p>}
            </li>
          ))}
        </ul>
      </section>
      <aside>
        <form className="card" onSubmit={create}>
          <h2>새 스페이스</h2>
          <label>
            키 (대문자 영숫자 2~10자)
            <input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} pattern="[A-Z][A-Z0-9]{1,9}" required />
          </label>
          <label>
            이름
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit">만들기</button>
        </form>
      </aside>
    </div>
  );
}
