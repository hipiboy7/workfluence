import { CHAT_LIMITS, type ChatRoomView, type ChatUserView } from '@workfluence/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Notice } from './ui';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 새 대화 (P21_설계서_Chat G절) — **1:1**(사람 한 명을 고르면 바로 그 방)과 **여럿**(이름과 사람들). 사람은 표시 이름으로 찾는다(`GET /api/chat/users` —
 * 활성 사용자의 이름만 온다). 이미 있는 1:1 방은 새로 만들지 않고 그 방으로 간다(서버가 알려 준다)
 */
export function ChatNewRoom({ onCreated, onCancel }: { onCreated: (room: ChatRoomView) => void; onCancel: () => void }) {
  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<ChatUserView[] | null>(null);
  const [picked, setPicked] = useState<ChatUserView[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 찾는 말이 바뀌면 조금 기다렸다 묻는다 — 글자마다 요청하지 않게
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api<{ items: ChatUserView[] }>(`/api/chat/users?q=${encodeURIComponent(q)}`)
        .then((r) => live && setFound(r.items))
        .catch((e: unknown) => live && setError(errText(e)));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const create = (body: object) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api<ChatRoomView & { created: boolean }>('/api/chat/rooms', { method: 'POST', json: body })
      .then(onCreated)
      .catch((e: unknown) => {
        setError(errText(e));
        setBusy(false);
      });
  };

  const toggle = (u: ChatUserView) => setPicked((cur) => (cur.some((p) => p.id === u.id) ? cur.filter((p) => p.id !== u.id) : [...cur, u]));
  const canGroup = name.trim().length > 0 && picked.length > 0 && !busy;

  return (
    <section className="chat-new" aria-label="새 대화">
      <h2>새 대화</h2>
      {error && <Notice kind="error">{error}</Notice>}
      <div role="radiogroup" aria-label="방의 종류" className="chat-mode">
        <label>
          <input type="radio" name="chat-mode" checked={mode === 'direct'} onChange={() => setMode('direct')} /> 1:1
        </label>
        <label>
          <input type="radio" name="chat-mode" checked={mode === 'group'} onChange={() => setMode('group')} /> 여럿
        </label>
      </div>
      {mode === 'group' && (
        <label className="chat-field">
          <span>방 이름</span>
          <input type="text" value={name} maxLength={CHAT_LIMITS.maxRoomNameChars} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <label className="chat-field">
        <span>사람 찾기</span>
        <input type="search" value={q} placeholder="이름의 일부" onChange={(e) => setQ(e.target.value)} />
      </label>
      {mode === 'group' && picked.length > 0 && (
        <p className="chat-picked" aria-label="고른 사람">
          {picked.map((p) => p.displayName).join(', ')}
        </p>
      )}
      <ul className="chat-found">
        {(found ?? []).map((u) => (
          <li key={u.id}>
            {mode === 'direct' ? (
              <button type="button" className="subtle" disabled={busy} onClick={() => create({ kind: 'direct', userId: u.id })}>
                {u.displayName}
              </button>
            ) : (
              <label>
                <input type="checkbox" checked={picked.some((p) => p.id === u.id)} onChange={() => toggle(u)} /> {u.displayName}
              </label>
            )}
          </li>
        ))}
        {found?.length === 0 && <li className="muted">찾는 사람이 없다</li>}
      </ul>
      <div className="chat-actions">
        {mode === 'group' && (
          <button type="button" disabled={!canGroup} onClick={() => create({ kind: 'group', name: name.trim(), userIds: picked.map((p) => p.id) })}>
            방 만들기
          </button>
        )}
        <button type="button" className="subtle" onClick={onCancel}>
          닫기
        </button>
      </div>
    </section>
  );
}
