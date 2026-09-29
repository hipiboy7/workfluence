import type { LlmConversationList, LlmConversationSummary } from '@workfluence/shared';
import { Link } from 'react-router';
import { PlusIcon } from './icons';
import { daysLeft } from './llmStream';
import { Loading } from './ui';

/**
 * LLM 문맥의 왼쪽 칸 (P17 설계서 J.3.3·J.6 LLM 문맥) — **새 대화**, **내 지시문**, 대화 목록(고정한 것이 위). LLM 질문과 내 지시문이 같이 쓴다 —
 * 화면이 `SideSlot` 안에 그린다(상태는 화면에 남는다).
 *
 * - 질문 화면은 목록의 줄마다 고정·지우기 단추를 두고(`onPin`·`onRemove`), 새 대화는 **단추**다 — 받는 동안 누르지 못해야 한다(흘러나오는 답은
 *   시작한 대화의 것이다). 지시문 화면은 목록을 읽기만 하고 새 대화는 `/llm`으로 가는 링크다
 * - 제목(heading)을 두지 않는다 — 묶음 이름은 작은 회색 글이다(J.3.3). 본문의 h1·대화 제목과 겹치지 않게
 * - 이름을 지킨다(시험이 찾는다): 단추 **새 대화**, 링크 **내 지시문**, `aside` **대화 목록**, 줄 끝 단추 **"{제목} 고정"·"{제목} 고정 풀기"·"{제목} 지우기"**
 */
export function LlmSideNav({
  list,
  failed = false,
  here,
  currentId,
  busy = false,
  onNew,
  onPin,
  onRemove,
}: {
  /** 받기 전이면 null */
  list: LlmConversationList | null;
  /** 목록을 읽지 못했다 — 받기 전(null)과 가른다. "불러오는 중"이 끝없이 남지 않게 */
  failed?: boolean;
  here: 'chat' | 'prompts';
  currentId?: string | null;
  busy?: boolean;
  onNew?: () => void;
  onPin?: (c: LlmConversationSummary) => void;
  onRemove?: (c: LlmConversationSummary) => void;
}) {
  const items = list?.items ?? [];
  const pinned = items.filter((i) => i.pinned);
  const recent = items.filter((i) => !i.pinned);
  const limits = list?.limits;
  const pinFull = !!limits && pinned.length >= limits.pinnedMax;

  const item = (c: LlmConversationSummary) => {
    const current = c.id === currentId;
    // 고정한 대화는 지워지지 않는다 — 남은 날은 고정하지 않은 것에만 붙인다(묶음 이름이 이미 "고정"이다)
    const left = !c.pinned && c.expiresAt ? daysLeft(c.expiresAt) : null;
    // 긴 제목은 두 줄에서 자른다(`.title`) — 256px 칸에서 단추 둘 옆에 서너 줄로 감겼다
    const title = (
      <>
        <span className="title">{c.title}</span>
        {left !== null && <span className="llm-when">{left > 0 ? `${left}일 뒤 지워짐` : '오늘 지워짐'}</span>}
      </>
    );
    return (
      <li key={c.id} className={current ? 'current' : undefined}>
        {/* 받는 동안은 주소 없는 a(자리표시 — 링크가 아니라 누르거나 초점이 가지 않는다)로 그린다. 모양은 같게 두고 다른 대화로 옮기지 못하게 한다 */}
        {busy ? (
          <a>{title}</a>
        ) : (
          <Link to={`/llm/${c.id}`} aria-current={current ? 'page' : undefined}>
            {title}
          </Link>
        )}
        {onPin && (
          <button
            type="button"
            className="subtle sm"
            aria-label={`${c.title} ${c.pinned ? '고정 풀기' : '고정'}`}
            disabled={busy || (!c.pinned && pinFull)}
            title={!c.pinned && pinFull ? `고정은 ${limits?.pinnedMax}개까지다 — 하나를 풀고 고정한다` : undefined}
            onClick={() => onPin(c)}
          >
            {c.pinned ? '풀기' : '고정'}
          </button>
        )}
        {onRemove && (
          <button type="button" className="subtle danger sm" aria-label={`${c.title} 지우기`} disabled={busy} onClick={() => onRemove(c)}>
            지우기
          </button>
        )}
      </li>
    );
  };

  const group = (label: string, rows: LlmConversationSummary[]) => (
    <>
      <p className="side-label">{label}</p>
      {rows.length ? <ul>{rows.map(item)}</ul> : <p className="side-meta">없다</p>}
    </>
  );

  return (
    <>
      <nav className="side-group" aria-label="LLM 메뉴">
        <div className="side-group">
          {onNew ? (
            <button type="button" className="w-full" onClick={onNew} disabled={busy}>
              <PlusIcon /> 새 대화
            </button>
          ) : (
            <Link className="btn w-full" to="/llm">
              <PlusIcon /> 새 대화
            </Link>
          )}
        </div>
        <ul>
          <li>
            <Link className="side-item" to="/llm/prompts" aria-current={here === 'prompts' ? 'page' : undefined}>
              내 지시문
            </Link>
          </li>
        </ul>
      </nav>
      <aside className="llm-list" aria-label="대화 목록">
        {list === null ? (
          failed ? <p className="side-meta">대화 목록을 읽지 못했다.</p> : <Loading />
        ) : (
          <>
            {limits && (
              <p className="side-meta">
                고정 {pinned.length}/{limits.pinnedMax} · 보관 {items.length}/{limits.conversationMax} · 고정하지 않은 대화는 마지막 사용 뒤{' '}
                {limits.retentionDays}일이 지나면 지워진다
              </p>
            )}
            {group('고정', pinned)}
            {group('최근', recent)}
          </>
        )}
      </aside>
    </>
  );
}
