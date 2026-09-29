import { BACKGROUND_HEADER, BACKGROUND_HEADER_VALUE } from '@workfluence/shared';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, openTestDb } from '../test/db';
import { sessionMiddleware } from './session-middleware';

/**
 * 통합(실제 PostgreSQL) — **배경 요청은 세션을 늘리지 않는다** (P17 병합 전 검토). 알림 영역이 30초마다 안 읽은 수를 묻는다(FR-1800). 그 요청이
 * 세션을 늘리면 열어 둔 탭이 자리를 비워도 유휴 만료가 오지 않는다(`CLAUDE.md` 7절의 유휴 30분). 판정은 `sessions.expire`와 `Set-Cookie`로 본다 —
 * 여느 요청은 만료를 밀고 쿠키를 다시 보낸다(rolling), 배경 요청은 둘 다 하지 않는다.
 */
let pool: Pool;
let server: Server;
let base = '';

beforeAll(async () => {
  ({ pool } = await openTestDb());
  const app = express();
  app.use(sessionMiddleware(pool, { WF_SESSION_SECRET: 'test-session-secret-not-real', WF_ENV: 'test', WF_SESSION_IDLE_MINUTES: 30 }));
  app.post('/login', (req, res) => {
    req.session.userId = 'u-session-middleware';
    res.json({ ok: true });
  });
  app.get('/ping', (req, res) => {
    // 가드처럼 쿠키의 maxAge를 다시 얹는다 — 세션이 바뀐 것으로 치지 않아 저장(set)이 일어나지 않는다
    if (req.session.cookie) req.session.cookie.maxAge = 30 * 60_000;
    res.json({ userId: req.session.userId ?? null });
  });
  await new Promise<void>((ok) => {
    server = app.listen(0, '127.0.0.1', () => ok());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  await closeTestDb();
});

async function expireOf(sid: string): Promise<number> {
  const r = await pool.query<{ expire: Date }>('SELECT expire FROM sessions WHERE sid = $1', [sid]);
  return r.rows[0].expire.getTime();
}

const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

describe('세션 미들웨어 — 배경 요청은 세션을 늘리지 않는다', () => {
  it('여느 요청은 만료를 밀고 쿠키를 다시 보낸다, 배경 요청은 세션을 읽기만 한다', async () => {
    const login = await fetch(`${base}/login`, { method: 'POST' });
    // **본문까지 읽는다** — fetch는 머리말이 오면 끝나고, 세션 저장은 본문을 다 보내기 직전에 끝난다(읽기 전에 행을 보면 아직 없다)
    await login.text();
    const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0];
    expect(cookie).toMatch(/^wf\.sid=/);
    const sid = decodeURIComponent(cookie.slice('wf.sid='.length)).replace(/^s:/, '').split('.')[0];
    const first = await expireOf(sid);

    // 배경 요청 — 세션은 읽힌다(가드가 사용자를 안다), 만료는 그대로, 쿠키를 다시 보내지 않는다
    await pause(1100);
    const bg = await fetch(`${base}/ping`, { headers: { cookie, [BACKGROUND_HEADER]: BACKGROUND_HEADER_VALUE } });
    expect(await bg.json()).toEqual({ userId: 'u-session-middleware' });
    expect(bg.headers.get('set-cookie')).toBeNull();
    expect(await expireOf(sid)).toBe(first);

    // 여느 요청 — 만료가 밀리고 쿠키가 다시 온다(rolling). 이것이 **먼저 참인 단언이 아님**을 보인다: 같은 간격 뒤에 값이 바뀐다
    await pause(1100);
    const normal = await fetch(`${base}/ping`, { headers: { cookie } });
    expect(await normal.json()).toEqual({ userId: 'u-session-middleware' });
    expect(normal.headers.get('set-cookie')).toMatch(/^wf\.sid=/);
    expect(await expireOf(sid)).toBeGreaterThan(first);
  });

  it('표시 값이 다르면 여느 요청이다 — 배경으로 치는 것은 정해 둔 값뿐이다', async () => {
    const login = await fetch(`${base}/login`, { method: 'POST' });
    // **본문까지 읽는다** — fetch는 머리말이 오면 끝나고, 세션 저장은 본문을 다 보내기 직전에 끝난다(읽기 전에 행을 보면 아직 없다)
    await login.text();
    const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0];
    const sid = decodeURIComponent(cookie.slice('wf.sid='.length)).replace(/^s:/, '').split('.')[0];
    const first = await expireOf(sid);
    await pause(1100);
    await (await fetch(`${base}/ping`, { headers: { cookie, [BACKGROUND_HEADER]: 'yes' } })).text();
    expect(await expireOf(sid)).toBeGreaterThan(first);
  });
});
