import type { ChatRoomView } from '@workfluence/shared';
import { Link } from 'react-router';
import { PlusIcon } from './icons';
import { roomTitle } from './chatState';
import { Loading } from './ui';

/**
 * 채팅 문맥의 왼쪽 칸 (P21_설계서_Chat G절) — **새 대화** 단추와 내 방 목록(마지막 메시지가 새로운 방이 위). 화면이 `SideSlot` 안에 그린다.
 * 이름을 지킨다(시험이 찾는다): 단추 **새 대화**, `nav` **채팅 방 목록**, 줄은 방 이름 링크 + 안 읽은 수(`안 읽은 메시지 N개`)
 */
export function ChatSideNav({ rooms, failed, meId, currentId, onNew }: { rooms: ChatRoomView[] | null; failed: boolean; meId: string; currentId: string | null; onNew: () => void }) {
  return (
    <>
      <div className="side-group">
        <button type="button" className="w-full" onClick={onNew}>
          <PlusIcon /> 새 대화
        </button>
      </div>
      <nav className="side-group chat-list" aria-label="채팅 방 목록">
        <p className="side-label" aria-hidden="true">
          내 방
        </p>
        {rooms === null ? (
          failed ? (
            <p className="side-meta">방 목록을 불러오지 못했다</p>
          ) : (
            <Loading />
          )
        ) : rooms.length === 0 ? (
          <p className="side-meta">아직 방이 없다</p>
        ) : (
          <ul>
            {rooms.map((r) => {
              const current = r.id === currentId;
              return (
                <li key={r.id} className={current ? 'current' : undefined}>
                  <Link to={`/chat/${r.id}`} aria-current={current ? 'page' : undefined}>
                    <span className="title">{roomTitle(r, meId)}</span>
                    {r.lastMessage && <span className="chat-preview">{r.lastMessage.body}</span>}
                  </Link>
                  {r.unread > 0 && (
                    <span className="chat-unread" aria-label={`안 읽은 메시지 ${r.unread}개`}>
                      {r.unread > 99 ? '99+' : r.unread}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </>
  );
}
