import type { ApiTokenView } from '@workfluence/shared';
import { EmptyState, StatusBadge } from './ui';

/** 권한(scope)의 이름 — 화면의 말. 값은 코드 그대로 보낸다 */
export const API_SCOPE_NAMES: Record<string, string> = { read: '읽기', write: '쓰기', admin: '관리' };

const STATUS: Record<ApiTokenView['status'], { name: string; kind: 'ok' | 'bad' | 'wait' }> = {
  active: { name: '사용 중', kind: 'ok' },
  revoked: { name: '폐기됨', kind: 'bad' },
  expired: { name: '만료됨', kind: 'wait' },
};

const when = (iso: string) => new Date(iso).toLocaleString('ko-KR');

/**
 * API 토큰 목록 (docs/spinoff/public-api 설계서 FR-2222). **내 토큰 화면과 사용자 관리의 그 사람 토큰 패널이 같은 목록을 쓴다.** 값(토큰 문자열)은
 * 어디에도 없다 — 이름·권한·상태·날짜뿐이다. 폐기 단추는 쓰고 있는 토큰에만 있다(폐기됨·만료됨은 되돌릴 일이 없다)
 */
export function ApiTokenList({
  tokens,
  onRevoke,
  busyId = null,
  emptyText = '발급한 토큰이 없다',
}: {
  tokens: ApiTokenView[];
  onRevoke: (t: ApiTokenView) => void;
  /** 폐기하는 중인 토큰 — 그 단추는 누를 수 없다 */
  busyId?: string | null;
  emptyText?: string;
}) {
  if (tokens.length === 0) return <EmptyState title={emptyText} />;
  return (
    <table>
      <thead>
        <tr>
          <th>이름</th>
          <th>권한</th>
          <th>상태</th>
          <th>만든 때</th>
          <th>만료</th>
          <th>마지막 사용</th>
          <th>조치</th>
        </tr>
      </thead>
      <tbody>
        {tokens.map((t) => {
          const s = STATUS[t.status];
          return (
            <tr key={t.id}>
              <td className="break-any">{t.name}</td>
              <td>
                <div className="actions">
                  {t.scopes.map((x) => (
                    <span key={x} className="badge">
                      {API_SCOPE_NAMES[x] ?? x}
                    </span>
                  ))}
                </div>
              </td>
              <td>
                <StatusBadge kind={s.kind}>{s.name}</StatusBadge>
              </td>
              <td>{when(t.createdAt)}</td>
              <td>{when(t.expiresAt)}</td>
              <td>{t.lastUsedAt ? when(t.lastUsedAt) : <span className="muted">쓴 적 없음</span>}</td>
              <td>
                {t.status === 'active' ? (
                  <button type="button" className="danger sm" disabled={busyId === t.id} onClick={() => onRevoke(t)}>
                    폐기
                  </button>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
