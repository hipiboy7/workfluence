import type { ChatRoomView, ChatUserView } from '@workfluence/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Notice } from './ui';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 여럿 방에 사람을 더한다 (P21_설계서_Chat FR-2402) — 여럿 방의 참여자 누구에게나 보인다(서버가 다시 판정한다). 이미 든 사람은 목록에서 뺀다.
 * 사람은 표시 이름으로 찾는다(`ChatNewRoom`과 같은 길)
 */
export function ChatInvite({ room, onInvited, onCancel }: { room: ChatRoomView; onInvited: (room: ChatRoomView) => void; onCancel: () => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<ChatUserView[] | null>(null);
  const [picked, setPicked] = useState<ChatUserView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 이미 든 사람 — 효과가 의존하는 것은 이 열쇠 하나다(초대 직후 목록에서도 빠져야 한다)
  const inRoomKey = room.members.map((m) => m.userId).join(',');

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api<{ items: ChatUserView[] }>(`/api/chat/users?q=${encodeURIComponent(q)}`)
        .then((r) => live && setFound(r.items.filter((u) => !inRoomKey.split(',').includes(u.id))))
        .catch((e: unknown) => live && setError(errText(e)));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, inRoomKey]);

  const toggle = (u: ChatUserView) => setPicked((cur) => (cur.some((p) => p.id === u.id) ? cur.filter((p) => p.id !== u.id) : [...cur, u]));

  const invite = () => {
    if (busy || picked.length === 0) return;
    setBusy(true);
    setError(null);
    api<ChatRoomView>(`/api/chat/rooms/${room.id}/members`, { method: 'POST', json: { userIds: picked.map((p) => p.id) } })
      .then(onInvited)
      .catch((e: unknown) => {
        setError(errText(e));
        setBusy(false);
      });
  };

  return (
    <section className="chat-new" aria-label="사람 초대">
      <h2>사람 초대</h2>
      {error && <Notice kind="error">{error}</Notice>}
      <label className="chat-field">
        <span>사람 찾기</span>
        <input type="search" value={q} placeholder="이름의 일부" onChange={(e) => setQ(e.target.value)} />
      </label>
      <ul className="chat-found">
        {(found ?? []).map((u) => (
          <li key={u.id}>
            <label>
              <input type="checkbox" checked={picked.some((p) => p.id === u.id)} onChange={() => toggle(u)} /> {u.displayName}
            </label>
          </li>
        ))}
        {found?.length === 0 && <li className="muted">초대할 사람이 없다</li>}
      </ul>
      <div className="chat-actions">
        <button type="button" disabled={busy || picked.length === 0} onClick={invite}>
          초대
        </button>
        <button type="button" className="subtle" onClick={onCancel}>
          닫기
        </button>
      </div>
    </section>
  );
}
