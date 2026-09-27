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
/**
 * **쉬어 가며 읽기** (P13 NFR-131). 0이면 쉬지 않는다(기본 — 보류 6의 측정 그대로다).
 *
 * 쉬지 않으면 세션마다 늘 한 건이 떠 있어, 지연이 **떠 있는 수 ÷ 처리량**으로 정해진다 — 몰린 로그인의 argon2가 CPU를 나눠 가져
 * 처리량이 줄면, 풀을 기다리지 않아도 같은 수가 떠 있으므로 지연이 그만큼 는다. 사람은 읽고 나서 쉰다. 값을 주면 세션마다 한 단계를
 * 읽은 뒤 이 값의 0.5~1.5배를 쉬고, 세션의 시작을 고르게 어긋내며, 세션끼리 회를 맞추지 않는다(`read` — 50개가 같은 순간 같은 단계를
 * 치지 않게). 보류 16의 판정(NFR-131)은 이 모양으로 쟀다
 */
const THINK_MS = Number(process.env.LOAD_THINK_MS ?? 0);
/**
 * **몰린 로그인** (보류 16, P13 측정). 0이면 던지지 않는다(기본 — 보류 6의 측정 그대로다).
 *
 * 재려는 것은 로그인 자체의 속도보다 **그동안 남의 읽기가 풀을 기다리는가**다(보류 16 — 예전에는 로그인이 트랜잭션을 연 채 argon2를
 * 돌려, 몰린 동안 연결이 모두 idle in transaction이 됐다. Phase 13이 확인을 트랜잭션 밖으로 뺐다). 그래서 따로 재지 않고, 보류 6의 읽기를
 * 한 번 잰 뒤 **같은 세션들이 계속 읽는 동안** 로그인을 이만큼 던져 둘을 견준다. **판정은 읽기로 한다** — 몰린 로그인 자체의 지연은 CPU에
 * 묶인다(코어 수 × 약 5건/초, P13 측정). 로그인 수치는 따로 보인다.
 *
 * **계정** — `LOAD_LOGIN_STORM_USER_PREFIX`를 주면 `<접두>1`…`<접두>N`(비밀번호는 `LOAD_PASSWORD`)을 하나씩 쓴다 — 여러 사람이 몰리는
 * 모양이다. 주지 않으면 `LOAD_USER` 하나를 되풀이한다 — **Phase 13부터 한 계정의 로그인은 차례로 처리되므로**(P13 FR-1431) 그때 재는 것은
 * 한 사람이 동시에 여러 번 로그인하는 모양이다.
 *
 * **한 주소에서 20건을 넘겨 동시에 띄우면 넘는 몫은 곧바로 429다.** 로그인 제한(`RATE_LIMITS.login` — IP별 20건/60초, 성공은
 * 돌려받는다)이 제 일을 하는 것이다. 제한을 끄거나 주소를 꾸미지 않는다 — 그러면 재는 것이 보안 장치를 비켜 간 앱이 된다.
 */
const STORM = Number(process.env.LOAD_LOGIN_STORM ?? 0);
/** 몰린 로그인이 한꺼번에 떠 있는 수. 기본은 전부(= 한꺼번에). 작게 주면 앞의 것이 끝나는 대로 다음을 보낸다 — 쉬지 않고 몰리는 아침이다 */
const STORM_CONCURRENCY = Number(process.env.LOAD_LOGIN_STORM_CONCURRENCY ?? STORM);
/** 몰린 로그인에 쓸 서로 다른 계정의 접두(위). 비면 `LOAD_USER`를 되풀이한다 */
const STORM_USER_PREFIX = process.env.LOAD_LOGIN_STORM_USER_PREFIX ?? '';

type Sample = { step: string; ms: number; ok: boolean; at: number };
type LoginResult = { ms: number; status: number };

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
  out.push({ step, ms: performance.now() - t, ok, at: t });
}

const READ_STEPS: [step: string, path: string][] = [
  ['스페이스 목록', '/api/spaces?scope=all&limit=50'],
  ['검색(한글 2글자)', `/api/search?q=${encodeURIComponent('회의')}&limit=20`],
  ['알림 수', '/api/notifications/unread-count'],
  ['감사로그', '/api/audit?limit=50'],
];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 세션들이 `more(회)`가 참인 동안 읽는다. 한 회는 세션마다 네 단계를 차례로 한 번이다. 돌아오는 값은 가장 많이 돈 세션의 회 수다.
 *
 * **쉬지 않으면 회마다 모두를 기다린다** — P5(보류 6)의 측정 그대로다. **쉬어 가며 읽으면 세션마다 제 박자로 돈다** — 시작만 고르게
 * 어긋내고 회마다 서로를 기다리지 않는다. 기다리면 회가 시작될 때마다 모든 세션이 첫 단계(가장 무거운 스페이스 목록)를 1초 안에
 * 한꺼번에 쳐서 사람이 쓰는 모양이 아니게 된다(P13 측정 — 몰린 동안 그 단계만 p50 180ms, 나머지 단계는 10ms 안팎이었다)
 */
async function read(cookies: string[], samples: Sample[], more: (round: number) => boolean): Promise<number> {
  if (!THINK_MS) {
    let round = 0;
    for (; more(round); round++) {
      await Promise.all(
        cookies.map(async (c) => {
          for (const [step, path] of READ_STEPS) await timed(step, c, path, samples);
        }),
      );
    }
    return round;
  }
  const rounds = await Promise.all(
    cookies.map(async (c, k) => {
      await sleep((k * THINK_MS) / cookies.length);
      let round = 0;
      for (; more(round); round++) {
        for (const [step, path] of READ_STEPS) {
          await timed(step, c, path, samples);
          await sleep(THINK_MS * (0.5 + Math.random()));
        }
      }
      return round;
    }),
  );
  return Math.max(...rounds);
}

const paced = () => (THINK_MS ? ` (단계마다 약 ${THINK_MS}ms 쉼)` : '');

function report(samples: Sample[], title: string): { worstP95: number; errors: number } {
  const steps = [...new Set(samples.map((s) => s.step))];
  let worstP95 = 0;
  const errors = samples.filter((s) => !s.ok).length;
  console.log(`\n${title} — 표본 ${samples.length}개, 오류 ${errors}개\n`);
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

/** 몰린 로그인 한 건. 실패도 그대로 센다 — 429(제한)·5xx(풀을 못 얻음 등)가 이 측정의 결과다 */
async function stormLogin(username: string, password: string): Promise<LoginResult> {
  const t = performance.now();
  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
      body: JSON.stringify({ username, password }),
    });
    await res.arrayBuffer();
    return { ms: performance.now() - t, status: res.status };
  } catch {
    return { ms: performance.now() - t, status: 0 };
  }
}

/** `STORM`건을 `STORM_CONCURRENCY`건씩 떠 있게 던진다. 끝나는 대로 다음 것을 보낸다 */
async function loginStorm(username: string, password: string): Promise<{ results: LoginResult[]; startedAt: number; endedAt: number }> {
  const startedAt = performance.now();
  const results: LoginResult[] = [];
  let sent = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(STORM_CONCURRENCY, STORM)) }, async () => {
      while (sent < STORM) {
        sent++;
        results.push(await stormLogin(STORM_USER_PREFIX ? `${STORM_USER_PREFIX}${sent}` : username, password));
      }
    }),
  );
  return { results, startedAt, endedAt: performance.now() };
}

/**
 * 보류 16 — 보류 6과 **같은 세션들이** 읽기를 이어 가는 동안 로그인을 던진다. 로그인이 끝날 때까지 읽는다(그 회까지). 판정은 로그인이
 * 떠 있던 동안 시작한 읽기만 본다. 통과하면 `true`
 */
async function stormPhase(username: string, password: string, cookies: string[]): Promise<boolean> {
  const state = { done: false };
  const storm = loginStorm(username, password).finally(() => {
    state.done = true;
  });
  const samples: Sample[] = [];
  // 적어도 한 회, 그 뒤로는 로그인이 끝날 때까지
  const rounds = await read(cookies, samples, (r) => r === 0 || !state.done);
  const { results, startedAt, endedAt } = await storm;

  const during = samples.filter((s) => s.at >= startedAt && s.at <= endedAt);
  // 겹친 읽기가 없으면 잰 것이 없다 — 빈 표를 "통과"로 읽지 않게 여기서 끊는다
  if (!during.length) {
    console.log('\n[load] 판정 (보류 16): 몰린 로그인이 떠 있던 동안 시작한 읽기가 없다 — 잰 것이 없다');
    return false;
  }
  const { worstP95, errors } = report(during, `몰린 로그인 중 — 동시 ${SESSIONS}세션 × ${rounds}회${paced()}`);

  const ok = results.filter((r) => r.status === 201).map((r) => r.ms).sort((a, b) => a - b);
  const limited = results.filter((r) => r.status === 429).length;
  const failed = results.length - ok.length - limited;
  const p = (q: number) => (ok.length ? ok[Math.min(ok.length - 1, Math.floor(ok.length * q))] : Number.NaN);
  const sec = (endedAt - startedAt) / 1000;
  const conc = Math.min(STORM_CONCURRENCY, STORM);
  console.log(
    `\n[load] 몰린 로그인 ${STORM}건 (한꺼번에 ${conc}건씩) — 성공 ${ok.length} · 제한 429 ${limited} · 실패 ${failed}. ` +
      `성공 p50 ${p(0.5).toFixed(0)}ms · p95 ${p(0.95).toFixed(0)}ms · max ${p(1).toFixed(0)}ms, ${sec.toFixed(1)}초에 초당 ${(ok.length / sec).toFixed(1)}건`,
  );
  if (limited) console.log('[load] 429는 IP별 로그인 제한이 돌려보낸 것이다 — 한 주소에서 20건을 넘겨 띄웠다. 서로 다른 주소에서 오는 사람들은 걸리지 않는다');

  const target = TARGET_P95_MS;
  // **판정은 읽기로 한다** (위 머리말). 로그인 실패(429 말고)는 여전히 실패다 — 풀을 못 얻어 500이 났다는 뜻이다
  const pass = worstP95 < target && errors === 0 && failed === 0;
  console.log(
    `[load] 판정 (보류 16): 몰린 로그인 중 가장 느린 읽기 p95 ${worstP95.toFixed(0)}ms (목표 ${target}ms) · 오류 읽기 ${errors}·로그인 ${failed} → ` +
      `${pass ? '목표 안' : '목표 밖 — 몰린 로그인이 남의 읽기를 밀었다'}. 로그인 p95 ${p(0.95).toFixed(0)}ms는 CPU에 묶인다(판정에 넣지 않는다)`,
  );
  return pass;
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
  await read(cookies, samples, (r) => r < ROUNDS);

  const { worstP95, errors } = report(samples, `동시 ${SESSIONS}세션 × ${ROUNDS}회${paced()}`);
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

  // 보류 16 — 위의 표가 "몰린 로그인이 없을 때"다. 같은 세션으로 이어서 재므로 둘을 그대로 견줄 수 있다
  if (STORM > 0 && !(await stormPhase(username, password, cookies))) process.exitCode = 1;
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
