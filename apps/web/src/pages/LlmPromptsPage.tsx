import { LLM_LIMITS, type LlmPromptView } from '@workfluence/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 내 지시문 — 시스템 프롬프트 (P10_설계서_Llm G절, FR-1125~1129).
 *
 * 이름을 붙여 여럿 저장하고 **새 대화를 시작할 때** 고른다. 고치거나 지울 때까지 남는다. 고친 것은 그 뒤에 시작하는 대화부터
 * 쓰인다 — 진행 중인 대화는 시작할 때 복사한 것으로 이어진다(FR-1127).
 */
export function LlmPromptsPage() {
  const [rows, setRows] = useState<LlmPromptView[]>([]);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<LlmPromptView[]>('/api/llm/prompts')
        .then(setRows)
        .catch((e: unknown) => setError(errText(e))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await load();
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await act(() => api('/api/llm/prompts', { method: 'POST', json: { name, content } }), `"${name.trim()}"을(를) 저장했다`)) {
      setName('');
      setContent('');
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const { id, ...patch } = editing;
    if (await act(() => api(`/api/llm/prompts/${id}`, { method: 'PATCH', json: patch }), '고쳤다 — 이제부터 시작하는 대화에 쓰인다')) setEditing(null);
  };

  const remove = async (p: LlmPromptView) => {
    if (!window.confirm(`"${p.name}" 지시문을 지운다. 이 지시문으로 시작한 대화는 그대로다.`)) return;
    await act(() => api(`/api/llm/prompts/${p.id}`, { method: 'DELETE' }), `"${p.name}"을(를) 지웠다`);
  };

  return (
    <main className="shell">
      <p className="muted small">
        <Link to="/llm">← LLM 질문</Link>
      </p>
      <h1>내 지시문</h1>
      <p className="muted small">
        LLM에 늘 먼저 주는 말이다(시스템 프롬프트). 새 대화를 시작할 때 고른다. {rows.length}/{LLM_LIMITS.promptsPerUser}개. Qwen3 모델은 지시문에{' '}
        <code>/no_think</code>를 적으면 생각 과정 없이 바로 답한다(모델에 따라 다르다).
      </p>
      {error && (
        <p className="badge fail" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="badge" role="status">
          {notice}
        </p>
      )}

      <form className="card" onSubmit={(e) => void create(e)}>
        <h2>새 지시문</h2>
        <label htmlFor="prompt-name">이름</label>
        <input id="prompt-name" value={name} maxLength={LLM_LIMITS.nameMaxChars} onChange={(e) => setName(e.target.value)} required />
        <label htmlFor="prompt-content">지시</label>
        <textarea id="prompt-content" rows={5} value={content} maxLength={LLM_LIMITS.promptMaxChars} onChange={(e) => setContent(e.target.value)} required />
        <button type="submit">저장</button>
      </form>

      {rows.map((p) =>
        editing?.id === p.id ? (
          <form key={p.id} className="card" onSubmit={(e) => void save(e)} aria-label={`${p.name} 고치기`}>
            <label htmlFor={`edit-name-${p.id}`}>이름</label>
            <input
              id={`edit-name-${p.id}`}
              value={editing.name}
              maxLength={LLM_LIMITS.nameMaxChars}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              required
            />
            <label htmlFor={`edit-content-${p.id}`}>지시</label>
            <textarea
              id={`edit-content-${p.id}`}
              rows={5}
              value={editing.content}
              maxLength={LLM_LIMITS.promptMaxChars}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              required
            />
            <button type="submit">고친 것 저장</button>{' '}
            <button type="button" onClick={() => setEditing(null)}>
              그만두기
            </button>
          </form>
        ) : (
          <section key={p.id} className="card" aria-label={p.name}>
            <h2>{p.name}</h2>
            <div className="llm-text">{p.content}</div>
            <p>
              <button type="button" onClick={() => setEditing({ id: p.id, name: p.name, content: p.content })}>
                고치기
              </button>{' '}
              <button type="button" onClick={() => void remove(p)}>
                지우기
              </button>
            </p>
          </section>
        ),
      )}
      {rows.length === 0 && <p className="muted">아직 지시문이 없다.</p>}
    </main>
  );
}
