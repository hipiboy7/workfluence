import { LLM_LIMITS, normalizeLlmBaseUrl, type LlmCheckView, type LlmProviderAdminView } from '@workfluence/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../../api';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const EMPTY = { name: '', baseUrl: '', model: '', apiKey: '' };
/** 암호화하지 않는 주소 — 질문·답(과 키)이 사내망을 평문으로 지난다 (보안 검토) */
const isPlainHttp = (url: string) => /^\s*http:\/\//i.test(url);

/**
 * LLM 연결 — 시스템 관리자(root)가 사내 LLM을 등록·삭제한다 (P10_설계서_Llm G절, FR-1100~1108).
 *
 * **API 키는 다시 보이지 않는다** — 목록은 "있음/없음"만(FR-1102). 등록하면 입력칸의 키를 곧바로 비운다. 주소 판정은 서버와
 * **같은 함수**(`normalizeLlmBaseUrl`)를 먼저 돌린다 — 왕복하지 않고 바로 말해 준다. 등록하면 곧바로 연결을 확인한다(FR-1105).
 * **http 주소는 막지 않고 알린다** — 사내 LLM이 https를 받지 않을 수 있다. 그 대신 무엇이 평문으로 가는지 말한다 (보안 검토).
 */
export function AdminLlmPage() {
  const [rows, setRows] = useState<LlmProviderAdminView[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [checks, setChecks] = useState<Record<string, LlmCheckView | 'checking'>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<LlmProviderAdminView[]>('/api/llm/admin/providers')
        .then(setRows)
        .catch((e: unknown) => setError(errText(e))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const check = async (id: string) => {
    setChecks((c) => ({ ...c, [id]: 'checking' }));
    try {
      const r = await api<LlmCheckView>(`/api/llm/admin/providers/${id}/check`, { method: 'POST' });
      setChecks((c) => ({ ...c, [id]: r }));
    } catch (e) {
      setChecks((c) => ({ ...c, [id]: { ok: false, message: errText(e) } }));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const url = normalizeLlmBaseUrl(form.baseUrl);
    if (!url.ok) {
      setError(url.reason);
      return;
    }
    try {
      const view = await api<LlmProviderAdminView>('/api/llm/admin/providers', {
        method: 'POST',
        json: { name: form.name, baseUrl: url.url, model: form.model, apiKey: form.apiKey || null },
      });
      // **키를 화면에 남기지 않는다**
      setForm(EMPTY);
      setNotice(`"${view.name}"을(를) 등록했다 — 연결을 확인한다`);
      await load();
      void check(view.id);
    } catch (err) {
      setError(errText(err));
    }
  };

  const remove = async (row: LlmProviderAdminView) => {
    if (!window.confirm(`"${row.name}"을(를) 지운다. 이 LLM으로 한 대화는 남고, 사람들은 다른 LLM으로 이어 묻는다.`)) return;
    setError(null);
    setNotice(null);
    try {
      await api(`/api/llm/admin/providers/${row.id}`, { method: 'DELETE' });
      setNotice(`"${row.name}"을(를) 지웠다`);
      await load();
    } catch (e) {
      setError(errText(e));
    }
  };

  const result = (id: string) => {
    const r = checks[id];
    if (!r) return null;
    if (r === 'checking') return <span className="muted small">연결 확인 중…</span>;
    if (!r.ok) return <span className="badge fail">연결 안 됨 — {r.message}</span>;
    return (
      <span>
        <span className="badge ok">연결됨</span>{' '}
        <span className="muted small">
          모델 {r.models.length}개{r.modelFound ? '' : ' — 등록한 모델이 목록에 없다. 모델 이름을 확인한다'}
          {r.models.length > 0 && `: ${r.models.slice(0, 10).join(', ')}${r.models.length > 10 ? ' …' : ''}`}
        </span>
      </span>
    );
  };

  return (
    <main className="shell wide">
      <p className="muted small">
        <Link to="/">← 홈</Link>
      </p>
      <h1>LLM 연결</h1>
      <p className="muted small">
        사내 LLM 서버(OpenAI 호환 — vLLM)를 등록하면 모든 사용자가 "LLM 질문" 메뉴에서 쓴다. 지우면 곧바로 못 쓴다. 등록·삭제는 감사로그에 남는다.
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

      <table className="card">
        <thead>
          <tr>
            <th>이름</th>
            <th>모델</th>
            <th>주소</th>
            <th>API 키</th>
            <th>등록한 사람</th>
            <th>조치</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.model}</td>
              <td>
                <code>{r.baseUrl}</code>
                {isPlainHttp(r.baseUrl) && <span className="muted small"> (암호화 안 됨)</span>}
              </td>
              <td>{r.hasKey ? '있음' : '없음'}</td>
              <td>{r.createdByName}</td>
              <td>
                <button type="button" onClick={() => void check(r.id)} aria-label={`${r.name} 연결 확인`}>
                  연결 확인
                </button>{' '}
                <button type="button" onClick={() => void remove(r)} aria-label={`${r.name} 삭제`}>
                  삭제
                </button>
                <div>{result(r.id)}</div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                등록된 LLM이 없다.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <form className="card" onSubmit={(e) => void submit(e)}>
        <h2>등록</h2>
        <label htmlFor="llm-name">이름</label>
        <input id="llm-name" value={form.name} maxLength={LLM_LIMITS.nameMaxChars} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <label htmlFor="llm-url">주소 (OpenAI 호환 API의 /v1까지)</label>
        <input
          id="llm-url"
          value={form.baseUrl}
          placeholder="http://llm.example.internal:8000/v1"
          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          required
        />
        <label htmlFor="llm-model">모델</label>
        <input
          id="llm-model"
          value={form.model}
          placeholder="Qwen/Qwen3-32B"
          maxLength={LLM_LIMITS.modelMaxChars}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
          required
        />
        <label htmlFor="llm-key">API 키 (없으면 비운다 — 저장하면 다시 볼 수 없다)</label>
        <input
          id="llm-key"
          type="password"
          autoComplete="new-password"
          value={form.apiKey}
          maxLength={LLM_LIMITS.apiKeyMaxChars}
          onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
        />
        {isPlainHttp(form.baseUrl) && (
          <p className="badge fail" role="note">
            http 주소다 — {form.apiKey ? '질문과 답, 그리고 API 키가' : '질문과 답이'} 암호화되지 않고 사내망을 지난다. LLM 서버가 https를 받으면 https 주소로 등록한다
          </p>
        )}
        <button type="submit">등록</button>
      </form>
    </main>
  );
}
