import { BACKGROUND_HEADER, BACKGROUND_HEADER_VALUE, type AppEnv } from '@workfluence/shared';
import connectPgSimple from 'connect-pg-simple';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import session from 'express-session';
import type { Pool } from 'pg';
import { SESSION_COOKIE } from '../pages/collab/session-auth';

type SessionEnv = Pick<AppEnv, 'WF_SESSION_SECRET' | 'WF_ENV' | 'WF_SESSION_IDLE_MINUTES'>;

/**
 * 서버측 세션 (FR-220~223). 저장소는 PG이고 **앱과 같은 풀을 재사용한다** (P0 13절 인계).
 *
 * - 쿠키 maxAge = 유휴 타임아웃. `rolling`이 요청마다 갱신한다
 * - **절대 타임아웃은 쿠키로 못 지킨다** — rolling이 갱신해 버리므로 AuthGuard가 본다
 * - 테이블은 마이그레이션이 만든다. createTableIfMissing을 켜면 스키마가 두 곳에서 관리된다
 *
 * **배경 요청은 세션을 늘리지 않는다** (P17 병합 전 검토 — self-reviewer·코드 리뷰·보안 검토가 따로 찾았다). 모든 화면의 알림 영역이 30초마다
 * 안 읽은 수를 묻는다(FR-1800). 그 요청이 여느 요청처럼 세션을 늘리면 열어 둔 탭이 자리를 비워도 유휴 만료(30분)가 오지 않고 절대 만료(12시간)까지
 * 산다 — 실시간 편집도 "열어만 둔 탭은 이어 주지 않는다"(P7 `collab.gateway.ts`)로 막아 둔 일이다. 그래서 `BACKGROUND_HEADER`가 붙은 요청은
 * **rolling을 끄고 `touch`를 하지 않는 저장소**를 쓰는 두 번째 세션 미들웨어로 보낸다 — 세션을 읽고 가드가 확인하는 것은 같고, 쿠키를 다시 보내지
 * 않고 `sessions.expire`를 밀지 않는다. express-session은 rolling과 무관하게 응답마다 `store.touch`를 부르므로 rolling만 끄면 모자라다.
 * 세션 내용을 바꾸는 요청이면 저장(`set`)이 만료를 새로 쓴다 — 알림 수를 묻는 요청은 세션을 바꾸지 않는다(가드가 얹는 `cookie.maxAge`는 바뀐 것으로 치지 않는다)
 */
export function sessionMiddleware(pool: Pool, env: SessionEnv): RequestHandler {
  const PgStore = connectPgSimple(session);
  const base = {
    name: SESSION_COOKIE,
    secret: env.WF_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: env.WF_ENV === 'production',
      maxAge: env.WF_SESSION_IDLE_MINUTES * 60_000,
    },
  };
  const normal = session({ ...base, rolling: true, store: new PgStore({ pool, tableName: 'sessions', createTableIfMissing: false }) });
  // 오래된 행 지우기(15분마다)는 위의 저장소가 한다 — 둘이 같은 일을 하지 않게 끈다
  const quietStore = new PgStore({ pool, tableName: 'sessions', createTableIfMissing: false, pruneSessionInterval: false });
  quietStore.touch = (_sid, _sess, callback) => callback?.();
  const quiet = session({ ...base, rolling: false, store: quietStore });
  return (req: Request, res: Response, next: NextFunction) =>
    (req.headers[BACKGROUND_HEADER] === BACKGROUND_HEADER_VALUE ? quiet : normal)(req, res, next);
}
