import { LLM_LIMITS, normalizeLlmBaseUrl, type LlmCheckView, type LlmProviderAdminView } from '@workfluence/shared';
import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { useConfirm } from '../../components/ConfirmDialog';
import { FormActions, FormRow, FormRows, FormSection, Notice, Page, PageHeader, StatusBadge } from '../../components/ui';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const EMPTY = { name: '', baseUrl: '', model: '', apiKey: '' };
/** 암호화하지 않는 주소 — 질문·답(과 키)이 사내망을 평문으로 지난다 (보안 검토) */
const isPlainHttp = (url: string) => /^\s*http:\/\//i.test(url);
const COLUMNS = 6;

/** 결과를 보일 구획 — 조치한 구획 바로 위(P17 J.5.7). 목록의 조치(삭제)와 읽기는 표 위, 등록은 등록 구획 안 */
type Area = 'list' | 'form';

/**
 * LLM 연결 — 시스템 관리자(root)와 root가 위임한 관리자가 사내 LLM을 등록·삭제한다 (P10_설계서_Llm G절, FR-1100~1108 ·
 * P11_설계서_Ops D.1).
 *
 * **API 키는 다시 보이지 않는다** — 목록은 "있음/없음"만(FR-1102). 등록하면 입력칸의 키를 곧바로 비운다. 주소 판정은 서버와
 * **같은 함수**(`normalizeLlmBaseUrl`)를 먼저 돌린다 — 왕복하지 않고 바로 말해 준다(틀리면 그 칸 아래의 오류다). 등록하면 곧바로 연결을
 * 확인한다(FR-1105). **http 주소는 막지 않고 알린다** — 사내 LLM이 https를 받지 않을 수 있다. 그 대신 무엇이 평문으로 가는지 말한다 (보안 검토).
 *
 * 모양 (P17 J.6 관리 다섯 — 사용자 요청 F-010 6번 "줄 구분이나 항목 구분"이 든 화면): 머리 → 등록된 연결 표(열 순서 그대로) → 연결 확인의
 * 결과는 그 줄 바로 아래 한 칸 전체의 펼친 줄 → 등록 구획 폼 4줄(라벨은 이름만 — 설명은 도움말). 펼친 줄에는 연결 이름을 되풀이하지
 * 않는다 — E2E가 줄 이름(연결 이름)으로 한 줄만 찾는다. 삭제는 확인 대화로 묻는다(J.5.10)
 */
export function AdminLlmPage() {
  const [rows, setRows] = useState<LlmProviderAdminView[]>([]);
  // 첫 목록이 오기 전·읽기에 실패했을 때 "등록된 LLM이 없다"로 읽히지 않게
  const [listState, setListState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [form, setForm] = useState(EMPTY);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, LlmCheckView | 'checking'>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [area, setArea] = useState<Area>('list');
  const [confirm, dialog] = useConfirm();

  const load = useCallback(
    () =>
      api<LlmProviderAdminView[]>('/api/llm/admin/providers')
        .then((r) => {
          setRows(r);
          setListState('ok');
        })
        .catch((e: unknown) => {
          setListState((s) => (s === 'ok' ? s : 'failed'));
          setArea('list');
          setError(errText(e));
        }),
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
    setArea('form');
    setError(null);
    setNotice(null);
    const url = normalizeLlmBaseUrl(form.baseUrl);
    if (!url.ok) {
      setUrlError(url.reason);
      return;
    }
    setUrlError(null);
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
    // 확정 단추는 부른 단추(삭제)의 이름을 품지 않는다 (J.5.10). 제목에 연결 이름을 넣지 않는다 — 이름은 본문에 있다
    const ok = await confirm({
      title: '이 연결을 지울까요?',
      body: `"${row.name}"을(를) 지운다. 이 LLM으로 한 대화는 남고, 사람들은 다른 LLM으로 이어 묻는다.`,
      confirmLabel: '지운다',
    });
    if (!ok) return;
    setArea('list');
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

  /** 연결 확인의 결과 — 그 줄 아래 펼친 줄의 글. 연결 이름은 넣지 않는다(바로 위 줄이 그 연결이다) */
  const result = (r: LlmCheckView | 'checking') => {
    if (r === 'checking') return <span className="muted">연결 확인 중…</span>;
    if (!r.ok)
      return (
        <>
          {/* 배지는 짧게, 까닭은 옆의 글이다(J.5.8). 줄의 글은 예전 그대로 "연결 안 됨 — 까닭"이다 — 설치및실행가이드의 확인 표가 그 글로 찾는다 */}
          <StatusBadge kind="bad">연결 안 됨</StatusBadge> <span>— {r.message}</span>
        </>
      );
    return (
      <>
        <StatusBadge kind="ok">연결됨</StatusBadge>{' '}
        <span className="muted">
          모델 {r.models.length}개{r.modelFound ? '' : ' — 등록한 모델이 목록에 없다. 모델 이름을 확인한다'}
          {r.models.length > 0 && `: ${r.models.slice(0, 10).join(', ')}${r.models.length > 10 ? ' …' : ''}`}
        </span>
      </>
    );
  };

  const notices = (where: Area) =>
    area === where && (
      <>
        {error && <Notice kind="error">{error}</Notice>}
        {notice && <Notice kind="success">{notice}</Notice>}
      </>
    );

  return (
    <Page>
      <PageHeader
        title="LLM 연결"
        description='사내 LLM 서버(OpenAI 호환 — vLLM)를 등록하면 모든 사용자가 "LLM 질문" 메뉴에서 쓴다. 지우면 곧바로 못 쓴다. 등록·삭제는 감사로그에 남는다.'
      />

      <h2>등록된 연결{listState === 'ok' ? ` ${rows.length}개` : ''}</h2>
      {notices('list')}
      {/* 넘칠 때만 가로로 민다 — 키보드로도 밀 수 있게 초점을 받는다(J.5.5) */}
      <div className="table-scroll" tabIndex={0}>
        <table>
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
              <Fragment key={r.id}>
                <tr>
                  <td>{r.name}</td>
                  <td>{r.model}</td>
                  <td>
                    <code className="break-any">{r.baseUrl}</code>
                    {isPlainHttp(r.baseUrl) && <span className="muted small"> (암호화 안 됨)</span>}
                  </td>
                  <td>{r.hasKey ? '있음' : '없음'}</td>
                  <td>{r.createdByName}</td>
                  <td className="actions-cell">
                    <div className="actions">
                      <button type="button" className="sm" onClick={() => void check(r.id)} aria-label={`${r.name} 연결 확인`}>
                        연결 확인
                      </button>
                      <button type="button" className="danger sm" onClick={() => void remove(r)} aria-label={`${r.name} 삭제`}>
                        삭제
                      </button>
                    </div>
                  </td>
                </tr>
                {checks[r.id] && (
                  <tr>
                    {/* 확인 중 → 결과로 바뀌는 것을 읽어 준다 */}
                    <td colSpan={COLUMNS} aria-live="polite">
                      {result(checks[r.id])}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={COLUMNS} className="empty">
                  {listState === 'loading' ? '불러오는 중…' : listState === 'failed' ? '목록을 불러오지 못했다.' : '등록된 LLM이 없다.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <FormSection title="등록" titleId="llm-new-title">
        {notices('form')}
        <form onSubmit={(e) => void submit(e)}>
          <FormRows>
            <FormRow id="llm-name" label="이름" required>
              <input id="llm-name" className="w-m" value={form.name} maxLength={LLM_LIMITS.nameMaxChars} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </FormRow>
            <FormRow id="llm-url" label="주소" required help="OpenAI 호환 API의 /v1까지" error={urlError}>
              <input
                id="llm-url"
                className="w-l"
                value={form.baseUrl}
                placeholder="http://llm.example.internal:8000/v1"
                onChange={(e) => {
                  setForm({ ...form, baseUrl: e.target.value });
                  setUrlError(null);
                }}
              />
            </FormRow>
            <FormRow id="llm-model" label="모델" required>
              <input
                id="llm-model"
                className="w-m"
                value={form.model}
                placeholder="Qwen/Qwen3-32B"
                maxLength={LLM_LIMITS.modelMaxChars}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
            </FormRow>
            {/* 눈 모양 단추를 두지 않는다 — 두면 "API 키"로 찾는 이름이 그 단추에도 걸린다 (J.5.3) */}
            <FormRow id="llm-key" label="API 키" help="없으면 비운다. 저장하면 다시 볼 수 없다">
              <input
                id="llm-key"
                type="password"
                className="w-m"
                autoComplete="new-password"
                value={form.apiKey}
                maxLength={LLM_LIMITS.apiKeyMaxChars}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
            </FormRow>
          </FormRows>
          {isPlainHttp(form.baseUrl) && (
            <Notice kind="warning" role="note">
              http 주소다 — {form.apiKey ? '질문과 답, 그리고 API 키가' : '질문과 답이'} 암호화되지 않고 사내망을 지난다. LLM 서버가 https를 받으면 https 주소로 등록한다
            </Notice>
          )}
          <FormActions>
            <button type="submit" className="primary">
              등록
            </button>
          </FormActions>
        </form>
      </FormSection>
      {dialog}
    </Page>
  );
}
