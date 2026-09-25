import {
  LLM_LIMITS,
  LLM_TIMINGS,
  type LlmConversationList,
  type LlmConversationSummary,
  type LlmConversationView,
  type LlmPromptView,
  type LlmProviderView,
  type LlmStreamEvent,
} from '@workfluence/shared';
import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { writeClipboard } from '../components/clipboard';
import { askLlm, batchLlmEvents, chatReducer, daysLeft, initialChat, statusLabel, waitLabel } from '../components/llmStream';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type EndEvent = Extract<LlmStreamEvent, { type: 'end' }>;

/** 받고 있는 답 하나 — 어느 대화에서 시작했고 무엇으로 끊나 */
type RunningAsk = { controller: AbortController; conversationId: string | null };

/**
 * **첫 답을 기다린 초** (P12 FR-1300·1301). 이 줄만 1초마다 다시 그린다 — 화면 전체(대화 목록·메시지)를 다시 그리지 않게(P12 코드 리뷰 9).
 * 초는 읽어 주지 않는다(`aria-hidden`) — 답 자리는 읽어 주는 곳이라 1초마다 읽는다. 늦어진다는 알림은 한 번 읽힌다. 서버를 부르지 않는다(NFR-121)
 */
function WaitLabel({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  const w = waitLabel(since, now);
  return (
    <p className="llm-waiting">
      <span aria-hidden="true">답변을 기다리고 있습니다 · {w.seconds}s</span>
      {w.slow && (
        <>
          <br />
          <strong>답변이 늦어지고 있습니다.</strong>
        </>
      )}
    </p>
  );
}

/**
 * LLM 질문 (P10_설계서_Llm G절, FR-1110~1139).
 *
 * 왼쪽은 내 대화(고정·최근)와 지켜야 할 상한, 오른쪽은 대화와 흘러나오는 답이다. 흐름을 읽고 상태를 바꾸는 규칙은
 * `components/llmStream.ts`에 있고(브라우저 없이 시험한다), 여기는 그리기와 서버 부르기다.
 *
 * **답을 받는 동안 다른 대화로 옮기지 못한다** — 흘러나오는 답은 시작한 대화의 것이다. 멈추고 옮긴다. 그래도 **페이지를 떠나거나
 * 뒤로 가기·주소로 다른 대화를 열면 받던 답을 멈춘다**(요청을 끊는다 — 서버는 창을 닫은 것처럼 받은 데까지 저장한다, FR-1122).
 * 떠난 흐름의 결과로 화면을 옮기지 않는다 (검토 반영 — 코드 리뷰 1·자체 점검 6).
 */
export function LlmPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [list, setList] = useState<LlmConversationList | null>(null);
  const [providers, setProviders] = useState<LlmProviderView[] | null>(null);
  const [prompts, setPrompts] = useState<LlmPromptView[]>([]);
  const [conversation, setConversation] = useState<LlmConversationView | null>(null);
  const [providerId, setProviderId] = useState('');
  const [promptId, setPromptId] = useState('');
  const [question, setQuestion] = useState('');
  const [pageError, setPageError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [chat, dispatch] = useReducer(chatReducer, initialChat);
  const running = useRef<RunningAsk | null>(null);
  const busy = chat.phase !== 'idle';

  // 페이지를 떠나면 받던 답을 멈춘다
  useEffect(
    () => () => {
      running.current?.controller.abort();
      running.current = null;
    },
    [],
  );

  const loadList = useCallback(
    () =>
      api<LlmConversationList>('/api/llm/conversations')
        .then(setList)
        .catch((e: unknown) => setPageError(errText(e))),
    [],
  );

  const loadConversation = useCallback(async (cid: string) => {
    const c = await api<LlmConversationView>(`/api/llm/conversations/${encodeURIComponent(cid)}`);
    setConversation(c);
    // 저장된 대화를 다시 읽었다 — 흘러나오던 것을 내린다
    dispatch({ type: 'settled' });
  }, []);

  useEffect(() => {
    void loadList();
    api<LlmProviderView[]>('/api/llm/providers')
      .then(setProviders)
      .catch((e: unknown) => setPageError(errText(e)));
    api<LlmPromptView[]>('/api/llm/prompts')
      .then(setPrompts)
      .catch(() => undefined);
  }, [loadList]);

  // 주소가 바뀌면 그 대화를 연다. **받는 중에 다른 대화로 옮겼으면**(뒤로 가기·주소 입력) 받던 답을 멈춘다
  useEffect(() => {
    const r = running.current;
    if (r && r.conversationId !== (id ?? null)) {
      r.controller.abort();
      running.current = null;
      dispatch({ type: 'reset' });
    }
    if (!id) {
      setConversation(null);
      return;
    }
    let cancelled = false;
    // 주소의 id는 **풀어서** 온다(`%2F` → `/`) — 경로로 넣을 때 다시 싼다 (보안 검토 — `api()`도 `.`·`..` 조각을 막는다)
    api<LlmConversationView>(`/api/llm/conversations/${encodeURIComponent(id)}`)
      .then((c) => {
        if (cancelled) return;
        setConversation(c);
        dispatch({ type: 'settled' });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setConversation(null);
        setPageError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // LLM을 고른다 — 이어 묻는 대화는 그 대화의 LLM(아직 있으면), 아니면 지금 고른 것, 그것도 없으면 첫째
  useEffect(() => {
    if (!providers?.length) return;
    const fromConversation = conversation?.providerId && providers.some((p) => p.id === conversation.providerId) ? conversation.providerId : null;
    setProviderId((cur) => fromConversation ?? (providers.some((p) => p.id === cur) ? cur : providers[0].id));
  }, [providers, conversation]);

  // 저장되지 않은 질문은 입력칸에 되돌린다 (D.5) — 비어 있을 때만. 그 사이 새로 친 것을 덮지 않는다
  useEffect(() => {
    if (chat.restore) setQuestion((cur) => cur || (chat.restore as string));
  }, [chat.restore]);

  const send = async () => {
    const q = question.trim();
    if (!q || busy || !providerId) return;
    setQuestion('');
    setPageError(null);
    setCopied(null);
    dispatch({ type: 'send', question: q, at: Date.now() });
    const me: RunningAsk = { controller: new AbortController(), conversationId: conversation?.id ?? null };
    running.current = me;
    // 떠났거나 다른 대화로 옮겼으면(`running`이 비었다) 이 흐름은 화면을 바꾸지 않는다
    const mine = () => running.current === me;
    const batch = batchLlmEvents((e) => {
      if (mine()) dispatch({ type: 'event', event: e });
    }, LLM_TIMINGS.renderBatchMs);
    // 콜백 안에서 받은 끝 줄 — 흐름이 끝난 뒤에 읽는다
    const box: { end: EndEvent | null } = { end: null };
    try {
      await askLlm(
        { providerId, question: q, ...(conversation ? { conversationId: conversation.id } : promptId ? { promptId } : {}) },
        (e) => {
          if (e.type === 'end') box.end = e;
          batch.push(e);
        },
        {
          signal: me.controller.signal,
          onOpen: () => {
            if (mine()) dispatch({ type: 'opened' });
          },
        },
      );
      batch.flush();
    } catch (e) {
      batch.cancel();
      if (mine()) dispatch({ type: 'failed', message: errText(e) });
      return;
    } finally {
      if (mine()) running.current = null;
    }
    if (me.controller.signal.aborted) return;
    void loadList();
    const end = box.end;
    if (!end?.saved || !end.conversationId) return;
    if (end.conversationId !== conversation?.id) nav(`/llm/${end.conversationId}`);
    else await loadConversation(end.conversationId).catch((e: unknown) => setPageError(errText(e)));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };

  // Ctrl+Enter(맥은 ⌘+Enter)로 보낸다 — Enter만으로는 줄을 바꾼다(긴 질문을 붙여 넣는다)
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  const stop = () => {
    dispatch({ type: 'stop' });
    // 흐름은 끊지 않는다 — 서버가 저장한 결과를 끝 줄로 받는다 (D.1). 멈출 것이 없었다고 하거나(끝나 가던 중) 닿지 않았으면 다시 누를 수 있게
    api<{ stopped: boolean }>('/api/llm/stop', { method: 'POST' })
      .then((r) => {
        if (!r.stopped) dispatch({ type: 'stop-missed' });
      })
      .catch(() => dispatch({ type: 'stop-missed' }));
  };

  const startNew = () => {
    dispatch({ type: 'reset' });
    setPromptId('');
    setPageError(null);
    nav('/llm');
  };

  const togglePin = async (c: LlmConversationSummary) => {
    setPageError(null);
    try {
      await api(`/api/llm/conversations/${encodeURIComponent(c.id)}/pin`, { method: c.pinned ? 'DELETE' : 'PUT' });
      await loadList();
      if (conversation?.id === c.id) await loadConversation(c.id);
    } catch (e) {
      setPageError(errText(e));
    }
  };

  const remove = async (c: LlmConversationSummary) => {
    if (!window.confirm(`"${c.title}" 대화를 지운다. 되살릴 수 없다.`)) return;
    setPageError(null);
    try {
      await api(`/api/llm/conversations/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      await loadList();
      if (conversation?.id === c.id) startNew();
    } catch (e) {
      setPageError(errText(e));
    }
  };

  const copyAnswer = async (text: string) => {
    try {
      await writeClipboard(text);
      setCopied('답을 복사했다');
    } catch {
      setPageError('복사하지 못했다 — 브라우저가 클립보드를 막았다');
    }
  };

  const items = list?.items ?? [];
  const pinned = items.filter((i) => i.pinned);
  const recent = items.filter((i) => !i.pinned);
  const limits = list?.limits;
  const pinFull = !!limits && pinned.length >= limits.pinnedMax;
  const provider = providers?.find((p) => p.id === providerId);

  const item = (c: LlmConversationSummary) => (
    <li key={c.id} className={c.id === conversation?.id ? 'current' : undefined}>
      {busy ? <span>{c.title}</span> : <Link to={`/llm/${c.id}`}>{c.title}</Link>}
      <span className="muted small">
        {' '}
        {c.pinned ? '고정' : c.expiresAt ? (daysLeft(c.expiresAt) > 0 ? `${daysLeft(c.expiresAt)}일 뒤 지워짐` : '오늘 지워짐') : ''}
      </span>{' '}
      <button
        type="button"
        className="linklike small"
        aria-label={`${c.title} ${c.pinned ? '고정 풀기' : '고정'}`}
        disabled={busy || (!c.pinned && pinFull)}
        title={!c.pinned && pinFull ? `고정은 ${limits?.pinnedMax}개까지다 — 하나를 풀고 고정한다` : undefined}
        onClick={() => void togglePin(c)}
      >
        {c.pinned ? '풀기' : '고정'}
      </button>{' '}
      <button type="button" className="linklike small" aria-label={`${c.title} 지우기`} disabled={busy} onClick={() => void remove(c)}>
        지우기
      </button>
    </li>
  );

  return (
    <main className="shell wide">
      <p className="muted small">
        <Link to="/">← 홈</Link> · <Link to="/llm/prompts">내 지시문</Link>
      </p>
      <h1>LLM 질문</h1>
      {pageError && (
        <p className="badge fail" role="alert">
          {pageError}
        </p>
      )}
      {providers && providers.length === 0 && <p className="card">등록된 LLM이 없다 — 시스템 관리자에게 등록을 요청한다.</p>}

      <div className="llm-layout">
        <aside className="card llm-list" aria-label="대화 목록">
          <button type="button" onClick={startNew} disabled={busy}>
            새 대화
          </button>
          {limits && (
            <p className="muted small">
              고정 {pinned.length}/{limits.pinnedMax} · 보관 {items.length}/{limits.conversationMax} · 고정하지 않은 대화는 마지막 사용 뒤{' '}
              {limits.retentionDays}일이 지나면 지워진다
            </p>
          )}
          <h2>고정</h2>
          <ul>{pinned.length ? pinned.map(item) : <li className="muted small">없다</li>}</ul>
          <h2>최근</h2>
          <ul>{recent.length ? recent.map(item) : <li className="muted small">없다</li>}</ul>
        </aside>

        <section className="card llm-chat" aria-label="대화">
          <h2>{conversation ? conversation.title : '새 대화'}</h2>
          {conversation && (
            <p className="muted small">
              지시문: {conversation.promptName ?? '(없음)'}
              {conversation.pinned ? ' · 고정' : ''}
            </p>
          )}

          <ol className="llm-messages" aria-label="메시지">
            {conversation?.messages.map((m) => {
              const label = statusLabel(m.status);
              return (
                <li key={m.id} className={`llm-msg llm-${m.role}`}>
                  <p className="muted small">
                    {m.role === 'user' ? '나' : (m.model ?? 'LLM')}
                    {label && <span className="badge fail"> {label}</span>}
                  </p>
                  <div className="llm-text">{m.content}</div>
                  {m.role === 'assistant' && (
                    <button type="button" className="linklike small" onClick={() => void copyAnswer(m.content)}>
                      답 복사
                    </button>
                  )}
                </li>
              );
            })}
            {chat.live && (
              <>
                <li className="llm-msg llm-user">
                  <p className="muted small">나</p>
                  <div className="llm-text">{chat.live.question}</div>
                </li>
                <li className="llm-msg llm-assistant" aria-live="polite" aria-label="흘러나오는 답">
                  <p className="muted small">
                    {provider?.model ?? 'LLM'}
                    {busy && ` — ${chat.phase === 'stopping' ? '멈추는 중…' : chat.phase === 'sending' ? '보내는 중…' : '답을 받는 중…'}`}
                  </p>
                  {/* 멈추는 중이면 보이지 않는다 — 사람이 멈추라고 했는데 "늦어지고 있다"고 말하지 않는다 (P12 코드 리뷰 10) */}
                  {chat.waitingSince !== null && chat.phase !== 'stopping' && <WaitLabel since={chat.waitingSince} />}
                  {chat.live.thinking && (
                    <details className="llm-thinking" open={!chat.live.answer}>
                      <summary>생각 과정 (저장하지 않는다)</summary>
                      <div className="llm-text">{chat.live.thinking.trim()}</div>
                    </details>
                  )}
                  <div className="llm-text">{chat.live.answer.replace(/^\s+/, '')}</div>
                </li>
              </>
            )}
          </ol>

          {/* 중지는 보내기와 **다른 자리의 다른 단추**다 — 보내기를 두 번 누른 둘째 번이 중지에 닿지 않게. 흐름이 열려야(서버가 자리를 잡아야) 누른다 */}
          {busy && (
            <p>
              <button type="button" onClick={stop} disabled={chat.phase !== 'streaming'}>
                {chat.phase === 'stopping' ? '멈추는 중…' : '중지'}
              </button>{' '}
              <span className="muted small">페이지를 떠나도 멈춘다 — 받은 데까지 저장한다</span>
            </p>
          )}

          {chat.error && (
            <p className="badge fail" role="alert">
              {chat.error}
            </p>
          )}
          {chat.notice && (
            <p className="badge" role="status">
              {chat.notice}
            </p>
          )}
          {copied && (
            <p className="muted small" role="status">
              {copied}
            </p>
          )}

          <form onSubmit={submit}>
            {!conversation && (
              <p>
                <label htmlFor="llm-prompt">지시문</label>{' '}
                <select id="llm-prompt" value={promptId} onChange={(e) => setPromptId(e.target.value)} disabled={busy}>
                  <option value="">(없음)</option>
                  {prompts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>{' '}
                <span className="muted small">새 대화를 시작할 때 고른다</span>
              </p>
            )}
            {providers && providers.length > 0 && (
              <p>
                <label htmlFor="llm-provider">LLM</label>{' '}
                <select id="llm-provider" value={providerId} onChange={(e) => setProviderId(e.target.value)} disabled={busy}>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.model}
                    </option>
                  ))}
                </select>
              </p>
            )}
            <label htmlFor="llm-question">질문</label>
            <textarea
              id="llm-question"
              rows={5}
              value={question}
              maxLength={LLM_LIMITS.questionMaxChars}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={onKey}
              placeholder="위키 페이지의 '텍스트 복사'·'마크다운 복사'로 가져온 내용을 붙여 넣어도 된다. Ctrl+Enter로 보낸다"
            />
            <p>
              <button type="submit" disabled={busy || !providerId || !question.trim()}>
                보내기
              </button>
            </p>
          </form>
        </section>
      </div>
    </main>
  );
}
