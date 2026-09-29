import { useCallback, useEffect, useState } from 'react';
import type { AuditEventView } from '@workfluence/shared';
import { AUDIT_ACTIONS } from '@workfluence/shared';
import { LIST_PAGE_LIMIT, REQUEST_ID_PATTERN } from '@workfluence/shared';
import { can } from '@workfluence/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { AuditLevelCard } from '../../components/AuditLevelCard';
import { AUDIT_ACTION_NAMES, auditActionName } from '../../components/auditNames';
import { withCode } from '../../components/labels';
import { CodeBlock, EmptyState, Field, FilterBar, Loading, Notice, Page, PageHeader } from '../../components/ui';

/** uuid 모양의 대상 — 칸에는 앞 8자만 보이고 전체는 `title`로 (J.6 관리 다섯) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 상세 요약의 길이 — 넘으면 펼쳐 본다 */
const DETAIL_SUMMARY_MAX = 80;

/** 대상의 이름 — 감사 행에는 이름 칸이 없어 상세가 싣는 이름(아이디·이름·제목)을 쓴다. 없으면 `null` */
function targetName(e: AuditEventView): string | null {
  const d = e.detail;
  if (!d) return null;
  for (const k of ['username', 'name', 'title'] as const) {
    const v = d[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/** 대상 칸 — 이름이 있으면 이름, 없으면 식별자(uuid는 앞 8자). 전체 식별자는 `title`로 늘 볼 수 있다 */
function Target({ e }: { e: AuditEventView }) {
  if (!e.targetId) return <>-</>;
  const full = e.targetType ? `${e.targetType} ${e.targetId}` : e.targetId;
  const name = targetName(e);
  if (name) {
    return (
      <span className="break-any" title={full}>
        {name}
      </span>
    );
  }
  return UUID.test(e.targetId) ? (
    <span className="mono" title={full}>
      {e.targetId.slice(0, 8)}
    </span>
  ) : (
    <span className="break-any" title={full}>
      {e.targetId}
    </span>
  );
}

/** 상세 한 줄 요약 — "키: 값 · 키: 값". 길면 잘라 두고 펼치면 전체 JSON이다 (J.5.12 CodeBlock) */
function Detail({ detail }: { detail: Record<string, unknown> | null }) {
  if (!detail) return <>-</>;
  const line = Object.entries(detail)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
  if (line.length <= DETAIL_SUMMARY_MAX) return <span className="break-any">{line}</span>;
  return (
    <details>
      <summary className="break-any">{`${line.slice(0, DETAIL_SUMMARY_MAX)}…`}</summary>
      <CodeBlock label="상세 전체">{JSON.stringify(detail, null, 2)}</CodeBlock>
    </details>
  );
}

/**
 * 감사로그 (FR-237, FR-243). append-only라 화면에도 조회만 있다. 폭 상한이 없다(J.3.4 — 열이 길다).
 * 순서는 관리 다섯의 공통 순서(J.6) — 머리 → 기록 단계(접힌 구획) → 알림띠 → 거르기 줄 → 표. **표의 열 순서는 바꾸지 않는다** — 시험이 둘째 칸을 행위로 읽는다.
 *
 * **요청 번호로 거른다** (P11 FR-1212) — 로그 한 줄(`requestId`)에서 그 요청의 감사 행으로 간다. 번호는 입력할 때가 아니라 **거르기를
 * 누를 때** 보낸다(치는 도중의 반쪽 번호로 요청하지 않는다). 모양은 서버와 같은 판정(`REQUEST_ID_PATTERN`)으로 먼저 본다.
 *
 * 행위는 "한글 (코드)"로 보인다(J.9-9) — 고르기 칸의 값과 표의 `code`는 코드 그대로라 장애대응 가이드의 코드로 찾는다
 */
export function AdminAuditPage() {
  const { me } = useAuth();
  const [rows, setRows] = useState<AuditEventView[]>([]);
  // 한 번이라도 받았는가 — 받기 전에 거절되면(권한 없음) 거르기 줄과 표 없이 알림띠만 보인다
  const [loaded, setLoaded] = useState(false);
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
      .then((r) => {
        setRows(r);
        setLoaded(true);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [action, from, to, requestId]);
  useEffect(load, [load]);

  const submit = () => {
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
    <Page width="full">
      <PageHeader title="감사로그" description="기록은 추가만 된다. 고치거나 지울 수 없다." />
      {/* 감사 기록 단계 (P17 F-010 10번) — 사용자 원문 "시스템 관리자가 감사로그 화면에서 … 지정". 판정은 `can` — root 전용 행위다 */}
      <AuditLevelCard canChange={!!me && can({ id: me.id, role: me.role, grants: me.grants }, 'system.manage')} />
      {error && <Notice kind="error">{error}</Notice>}
      {!loaded ? (
        !error && <Loading />
      ) : (
        <>
          <FilterBar label="감사로그 거르기" onSubmit={submit} count={`${rows.length}건 (최대 ${LIST_PAGE_LIMIT})`}>
            <Field id="action" label="행위">
              <select id="action" className="w-m" value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="">전체</option>
                {AUDIT_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {withCode(AUDIT_ACTION_NAMES[a], a)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="from" label="시작">
              <input id="from" type="date" className="w-s" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field id="to" label="끝">
              <input id="to" type="date" className="w-s" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field id="requestId" label="요청 번호">
              <input id="requestId" className="w-m" value={requestIdInput} placeholder="로그의 requestId" onChange={(e) => setRequestIdInput(e.target.value)} />
            </Field>
            <button type="submit" className="primary">
              거르기
            </button>
          </FilterBar>

          <div className="table-scroll" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    시각
                  </th>
                  <th scope="col">행위</th>
                  <th scope="col">주체</th>
                  <th scope="col">대상</th>
                  <th scope="col">상세</th>
                  <th scope="col">요청 번호</th>
                </tr>
              </thead>
              {/* 0건이면 몸통에 줄을 두지 않는다 — 시험이 "거른 줄이 0개"를 `tbody tr`의 수로 본다. 빈 상태는 표 아래에 */}
              <tbody>
                {rows.map((e) => {
                  const name = auditActionName(e.action);
                  return (
                    <tr key={e.id}>
                      <td className="num nowrap">{new Date(e.createdAt).toLocaleString('ko-KR')}</td>
                      <td>
                        {name && <>{name} </>}
                        <code>{e.action}</code>
                      </td>
                      <td>{e.actorName ?? '-'}</td>
                      <td>
                        <Target e={e} />
                      </td>
                      <td className="small">
                        <Detail detail={e.detail} />
                      </td>
                      <td className="small">{e.requestId ? <code>{e.requestId}</code> : '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <EmptyState title="조건에 맞는 기록이 없다." description="기간이나 행위를 넓혀 다시 거른다." />}
        </>
      )}
    </Page>
  );
}
