import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@workfluence/shared';

/**
 * 부하 측정 (P5_설계서_Release B절, FR-620~623).
 *
 * **도구를 늘리지 않는다** (쟁점 2). k6·Gatling을 반입 목록에 올리지 않으려면 이 정도는
 * 직접 쓰는 편이 낫다 — 재는 것은 "동시 N명이 평소에 하는 일"이고 그것은 복잡하지 않다.
 *
 * **합성 데이터만 쓰고 끝나면 지운다** (FR-622, `CLAUDE.md` 6절).
 */
const BASE = process.env.WF_LOAD_BASE ?? 'http://127.0.0.1:3000';
const SESSIONS = Number(process.env.WF_LOAD_SESSIONS ?? 50);
const ROUNDS = Number(process.env.WF_LOAD_ROUNDS ?? 10);

type Sample = { step: string; ms: number; ok: boolean };

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`로그인 실패 ${res.status}`);
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

async function timed(step: string, cookie: string, path: string, out: Sample[]): Promise<void> {
  const t = performance.now();
  let ok = false;
  try {
    const r = await fetch(`${BASE}${path}`, { headers: { cookie, [CSRF_HEADER]: CSRF_HEADER_VALUE } });
    ok = r.ok;
    await r.arrayBuffer();
  } catch {
    ok = false;
  }
  out.push({ step, ms: performance.now() - t, ok });
}

function report(samples: Sample[]): { worstP95: number; errors: number } {
  const steps = [...new Set(samples.map((s) => s.step))];
  let worstP95 = 0;
  const errors = samples.filter((s) => !s.ok).length;
  console.log(`\n동시 ${SESSIONS}세션 × ${ROUNDS}회 — 표본 ${samples.length}개, 오류 ${errors}개\n`);
  console.log('| 단계 | p50 | p95 | max |');
  console.log('|---|---|---|---|');
  for (const step of steps) {
    const xs = samples.filter((s) => s.step === step).map((s) => s.ms).sort((a, b) => a - b);
    const p = (q: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * q))];
    worstP95 = Math.max(worstP95, p(0.95));
    console.log(`| ${step} | ${p(0.5).toFixed(0)}ms | ${p(0.95).toFixed(0)}ms | ${xs[xs.length - 1].toFixed(0)}ms |`);
  }
  return { worstP95, errors };
}

async function main(): Promise<void> {
  const username = process.env.WF_LOAD_USER;
  const password = process.env.WF_LOAD_PASSWORD;
  if (!username || !password) throw new Error('WF_LOAD_USER·WF_LOAD_PASSWORD를 주고 돌린다 (합성 계정)');

  // 세션을 **미리 다 연다.** 측정 중에 로그인이 섞이면 재려던 것(읽기 지연)이 흐려진다
  const cookies = await Promise.all(Array.from({ length: SESSIONS }, () => login(username, password)));
  console.log(`[load] 세션 ${cookies.length}개 열림`);

  const samples: Sample[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    await Promise.all(
      cookies.map(async (c) => {
        await timed('스페이스 목록', c, '/api/spaces?scope=all&limit=50', samples);
        await timed('검색(한글 2글자)', c, `/api/search?q=${encodeURIComponent('회의')}&limit=20`, samples);
        await timed('알림 수', c, '/api/notifications/unread-count', samples);
        await timed('감사로그', c, '/api/audit?limit=50', samples);
      }),
    );
  }

  const { worstP95, errors } = report(samples);
  const target = 1000;
  console.log(
    `\n[load] 판정 (보류 6): 가장 느린 단계의 p95 ${worstP95.toFixed(0)}ms ` +
      `${worstP95 < target && errors === 0 ? `< ${target}ms → **이중화 불필요**` : `— 목표 ${target}ms 미달 또는 오류 발생 → 이중화 검토`}`,
  );
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
