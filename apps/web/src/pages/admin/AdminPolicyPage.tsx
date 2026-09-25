import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ALLOWED_UPLOAD_EXTENSIONS, policyConsistencyProblems, validatePolicyPatch, type Policy } from '@workfluence/shared';
import { api } from '../../api';

type PolicyView = Policy & { uploadCeilingMb: number };

/** 운영 정책값 (P4_설계서_Admin C절). 판정은 서버와 **같은 함수**를 쓴다 — 갈라지면 화면만 받아 준다 */
export function AdminPolicyPage() {
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [exts, setExts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api<PolicyView>('/api/settings/policy')
      .then((p) => {
        setPolicy(p);
        setExts(p.allowedExtensions);
        setDraft({});
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  if (!policy) return <main className="shell"><p className="muted">불러오는 중…</p></main>;

  const numberKeys = (Object.keys(policy) as (keyof PolicyView)[]).filter(
    (k) => typeof policy[k] === 'number' && k !== 'uploadCeilingMb',
  ) as (keyof Policy)[];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const patch: Record<string, unknown> = { ...draft };
    if (exts.join(',') !== policy.allowedExtensions.join(',')) patch.allowedExtensions = exts;
    // 서버와 같은 판정을 먼저 돌린다. 왕복하지 않고 바로 말해 준다
    // 값 하나하나의 범위와, **바꾼 뒤의 전체**로 보는 짝 규칙(LLM 고정 수 < 대화 수, P10 FR-1134)
    const problems = validatePolicyPatch(patch);
    if (!problems.length) problems.push(...policyConsistencyProblems({ ...policy, ...patch } as Policy));
    if (problems.length) {
      setError(problems.join('; '));
      return;
    }
    try {
      await api('/api/settings/policy', { method: 'PATCH', json: patch });
      setNotice('저장했다. 다음 요청부터 바로 먹는다 — 다시 띄울 필요가 없다.');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="shell">
      <p className="muted small"><Link to="/">← 스페이스 목록</Link></p>
      <h1>운영 설정</h1>
      {error && <p className="badge fail" role="alert">{error}</p>}
      {notice && <p className="badge" role="status">{notice}</p>}

      <form onSubmit={submit}>
        <section className="card">
          <h2>숫자 값</h2>
          {numberKeys.map((k) => (
            <p key={k}>
              <label htmlFor={k}>{k}</label>
              <input
                id={k}
                type="number"
                value={draft[k] ?? (policy[k] as number)}
                onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })}
              />
              {k === 'uploadMaxMb' && <span className="muted small"> 이 서버의 천장 {policy.uploadCeilingMb}MB</span>}
            </p>
          ))}
        </section>

        <section className="card">
          <h2>허용 확장자</h2>
          <p className="muted small">판정 규칙이 있는 것만 켤 수 있다. 목록 밖 확장자는 내용 검사를 지나치게 된다.</p>
          {ALLOWED_UPLOAD_EXTENSIONS.map((ext) => (
            <label key={ext} style={{ marginRight: '0.75rem' }}>
              <input
                type="checkbox"
                checked={exts.includes(ext)}
                onChange={(e) => setExts(e.target.checked ? [...exts, ext] : exts.filter((x) => x !== ext))}
              />
              {ext}
            </label>
          ))}
        </section>

        <button type="submit">저장</button>
      </form>
    </main>
  );
}
