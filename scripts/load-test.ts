import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@workfluence/shared';

/**
 * 부하 측정 (P5_설계서_Release B절, FR-620~623).
 *
 * **도구를 늘리지 않는다** (쟁점 2). k6·Gatling을 반입 목록에 올리지 않으려면 이 정도는
 * 직접 쓰는 편이 낫다 — 재는 것은 "동시 N명이 평소에 하는 일"이고 그것은 복잡하지 않다.
 *
 * **합성 데이터만 쓰고 끝나면 지운다** (FR-622, `CLAUDE.md` 6절).
 */
/**
 * **`WF_` 접두사를 쓰지 않는다** (CLAUDE.md 5절).
 *
 * `WF_*`는 앱 설정이고, `packages/shared`의 스키마가 **모르는 `WF_` 키를 보면 기동을
 * 거부한다.** 이 값들은 측정 도구의 인자일 뿐이라 스키마에 넣을 것이 아니고, 그렇다고
 * `WF_LOAD_*`로 두면 누군가 `.env`에 적는 순간 앱이 안 뜬다. 접두사를 떼어 **앱 설정이
 * 아님을 이름으로 드러낸다.**
 */
/** 기본 대상은 개발 서버의 api다. 컨테이너 스택을 재려면 `LOAD_BASE`를 준다 */
const DEFAULT_BASE = 'http://127.0.0.1:3000';
/** 판정선 — NFR-50 (P5_설계서_Release). 이 값이 보류 6의 기준이었다 */
const TARGET_P95_MS = 1000;

const BASE = process.env.LOAD_BASE ?? DEFAULT_BASE;
const SESSIONS = Number(process.env.LOAD_SESSIONS ?? 50);
const ROUNDS = Number(process.env.LOAD_ROUNDS ?? 10);
const LOGIN_CHUNK = Number(process.env.LOAD_LOGIN_CHUNK ?? 5);

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
  const username = process.env.LOAD_USER;
  const password = process.env.LOAD_PASSWORD;
  if (!username || !password) throw new Error('LOAD_USER·LOAD_PASSWORD를 주고 돌린다 (합성 계정). 감사로그 단계가 있어 관리자 계정이 필요하다');

  // 세션을 **미리 다 연다.** 측정 중에 로그인이 섞이면 재려던 것(읽기 지연)이 흐려진다.
  //
  // **한꺼번에 열지 않는다.** 로그인은 IP별 제한을 받는다. 성공한 요청은 예산을 돌려받지만
  // (T-023), 50개를 동시에 던지면 **환불이 돌아오기 전에** 전부 심사를 통과해야 해서
  // 한도를 넘는다. 조금씩 나눠 열면 앞의 성공이 환불되어 걸리지 않는다.
  // 실제로는 50명이 서로 다른 주소에서 들어오므로 이 제한은 재려는 대상이 아니다.
  const cookies: string[] = [];
  for (let i = 0; i < SESSIONS; i += LOGIN_CHUNK) {
    const n = Math.min(LOGIN_CHUNK, SESSIONS - i);
    cookies.push(...(await Promise.all(Array.from({ length: n }, () => login(username, password)))));
  }
  console.log(`[load] 세션 ${cookies.length}개 열림 (${LOGIN_CHUNK}개씩)`);

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
  const target = TARGET_P95_MS;
  const pass = worstP95 < target && errors === 0;
  console.log(
    `\n[load] 판정 (보류 6): 가장 느린 단계의 p95 ${worstP95.toFixed(0)}ms ` +
      `${pass ? `< ${target}ms → **이중화 불필요**` : `— 목표 ${target}ms 미달 또는 오류 발생 → 이중화 검토`}`,
  );
  // **판정을 종료 코드로 낸다** (CLAUDE.md 12.2절). 콘솔 문자열만 내면 CI나 감싸는
  // 스크립트에서는 p95가 3초여도 "통과"가 된다 — 사람이 스크롤해야만 읽히는 판정은
  // 판정이 아니다 (코드 리뷰 4)
  if (!pass) process.exitCode = 1;
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
