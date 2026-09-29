import { useEffect, useState, type FormEvent } from 'react';
import { AUDIT_ACTIONS, auditRecorded } from '@workfluence/shared';
import { api } from '../api';
import { AUDIT_ACTION_NAMES } from './auditNames';
import { FormActions, Notice } from './ui';

type Level = 1 | 2 | 3;

/** 단계의 이름과 한 줄 뜻 (P17 I절). 빠지는 행위의 목록은 여기 적지 않고 규칙(`AUDIT_MIN_LEVEL`)에서 뽑는다 — 한 곳에만 쓴다 */
export const AUDIT_LEVEL_TEXT: Record<Level, { name: string; summary: string }> = {
  3: { name: '3 · 전체', summary: '모든 행위를 남긴다 (기본)' },
  2: { name: '2 · 줄임', summary: '실시간 편집의 자동 저장을 남기지 않는다' },
  1: { name: '1 · 최소', summary: '필수 기록만 — 자동 저장·첨부 받기·HTML 내보내기·메일 발송 성공·LLM 질문을 남기지 않는다' },
};
const LEVELS: Level[] = [3, 2, 1];
/** 그 단계에서 남기지 않는 행위 — 한글 이름으로 보인다(J.9-9). 코드는 감사로그 표와 행위 고르기 칸이 함께 보인다 */
const droppedAt = (level: Level) => AUDIT_ACTIONS.filter((a) => !auditRecorded(a, level)).map((a) => AUDIT_ACTION_NAMES[a]);

/**
 * 감사 기록 단계 (P17 F-010 10번, FR-1840~1842). 감사로그 화면 머리 아래의 **접힌 구획**(`details`, J.6 관리 다섯) — 접힌 줄에 지금 단계가 보이고,
 * 펴면 고른다. **시스템 관리자만** 고른다(서버도 막는다 — `PolicyController.update`). 로그인·계정·권한·관리·설정·만들기·고치기·지우기 같은 필수 기록은
 * 단계와 무관하게 늘 남는다.
 *
 * **표로 만들지 않는다** — 감사로그 화면의 표는 기록 목록 하나다(시험이 `getByRole('table')` 하나로 찾는다). 알림띠는 접힌 구획 밖에 둔다 — 단계를 읽지
 * 못한 오류가 접힌 채 숨지 않게
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
    <>
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}
      <details className="card" aria-label="감사 기록 단계">
        <summary>
          기록 단계:{' '}
          {level !== null ? (
            <>
              <strong>{AUDIT_LEVEL_TEXT[level].name}</strong> — {canChange ? '바꾸기' : '보기'}
            </>
          ) : (
            <span className="muted">{error ? '읽지 못했다' : '불러오는 중…'}</span>
          )}
        </summary>
        <p className="muted">로그인·계정·권한·관리·설정, 만들기·고치기·지우기·옮기기·되살리기 같은 필수 기록은 단계와 무관하게 늘 남는다.</p>
        {canChange && level !== null ? (
          <form onSubmit={save}>
            <fieldset>
              <legend>단계 고르기</legend>
              {LEVELS.map((l) => {
                const dropped = droppedAt(l);
                return (
                  <div key={l} className="field">
                    <label>
                      <input
                        type="radio"
                        name="audit-level"
                        value={l}
                        checked={draft === l}
                        aria-describedby={dropped.length > 0 ? `audit-level-${l}-dropped` : undefined}
                        onChange={() => setDraft(l)}
                      />{' '}
                      <strong>{AUDIT_LEVEL_TEXT[l].name}</strong> — {AUDIT_LEVEL_TEXT[l].summary}
                    </label>
                    {dropped.length > 0 && (
                      <p id={`audit-level-${l}-dropped`} className="field-help">
                        남기지 않는 것: {dropped.join(', ')}
                      </p>
                    )}
                  </div>
                );
              })}
            </fieldset>
            <FormActions>
              <button type="submit" className="primary" disabled={draft === level}>
                단계 저장
              </button>
            </FormActions>
          </form>
        ) : (
          level !== null && (
            <>
              <p>지금: {AUDIT_LEVEL_TEXT[level].summary}</p>
              <p className="muted">단계는 시스템 관리자만 바꾼다.</p>
            </>
          )
        )}
      </details>
    </>
  );
}
