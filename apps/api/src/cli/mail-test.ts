import { SETTINGS_KEYS, applyPolicy, auditRecorded, emailSchema, type AppEnv } from '@workfluence/shared';
import { Client } from 'pg';
import { databaseUrl, loadEnv } from '../config/config.module';
import { describeDatabaseUrl } from '../common/db-url';
import { testMail } from '../mail/domain/compose';
import { MAIL_TIMEOUT_MS, failureHint, hideSecret, mailConfigOf, mailRequest, statusHint } from '../mail/domain/request';

/** 받지 않았을 때 창에 보이는 응답 본문의 길이 (P18_설계서_Mail A.1-9) */
const RESPONSE_SNIPPET_MAX = 200;

export type MailTestOutput = { log: (line: string) => void; error: (line: string) => void };

/**
 * 사내 메일 시험 — 시험 메일 한 통 (P18_설계서_Mail FR-1905). 폐쇄망 현장에서 설정(`WF_MAIL_*`)을 적은 뒤 앱을 켜기 전에 친다.
 *
 * - 설정(주소·형식·보내는 이름·인증 헤더 **이름** — 값은 가린다)과 앱이 지금 메일을 보내는지를 먼저 말한다
 * - **켜져 있지 않아도 보낸다**(A.1-8) — 켜기 전에 확인하는 명령이다. 요청은 앱과 **같은 함수**(`mailRequest`)로 만든다
 * - 받지 않으면 상태 코드마다 무엇을 볼지(`statusHint`)와 응답 본문 200자(인증 값은 가린다 — A.1-9), 닿지 않으면 오류 코드(`failureHint`)를 말한다
 * - 감사에 남긴다 — `mail.send`(단계 2부터)·`mail.fail`(늘), 상세 `kind: "test"`(A.1-10). DB에 닿지 않아도 메일 시험 결과는 그대로다
 *
 * 돌려주는 값은 종료 코드다 — 보냈으면 0, 아니면 1.
 */
export async function mailTest(
  args: string[],
  env: AppEnv = loadEnv(),
  url: string = databaseUrl(env),
  out: MailTestOutput = console,
  now: () => Date = () => new Date(),
): Promise<number> {
  const parsed = emailSchema.safeParse(args[0] ?? '');
  if (args.length !== 1 || !parsed.success) {
    out.error('[mail-test] 받는 주소 하나를 적는다 — 예: pnpm mail:test someone@example.internal (운영: … run --rm tools node dist/cli/mail-test.js someone@example.internal)');
    return 1;
  }
  const to = parsed.data;
  const cfg = mailConfigOf(env);
  if (!cfg.url) {
    out.error('[mail-test] WF_MAIL_API_URL이 비었다 — 사내 메일 API의 보내는 주소 전체를 적는다(반입 가이드 "사내 메일 연결하기")');
    return 1;
  }
  out.log(`[mail-test] 주소: ${cfg.url}`);
  out.log(`[mail-test] 형식: ${cfg.format} · 보내는 이름: ${cfg.senderName} · 인증: ${cfg.authHeader ? `${cfg.authHeader} 헤더(값은 가린다)` : '없음'}`);
  // 주소는 형식마다 하나다(A.1-4) — 형식과 주소가 어긋나 보이면 알린다(막지는 않는다 — 현장의 주소 모양은 다를 수 있다)
  const markdownPath = /markdown/i.test(new URL(cfg.url).pathname);
  if (cfg.format === 'markdown' && !markdownPath) out.log('[mail-test] 주의: 형식이 markdown인데 주소에 markdown이 없다 — …/send_markdown을 적었는지 본다');
  if (cfg.format === 'text' && markdownPath) out.log('[mail-test] 주의: 형식이 text인데 주소가 markdown 쪽이다 — WF_MAIL_FORMAT=markdown이거나 …/send를 적는다');
  out.log(
    `[mail-test] 지금 앱은 ${
      !env.WF_MAIL_ENABLED ? '메일을 보내지 않는다(WF_MAIL_ENABLED=false — 이 시험이 되면 켠다)' : env.WF_MAIL_MOCK ? '모의 발송이다(보내지 않는다 — WF_MAIL_MOCK=false로)' : '메일을 보낸다'
    }`,
  );

  const req = mailRequest(cfg, { to, ...testMail(now().toISOString()) });
  let ok = false;
  try {
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, redirect: 'error', signal: AbortSignal.timeout(MAIL_TIMEOUT_MS) });
    const body = await res.text().catch(() => '');
    if (res.ok) {
      ok = true;
      out.log(`[mail-test] 보냈다 — HTTP ${res.status}. ${to}의 메일함에서 "[위키] 시험 메일"을 찾는다(보이지 않으면 스팸함도)`);
    } else {
      out.error(`[mail-test] 받지 않았다 — HTTP ${res.status}. ${statusHint(res.status)}`);
      const snippet = hideSecret(body, cfg.authValue).replace(/\s+/g, ' ').trim().slice(0, RESPONSE_SNIPPET_MAX);
      if (snippet) out.error(`[mail-test] 응답: ${snippet}`);
    }
  } catch (e) {
    out.error(`[mail-test] 보내지 못했다 — ${failureHint(e)}`);
  }
  await recordAudit(env, url, ok, out);
  return ok ? 0 : 1;
}

/** 감사 기록 — 휴지통 정리 명령처럼 소유 계정으로 직접 넣는다. 감사 기록 단계는 운영 설정의 값을 따른다(P17) */
async function recordAudit(env: AppEnv, url: string, ok: boolean, out: MailTestOutput): Promise<void> {
  const action = ok ? 'mail.send' : 'mail.fail';
  const c = new Client(url);
  try {
    await c.connect();
    const stored = await c.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [SETTINGS_KEYS.policy]);
    const policy = applyPolicy((stored.rows[0]?.value as Record<string, unknown>) ?? {});
    if (!auditRecorded(action, policy.auditLevel)) {
      out.log(`[mail-test] 감사 기록 단계 ${policy.auditLevel}이라 성공한 시험은 감사로그에 남기지 않는다`);
      return;
    }
    await c.query(`INSERT INTO audit_events (action, target_type, detail) VALUES ($1, 'system', $2)`, [
      action,
      JSON.stringify({ kind: 'test', recipients: 1, sent: ok ? 1 : 0 }),
    ]);
    out.log(`[mail-test] 감사로그에 ${action}로 남겼다 (${describeDatabaseUrl(url)})`);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    out.error(`[mail-test] 감사로그에 남기지 못했다${typeof code === 'string' ? ` (${code})` : ''} — 메일 시험의 결과는 위와 같다`);
  } finally {
    await c.end().catch(() => undefined);
  }
}

/**
 * **컨테이너에서 도는 입구** (P13 D.2와 같은 모양). 운영 서버에는 Node도 저장소도 없어 앱 이미지 안의 이 파일을 compose의 `tools`로 부른다 —
 * `docker compose … run --rm tools node dist/cli/mail-test.js <받는 주소>`. 개발 명령(`pnpm mail:test <받는 주소>`)은 `scripts/mail-test.ts`를 거쳐 같은 함수를 부른다
 */
if (require.main === module) {
  mailTest(process.argv.slice(2))
    .then((code) => (process.exitCode = code))
    .catch((e: unknown) => {
      console.error(e);
      process.exitCode = 1;
    });
}
