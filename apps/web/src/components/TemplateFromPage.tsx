import { useEffect, useState } from 'react';
import type { PageTemplateView, PageView } from '@workfluence/shared';
import { api } from '../api';

/**
 * 이 문서를 템플릿으로 (P6_설계서_Collab FR-740·743·745).
 *
 * **별도 관리 화면을 두지 않는다.** 템플릿이 되는 것은 언제나 "잘 쓴 문서 하나"이고,
 * 그 판단은 그것을 보고 있을 때 내린다. 목록과 지우기도 여기 함께 둔다 — 관리자가
 * 템플릿을 생각하는 자리가 한 곳이면 된다.
 */
export function TemplateFromPage({ page }: { page: PageView }) {
  const [list, setList] = useState<PageTemplateView[]>([]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    api<PageTemplateView[]>('/api/templates')
      .then(setList)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  const save = (e: React.FormEvent): void => {
    e.preventDefault();
    setMsg(null);
    setError(null);
    void api<PageTemplateView>('/api/templates', {
      method: 'POST',
      json: { name, description: desc || null, content: page.content },
    })
      .then((t) => {
        // **같은 이름이면 있던 것을 돌려준다** (멱등). 덮어쓰지 않으므로 그것을 말해 준다 —
        // 안 그러면 "저장했는데 내용이 안 바뀌었다"가 된다
        const same = list.some((x) => x.id === t.id);
        setMsg(same ? `"${t.name}"은 이미 있다. 내용을 바꾸려면 지우고 다시 만든다.` : `"${t.name}" 템플릿을 만들었다.`);
        setName('');
        setDesc('');
        load();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <section className="card" aria-label="템플릿">
      <h2>템플릿</h2>
      {error && <p className="badge fail" role="alert">{error}</p>}
      {msg && <p className="badge" role="status">{msg}</p>}
      <form onSubmit={save}>
        <label htmlFor="tpl-name">이 문서를 템플릿으로 저장 — 이름</label>
        <input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        <label htmlFor="tpl-desc">설명 (없어도 된다)</label>
        <input id="tpl-desc" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} />
        <button type="submit">템플릿으로 저장</button>
      </form>
      {list.length > 0 && (
        <ul>
          {list.map((t) => (
            <li key={t.id}>
              {t.name}
              {t.description && <span className="muted small"> — {t.description}</span>}{' '}
              <button
                type="button"
                className="linklike"
                onClick={() =>
                  void api(`/api/templates/${t.id}`, { method: 'DELETE' })
                    .then(load)
                    .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                }
              >
                지우기
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">템플릿을 지워도 그것으로 만든 문서는 그대로다 — 만들 때 내용을 복사하고 끝이다.</p>
    </section>
  );
}
