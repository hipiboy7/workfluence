import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { AuditEventView } from '@workfluence/shared';
import { AUDIT_ACTIONS } from '@workfluence/shared';
import { LIST_PAGE_LIMIT, REQUEST_ID_PATTERN } from '@workfluence/shared';
import { api } from '../../api';

/**
 * 감사로그 (FR-237, FR-243). append-only라 화면에도 조회만 있다.
 *
 * **요청 번호로 거른다** (P11 FR-1212) — 로그 한 줄(`requestId`)에서 그 요청의 감사 행으로 간다. 번호는 입력할 때가 아니라 **거르기를
 * 누를 때** 보낸다(치는 도중의 반쪽 번호로 요청하지 않는다). 모양은 서버와 같은 판정(`REQUEST_ID_PATTERN`)으로 먼저 본다
 */
export function AdminAuditPage() {
  const [rows, setRows] = useState<AuditEventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 거르는 조건 (FR-531). **거를 수 없으면 "추적한다"가 성립하지 않는다** — 수만 건에서 눈으로 찾을 수는 없다
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [requestIdInput, setRequestIdInput] = useState('');
  const [requestId, setRequestId] = useState('');

  const load = useCallback(() => {
    const q = new URLSearchParams({ limit: String(LIST_PAGE_LIMIT) });
    if (action) q.set('action', action);
    if (requestId) q.set('requestId', requestId);
    // **지역 시간(KST)의 0시**로 만들어 보낸다. `new Date('2026-09-22')`는 UTC 0시라
    // 화면이 KST로 보여 주는 것과 **9시간 어긋난다** — 그날 새벽 기록이 빠지고 다음 날
    // 새벽 기록이 들어온다 (코드 리뷰 3). `T00:00`을 붙이면 지역 시간으로 읽힌다
    if (from) q.set('from', new Date(`${from}T00:00`).toISOString());
    // 끝 날짜는 **그날을 포함**하도록 다음 날 0시로 보낸다. 서버는 `to` 미만으로 거른다
    if (to) q.set('to', new Date(new Date(`${to}T00:00`).getTime() + 86_400_000).toISOString());
    api<AuditEventView[]>(`/api/audit?${q.toString()}`)
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [action, from, to, requestId]);
  useEffect(load, [load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const id = requestIdInput.trim();
    if (id && !REQUEST_ID_PATTERN.test(id)) {
      setError('요청 번호의 모양이 아니다 — 로그 줄의 requestId를 그대로 붙인다');
      return;
    }
    // 번호가 바뀌면 `load`가 바뀌어 다시 읽는다. 같으면 여기서 읽는다
    if (id !== requestId) setRequestId(id);
    else load();
  };

  return (
    <main className="shell">
      <h1>감사로그</h1>
      <p className="muted small"><Link to="/">← 홈</Link> · 기록은 추가만 된다. 고치거나 지울 수 없다.</p>
      {error && <p className="badge fail" role="alert">{error}</p>}

      <form onSubmit={submit} className="card">
        <label htmlFor="action">행위</label>
        <select id="action" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">전체</option>
          {AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>{' '}
        <label htmlFor="from">시작</label>
        <input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />{' '}
        <label htmlFor="to">끝</label>
        <input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />{' '}
        <label htmlFor="requestId">요청 번호</label>
        <input id="requestId" value={requestIdInput} placeholder="로그의 requestId" onChange={(e) => setRequestIdInput(e.target.value)} />{' '}
        <button type="submit">거르기</button>
        <p className="muted small">{rows.length}건 (최대 {LIST_PAGE_LIMIT})</p>
      </form>

      <table className="card">
        <thead>
          <tr><th>시각</th><th>행위</th><th>주체</th><th>대상</th><th>상세</th><th>요청 번호</th></tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.createdAt).toLocaleString('ko-KR')}</td>
              <td><code>{e.action}</code></td>
              <td>{e.actorName ?? '-'}</td>
              <td>{e.targetId ?? '-'}</td>
              <td className="small">{e.detail ? JSON.stringify(e.detail) : '-'}</td>
              <td className="small">{e.requestId ? <code>{e.requestId}</code> : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
