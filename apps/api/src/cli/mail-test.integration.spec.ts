import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SETTINGS_KEYS, type AppEnv } from '@workfluence/shared';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseUrl, loadEnv } from '../config/config.module';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { mailTest } from './mail-test';

/**
 * B등급 — **사내 메일 시험 명령** (P18_설계서_Mail FR-1905). 로컬에 가짜 사내 메일 API를 띄우고, 감사 기록은 실제 PostgreSQL(시험 DB)에 넣는다.
 * **시험 DB를 넘긴다** — 인자가 없으면 `.env`의 DB에 붙는다
 */
type Got = { url?: string; headers: IncomingHttpHeaders; body: string };
let server: Server;
let base = '';
let got: Got[] = [];
let answer: { status: number; body?: string } = { status: 200 };
let db: TestDb;
let lines: { log: string[]; error: string[] };
const out = { log: (l: string) => lines.log.push(l), error: (l: string) => lines.error.push(l) };

beforeAll(async () => {
  ({ db } = await openTestDb());
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      got.push({ url: req.url, headers: req.headers, body });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.body ?? '{"message":"Email sent successfully"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeTestDb();
});
beforeEach(async () => {
  await resetTables(db);
  got = [];
  answer = { status: 200 };
  lines = { log: [], error: [] };
});
afterEach(() => undefined);

const envFor = (over: Partial<AppEnv> = {}): AppEnv =>
  ({
    ...loadEnv(),
    WF_ENV: 'test',
    WF_MAIL_ENABLED: false,
    WF_MAIL_MOCK: true,
    WF_MAIL_API_URL: `${base}/api/v1/email/send`,
    WF_MAIL_FORMAT: 'text',
    WF_MAIL_SENDER_NAME: '위키',
    WF_MAIL_AUTH_HEADER: '',
    WF_MAIL_AUTH_VALUE: '',
    ...over,
  }) as AppEnv;
const run = (args: string[], over: Partial<AppEnv> = {}, url?: string) => {
  const env = envFor(over);
  return mailTest(args, env, url ?? databaseUrl(env), out, () => new Date('2026-09-29T08:00:00.000Z'));
};
const audits = async () =>
  (await db.execute<{ action: string; detail: unknown }>(sql`SELECT action, detail FROM audit_events ORDER BY created_at`)).rows.map((r) => [r.action, r.detail]);
const all = () => [...lines.log, ...lines.error].join('\n');

describe('mail:test — 시험 메일 한 통 (FR-1905)', () => {
  it('받는 주소가 없거나 틀리면 1 — 보내지 않고 쓰는 법을 말한다', async () => {
    expect(await run([])).toBe(1);
    expect(await run(['not-an-address'])).toBe(1);
    expect(await run(['a@example.internal', 'b@example.internal'])).toBe(1);
    expect(lines.error.join('\n')).toMatch(/받는 주소 하나/);
    expect(got).toHaveLength(0);
  });

  it('주소(WF_MAIL_API_URL)가 비면 1 — 반입 가이드를 가리킨다', async () => {
    expect(await run(['a@example.internal'], { WF_MAIL_API_URL: '' })).toBe(1);
    expect(lines.error.join('\n')).toMatch(/WF_MAIL_API_URL.*사내 메일 연결하기/);
  });

  it('**보내면 0** — 설정을 말하고, 사용자가 준 모양으로 한 통, **켜져 있지 않아도 보낸다**(A.1-8), 감사에 mail.send(kind test)', async () => {
    expect(await run(['a@example.internal'])).toBe(0);
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0].body)).toEqual({
      subject: '[위키] 시험 메일',
      content: expect.stringContaining('2026-09-29T08:00:00.000Z') as unknown,
      receivers: 'a@example.internal',
      sender_name: '위키',
    });
    expect(all()).toContain(`주소: ${base}/api/v1/email/send`);
    expect(all()).toMatch(/형식: text · 보내는 이름: 위키 · 인증: 없음/);
    expect(all()).toMatch(/지금 앱은 메일을 보내지 않는다\(WF_MAIL_ENABLED=false/);
    expect(all()).toMatch(/보냈다 — HTTP 200/);
    expect(await audits()).toEqual([['mail.send', { kind: 'test', recipients: 1, sent: 1 }]]);
  });

  it('**인증 헤더를 싣고, 값은 어디에도 보이지 않는다** — 응답이 값을 되읊어도 가린다. 받지 않으면 1과 까닭, 감사에 mail.fail', async () => {
    answer = { status: 401, body: '{"message":"invalid key k-secret-1"}' };
    expect(await run(['a@example.internal'], { WF_MAIL_AUTH_HEADER: 'X-API-Key', WF_MAIL_AUTH_VALUE: 'k-secret-1' })).toBe(1);
    expect(got[0].headers['x-api-key']).toBe('k-secret-1');
    expect(all()).toMatch(/인증: X-API-Key 헤더\(값은 가린다\)/);
    expect(all()).toMatch(/받지 않았다 — HTTP 401\. 인증을 받지 않았다/);
    expect(all()).toContain('응답: {"message":"invalid key ***"}');
    expect(all()).not.toContain('k-secret-1');
    expect(await audits()).toEqual([['mail.fail', { kind: 'test', recipients: 1, sent: 0 }]]);
  });

  it('400이면 필수 값을 보라고 말한다 — 응답 본문은 200자까지', async () => {
    answer = { status: 400, body: `{"message":"필수 파라미터 누락 ${'x'.repeat(400)}"}` };
    expect(await run(['a@example.internal'])).toBe(1);
    expect(all()).toMatch(/HTTP 400\. 필수 값이 빠졌거나/);
    const shown = lines.error.find((l) => l.includes('응답: '))!;
    expect(shown.length).toBeLessThanOrEqual('[mail-test] 응답: '.length + 200);
  });

  it('**형식이 markdown이면 마크다운 본문**, 주소에 markdown이 없으면 알린다(막지는 않는다)', async () => {
    expect(await run(['a@example.internal'], { WF_MAIL_FORMAT: 'markdown' })).toBe(0);
    expect(JSON.parse(got[0].body).content).toContain('**workfluence 위키**');
    expect(all()).toMatch(/주의: 형식이 markdown인데 주소에 markdown이 없다/);
    lines = { log: [], error: [] };
    expect(await run(['a@example.internal'], { WF_MAIL_FORMAT: 'markdown', WF_MAIL_API_URL: `${base}/api/v1/email/send_markdown` })).toBe(0);
    expect(all()).not.toMatch(/주의/);
  });

  it('닿지 않으면 1과 오류 코드 — 감사에 mail.fail', async () => {
    expect(await run(['a@example.internal'], { WF_MAIL_API_URL: 'http://127.0.0.1:1/api/v1/email/send' })).toBe(1);
    expect(all()).toMatch(/보내지 못했다 — 메일 API에 닿지 않는다/);
    expect((await audits()).map((a) => a[0])).toEqual(['mail.fail']);
  });

  it('**감사 기록 단계 1이면 성공한 시험은 남기지 않는다**(mail.send는 단계 2부터) — 실패는 늘 남는다', async () => {
    await db.execute(sql`INSERT INTO settings (key, value) VALUES (${SETTINGS_KEYS.policy}, ${JSON.stringify({ auditLevel: 1 })}::jsonb)`);
    expect(await run(['a@example.internal'])).toBe(0);
    expect(all()).toMatch(/감사 기록 단계 1이라 성공한 시험은 감사로그에 남기지 않는다/);
    answer = { status: 500 };
    expect(await run(['a@example.internal'])).toBe(1);
    expect((await audits()).map((a) => a[0])).toEqual(['mail.fail']);
  });

  it('**DB에 닿지 않아도 메일 시험 결과는 그대로다** — 감사에 남기지 못했다고만 말한다', async () => {
    expect(await run(['a@example.internal'], {}, 'postgres://nobody:nothing@127.0.0.1:1/none')).toBe(0);
    expect(all()).toMatch(/감사로그에 남기지 못했다/);
  });
});
