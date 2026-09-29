import { LLM_LIMITS, type LlmConversationList, type LlmPromptView } from '@workfluence/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useConfirm } from '../components/ConfirmDialog';
import { LlmSideNav } from '../components/LlmSideNav';
import { EmptyState, FormActions, FormRow, FormRows, FormSection, Loading, Notice, Page, PageHeader } from '../components/ui';
import { SideSlot } from '../layout/AppLayout';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 지시 칸의 도움말 — 새로 쓸 때와 고칠 때가 같다 */
const CONTENT_HELP = (
  <>
    Qwen3 모델은 지시문에 <code>/no_think</code>를 적으면 생각 과정 없이 바로 답한다(모델에 따라 다르다).
  </>
);

/**
 * 내 지시문 — 시스템 프롬프트 (P10_설계서_Llm G절, FR-1125~1129 · P17 설계서 J.6 LLM 문맥).
 *
 * 이름을 붙여 여럿 저장하고 **새 대화를 시작할 때** 고른다. 고치거나 지울 때까지 남는다. 고친 것은 그 뒤에 시작하는 대화부터
 * 쓰인다 — 진행 중인 대화는 시작할 때 복사한 것으로 이어진다(FR-1127).
 *
 * - 왼쪽 칸은 LLM 문맥이다(`LlmSideNav`) — 새 대화(`/llm`으로 가는 링크)·내 지시문(지금 화면)·대화 목록. 목록은 **읽기만** 한다(고정·지우기는
 *   질문 화면에서). "← LLM 질문" 링크는 없앴다 — 위 막대와 왼쪽 칸에 있다(J.3.5)
 * - 새 지시문은 구획 폼(J.5.4), 지시문마다 카드(J.5.6). 지우면 되살릴 수 없어 한 번 더 묻는다(J.5.10)
 * - **구획에 이름(`aria-label`·`aria-labelledby`)을 "지시"·"이름"이 든 글로 붙이지 않는다** — E2E가 라벨의 일부로 칸을 찾는다
 *   (`getByLabel('지시')`·`getByLabel('이름')`). 이름 붙은 구획도 그 찾기에 걸린다
 */
export function LlmPromptsPage() {
  // 받기 전(null)과 빈 목록을 가른다 — 받기 전에 "아직 지시문이 없다"가 보이면 지운 것으로 읽힌다
  const [rows, setRows] = useState<LlmPromptView[] | null>(null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conversations, setConversations] = useState<LlmConversationList | null>(null);
  const [conversationsFailed, setConversationsFailed] = useState(false);
  const [confirm, dialog] = useConfirm();

  const load = useCallback(
    () =>
      api<LlmPromptView[]>('/api/llm/prompts')
        .then(setRows)
        .catch((e: unknown) => setError(errText(e))),
    [],
  );
  useEffect(() => {
    void load();
    // 왼쪽 칸의 대화 목록 — 질문 화면과 같은 API를 읽기만 한다. 읽지 못해도 이 화면의 일(지시문)은 된다 — 왼쪽 칸이 그렇게 말한다
    api<LlmConversationList>('/api/llm/conversations')
      .then(setConversations)
      .catch(() => setConversationsFailed(true));
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

  // 지운 지시문은 되살릴 수 없다 — 한 번 더 묻는다(P17 J.5.10). 확정 단추는 카드의 "지우기"와 겹치지 않는 낱말이다
  const remove = async (p: LlmPromptView) => {
    const ok = await confirm({
      title: '이 지시문을 지울까요?',
      body: `"${p.name}" 지시문을 지운다. 되살릴 수 없다. 이 지시문으로 시작한 대화는 그대로다.`,
      confirmLabel: '없앤다',
    });
    if (!ok) return;
    await act(() => api(`/api/llm/prompts/${p.id}`, { method: 'DELETE' }), `"${p.name}"을(를) 지웠다`);
  };

  return (
    <Page width="form">
      {dialog}
      <SideSlot>
        <LlmSideNav list={conversations} failed={conversationsFailed} here="prompts" />
      </SideSlot>
      <PageHeader
        title="내 지시문"
        description={
          <>
            LLM에 늘 먼저 주는 말이다(시스템 프롬프트). 새 대화를 시작할 때 고른다.{rows && ` ${rows.length}/${LLM_LIMITS.promptsPerUser}개.`}
          </>
        }
      />
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

      <form onSubmit={(e) => void create(e)}>
        <FormSection title="새 지시문" as="div">
          <FormRows>
            <FormRow id="prompt-name" label="이름" required>
              <input id="prompt-name" className="w-m" value={name} maxLength={LLM_LIMITS.nameMaxChars} onChange={(e) => setName(e.target.value)} />
            </FormRow>
            <FormRow id="prompt-content" label="지시" required top help={CONTENT_HELP}>
              <textarea id="prompt-content" className="w-full" rows={5} value={content} maxLength={LLM_LIMITS.promptMaxChars} onChange={(e) => setContent(e.target.value)} />
            </FormRow>
          </FormRows>
          <FormActions>
            <button type="submit" className="primary">
              저장
            </button>
          </FormActions>
        </FormSection>
      </form>

      {rows?.map((p) =>
        editing?.id === p.id ? (
          <form key={p.id} onSubmit={(e) => void save(e)} aria-label={`${p.name} 고치기`}>
            <FormSection title={`${p.name} 고치기`} as="div">
              <FormRows>
                <FormRow id={`edit-name-${p.id}`} label="이름" required>
                  <input
                    id={`edit-name-${p.id}`}
                    className="w-m"
                    value={editing.name}
                    maxLength={LLM_LIMITS.nameMaxChars}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  />
                </FormRow>
                <FormRow id={`edit-content-${p.id}`} label="지시" required top help={CONTENT_HELP}>
                  <textarea
                    id={`edit-content-${p.id}`}
                    className="w-full"
                    rows={5}
                    value={editing.content}
                    maxLength={LLM_LIMITS.promptMaxChars}
                    onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                  />
                </FormRow>
              </FormRows>
              <FormActions>
                <button type="submit" className="primary">
                  고친 것 저장
                </button>
                <button type="button" onClick={() => setEditing(null)}>
                  그만두기
                </button>
              </FormActions>
            </FormSection>
          </form>
        ) : (
          <section key={p.id} className="card" aria-label={p.name}>
            <div className="card-head">
              <h2>{p.name}</h2>
              {/* 카드마다 같은 단추가 있다 — 이름에 지시문 이름을 넣어 한 화면에 같은 이름이 둘 생기지 않게 한다 (J.8-1) */}
              <div className="actions">
                <button type="button" aria-label={`${p.name} 고치기`} onClick={() => setEditing({ id: p.id, name: p.name, content: p.content })}>
                  고치기
                </button>
                <button type="button" className="danger" aria-label={`${p.name} 지우기`} onClick={() => void remove(p)}>
                  지우기
                </button>
              </div>
            </div>
            <div className="llm-text">{p.content}</div>
          </section>
        ),
      )}
      {rows === null ? !error && <Loading /> : rows.length === 0 && <EmptyState title="아직 지시문이 없다." description="위의 새 지시문에 이름과 지시를 적고 저장한다." />}
    </Page>
  );
}
