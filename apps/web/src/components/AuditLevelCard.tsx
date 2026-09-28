import { useEffect, useState, type FormEvent } from 'react';
import { AUDIT_ACTIONS, auditRecorded } from '@workfluence/shared';
import { api } from '../api';

type Level = 1 | 2 | 3;

/** 단계의 이름과 한 줄 뜻 (P17 I절). 빠지는 행위의 목록은 여기 적지 않고 규칙(`AUDIT_MIN_LEVEL`)에서 뽑는다 — 한 곳에만 쓴다 */
export const AUDIT_LEVEL_TEXT: Record<Level, { name: string; summary: string }> = {
  3: { name: '3 · 전체', summary: '모든 행위를 남긴다 (기본)' },
  2: { name: '2 · 줄임', summary: '실시간 편집의 자동 저장을 남기지 않는다' },
  1: { name: '1 · 최소', summary: '필수 기록만 — 자동 저장·첨부 받기·HTML 내보내기·메일 발송 성공·LLM 질문을 남기지 않는다' },
};
const LEVELS: Level[] = [3, 2, 1];
const droppedAt = (level: Level) => AUDIT_ACTIONS.filter((a) => !auditRecorded(a, level));

/**
 * 감사 기록 단계 (P17 F-010 10번, FR-1840~1842). 감사로그 화면 맨 위에 지금 단계를 보이고, **시스템 관리자만** 고른다(서버도 막는다 —
 * `PolicyController.update`). 로그인·계정·권한·관리·설정·만들기·고치기·지우기 같은 필수 기록은 단계와 무관하게 늘 남는다
 */
export function AuditLevelCard({ canChange }: { canChange: boolean }) {
  const [level, setLevel] = useState<Level | null>(null);
  const [draft, setDraft] = useState<Level>(3);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api<{ auditLevel?: number }>('/api/settings/policy')
      .then((p) => {
        const v = (p.auditLevel ?? 3) as Level;
        setLevel(v);
        setDraft(v);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await api('/api/settings/policy', { method: 'PATCH', json: { auditLevel: draft } });
      setLevel(draft);
      setNotice('저장했다 — 다음 기록부터 먹는다. 바꾼 것은 감사로그에 settings.update로 남는다.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="card" aria-labelledby="audit-level-title">
      <h2 id="audit-level-title">감사 기록 단계</h2>
      {error && (
        <p className="badge fail" role="alert">
          {error}
        </p>
      )}
      {level !== null && (
        <p>
          지금: <strong>{AUDIT_LEVEL_TEXT[level].name}</strong> — {AUDIT_LEVEL_TEXT[level].summary}
        </p>
      )}
      <p className="muted small">로그인·계정·권한·관리·설정, 만들기·고치기·지우기·옮기기·되살리기 같은 필수 기록은 단계와 무관하게 늘 남는다.</p>
      {canChange && level !== null ? (
        <form onSubmit={save}>
          <fieldset className="field-group">
            <legend>단계 고르기</legend>
            {LEVELS.map((l) => (
              <p key={l}>
                <label>
                  <input type="radio" name="audit-level" value={l} checked={draft === l} onChange={() => setDraft(l)} /> <strong>{AUDIT_LEVEL_TEXT[l].name}</strong> —{' '}
                  {AUDIT_LEVEL_TEXT[l].summary}
                </label>
                {droppedAt(l).length > 0 && <span className="muted small"> (남기지 않는 것: {droppedAt(l).join(', ')})</span>}
              </p>
            ))}
          </fieldset>
          {notice && (
            <p className="badge" role="status">
              {notice}
            </p>
          )}
          <button type="submit" disabled={draft === level}>
            단계 저장
          </button>
        </form>
      ) : (
        level !== null && <p className="muted small">단계는 시스템 관리자만 바꾼다.</p>
      )}
    </section>
  );
}
