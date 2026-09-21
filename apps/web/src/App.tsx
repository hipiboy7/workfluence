import { useEffect, useState } from 'react';

type Health = { status: string; db: string; time: string };
type State = { kind: 'loading' } | { kind: 'ok'; health: Health } | { kind: 'fail'; reason: string };

/**
 * Phase 0 화면: 기동 확인 (FR-071).
 * 기능 화면은 Phase 1부터. 여기서는 api와 DB가 살아 있는지를 브라우저에서 눈으로 확인한다.
 */
export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = () => {
    setState({ kind: 'loading' });
    fetch('/api/health', { credentials: 'same-origin' })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as Health | null;
        if (!res.ok || !body) throw new Error(`HTTP ${res.status}${body ? `: ${JSON.stringify(body)}` : ''}`);
        setState({ kind: 'ok', health: body });
      })
      .catch((e: unknown) => setState({ kind: 'fail', reason: e instanceof Error ? e.message : String(e) }));
  };

  useEffect(load, []);

  return (
    <main className="shell">
      <h1>workfluence</h1>
      <p className="muted">금융 폐쇄망 내부용 위키 · 공통 기반 (Phase 0)</p>

      <section className="card" aria-live="polite">
        <h2>기동 확인</h2>
        {state.kind === 'loading' && <p className="muted">확인 중…</p>}
        {state.kind === 'ok' && (
          <dl className="meta">
            <dt>API</dt>
            <dd>
              <span className="badge ok">{state.health.status}</span>
            </dd>
            <dt>데이터베이스</dt>
            <dd>
              <span className="badge ok">{state.health.db}</span>
            </dd>
            <dt>서버 시각</dt>
            <dd>{new Date(state.health.time).toLocaleString('ko-KR')}</dd>
          </dl>
        )}
        {state.kind === 'fail' && (
          <>
            <p className="badge fail">연결 실패</p>
            <pre className="reason">{state.reason}</pre>
            <p className="muted small">개발 환경이면 `pnpm dev:db`로 데이터베이스가 떠 있는지 먼저 확인한다.</p>
          </>
        )}
        <button type="button" onClick={load}>
          다시 확인
        </button>
      </section>

      <p className="muted small">다음 단계: 로그인·사용자 관리 (Phase 1)</p>
    </main>
  );
}
