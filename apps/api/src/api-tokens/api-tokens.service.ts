import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  API_TOKEN_LIMITS,
  normalizeScopes,
  resolveTokenExpiry,
  tokenRowProblem,
  tokenUserProblem,
  type ApiTokenProblem,
  type ApiTokenScope,
  type ApiTokenView,
  type CreateApiTokenDto,
  type Principal,
} from '@workfluence/shared';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { toSessionUser, type SessionUser } from '../auth/auth.guard';
import { logLine } from '../common/log-line';
import { RevocationBus } from '../common/revocation.bus';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { DB, type Db } from '../db/db.module';
import { apiTokens, users, type ApiTokenRowDb } from '../db/schema';
import { UsersService } from '../users/users.service';
import { signApiToken, verifyApiToken } from './domain/jwt';

export type ApiAuthResult =
  | { ok: true; user: SessionUser; scopes: ApiTokenScope[]; tokenId: string }
  | { ok: false; code: ApiTokenProblem | 'API_DISABLED' };

type RevokeReason = 'user' | 'admin' | 'sessions_revoked';

/** JWT의 시각은 초 단위다 — 행의 시각도 초로 맞춰 둘이 같은 순간을 가리키게 한다 */
const toSecond = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);

function toView(row: ApiTokenRowDb, now: Date): ApiTokenView {
  const status = row.revokedAt ? 'revoked' : row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'active';
  return {
    id: row.id,
    name: row.name,
    scopes: normalizeScopes(row.scopes as ApiTokenScope[]),
    status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/**
 * 공개 API 토큰 — 발급·목록·폐기·인증 (docs/spinoff/public-api 계획서 4.1절).
 *
 * **세션을 모두 끊는 통지가 오면 그 사람의 토큰도 모두 폐기한다**(분석서 G3) — 비밀번호 변경·관리자 강제 종료·정지·관리자 초기화가 `sid` 없이
 * 부른다. 로그아웃은 그 브라우저의 세션 하나(`sid`)라 토큰을 건드리지 않는다. 정지는 통지보다 먼저 인증이 막는다(사용자 행을 요청마다 본다).
 */
@Injectable()
export class ApiTokensService implements OnModuleDestroy {
  private readonly log = new Logger('ApiTokens');
  private readonly unsubscribe: () => void;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly users: UsersService,
    bus: RevocationBus,
    @Inject(APP_ENV) private readonly env: Pick<AppEnvToken, 'WF_API_JWT_SECRET'>,
  ) {
    this.unsubscribe = bus.onRevoke((userId, sid) => {
      if (sid !== undefined) return;
      this.revokeAllFor(userId, new Date()).catch((e: unknown) => {
        this.log.warn(logLine('session.revoke_failed', 'API 토큰 폐기 실패', { targetUserId: userId }, e));
      });
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe();
  }

  get enabled(): boolean {
    return this.env.WF_API_JWT_SECRET !== '';
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new ServiceUnavailableException({ code: 'API_DISABLED', message: '공개 API가 꺼져 있다 (WF_API_JWT_SECRET)' });
  }

  async create(userId: string, dto: CreateApiTokenDto, ip: string | null, now = new Date()): Promise<{ token: string; view: ApiTokenView }> {
    this.assertEnabled();
    const at = toSecond(now);
    const exp = resolveTokenExpiry(at, dto.expiresInDays, API_TOKEN_LIMITS.maxDays);
    if (!exp.ok) throw new BadRequestException({ code: exp.code, message: `만료는 ${exp.maxDays}일까지다`, maxDays: exp.maxDays });

    return this.db.transaction(async (tx) => {
      // 한 사람의 발급을 줄 세운다 — 동시에 둘이 9개를 보고 함께 넣으면 11개가 된다
      await tx.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} FOR NO KEY UPDATE`);
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt), gt(apiTokens.expiresAt, at)));
      if (n >= API_TOKEN_LIMITS.maxPerUser) {
        throw new ConflictException({ code: 'TOKEN_LIMIT', message: `살아 있는 토큰은 ${API_TOKEN_LIMITS.maxPerUser}개까지다`, max: API_TOKEN_LIMITS.maxPerUser });
      }
      const [row] = await tx
        .insert(apiTokens)
        .values({ userId, name: dto.name, scopes: dto.scopes, createdAt: at, expiresAt: exp.expiresAt })
        .returning();
      const token = await signApiToken({ userId, tokenId: row!.id, scopes: dto.scopes, issuedAt: at, expiresAt: exp.expiresAt }, this.env.WF_API_JWT_SECRET);
      await this.audit.record(
        {
          action: 'api_token.create',
          actorId: userId,
          targetType: 'api_token',
          targetId: row!.id,
          detail: { name: dto.name, scopes: dto.scopes, expiresAt: exp.expiresAt.toISOString() },
          ip,
        },
        tx,
      );
      return { token, view: toView(row!, at) };
    });
  }

  async list(userId: string, now = new Date()): Promise<ApiTokenView[]> {
    const rows = await this.db.select().from(apiTokens).where(eq(apiTokens.userId, userId)).orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
    return rows.map((r) => toView(r, now));
  }

  /** 내 토큰만. 남의 것과 없는 것은 같은 404다. 이미 폐기된 것은 그대로 돌려준다(감사는 한 번) */
  async revoke(userId: string, tokenId: string, ip: string | null, now = new Date()): Promise<ApiTokenView> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
        .for('update');
      if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: '토큰을 찾을 수 없다' });
      if (row.revokedAt) return toView(row, now);
      const [done] = await tx.update(apiTokens).set({ revokedAt: now, revokedReason: 'user' satisfies RevokeReason }).where(eq(apiTokens.id, tokenId)).returning();
      await this.audit.record({ action: 'api_token.revoke', actorId: userId, targetType: 'api_token', targetId: tokenId, detail: { name: row.name, reason: 'user' }, ip }, tx);
      return toView(done!, now);
    });
  }

  /**
   * 관리자가 남의 토큰 목록을 본다(사용자 관리). **그 사람을 관리할 수 있어야 한다**(`assertManageable` — 역할과 위임까지). 값은 없다
   */
  async listForUser(actor: Principal, userId: string, now = new Date()): Promise<ApiTokenView[]> {
    await this.users.assertManageable(userId, actor);
    return this.list(userId, now);
  }

  /**
   * 관리자가 남의 토큰을 폐기한다(사용자 관리 — 새어 나간 토큰을 그 자리에서 죽인다). 감사에는 **폐기한 사람**이 남는다. 그 사람의 토큰이 아니면 404 —
   * 다른 사람 주소에 남의 토큰 id를 끼워도 폐기되지 않는다. 이미 폐기된 것은 그대로 돌려준다(감사는 한 번)
   */
  async revokeForUser(actor: Principal, userId: string, tokenId: string, ip: string | null, now = new Date()): Promise<ApiTokenView> {
    return this.db.transaction(async (tx) => {
      await this.users.assertManageable(userId, actor, tx);
      const [row] = await tx
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
        .for('update');
      if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: '토큰을 찾을 수 없다' });
      if (row.revokedAt) return toView(row, now);
      const [done] = await tx.update(apiTokens).set({ revokedAt: now, revokedReason: 'admin' satisfies RevokeReason }).where(eq(apiTokens.id, tokenId)).returning();
      await this.audit.record(
        { action: 'api_token.revoke', actorId: actor.id, targetType: 'api_token', targetId: tokenId, detail: { name: row.name, userId, reason: 'admin' }, ip },
        tx,
      );
      return toView(done!, now);
    });
  }

  /** 세션을 모두 끊을 때 함께 (G3). 누가 끊었는지는 그 동작의 감사가 말한다 — 여기는 까닭만 */
  async revokeAllFor(userId: string, now: Date): Promise<number> {
    return this.db.transaction(async (tx) => {
      const done = await tx
        .update(apiTokens)
        .set({ revokedAt: now, revokedReason: 'sessions_revoked' satisfies RevokeReason })
        .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
        .returning();
      for (const r of done) {
        await this.audit.record(
          { action: 'api_token.revoke', actorId: null, targetType: 'api_token', targetId: r.id, detail: { name: r.name, userId, reason: 'sessions_revoked' } },
          tx,
        );
      }
      return done.length;
    });
  }

  async authenticate(jwt: string, now = new Date()): Promise<ApiAuthResult> {
    if (!this.enabled) return { ok: false, code: 'API_DISABLED' };
    const claims = await verifyApiToken(jwt, this.env.WF_API_JWT_SECRET, now);
    if (!claims.ok) return { ok: false, code: claims.code };

    const [row] = await this.db.select().from(apiTokens).where(eq(apiTokens.id, claims.tokenId));
    const rowProblem = tokenRowProblem(row ?? null, claims, now);
    if (rowProblem) return { ok: false, code: rowProblem };

    const user = await this.users.findById(claims.userId);
    const userProblem = tokenUserProblem(user ?? null);
    if (userProblem || !user) return { ok: false, code: userProblem ?? 'ACCOUNT_INACTIVE' };

    const stale = new Date(now.getTime() - API_TOKEN_LIMITS.lastUsedResolutionSec * 1000);
    await this.db
      .update(apiTokens)
      .set({ lastUsedAt: now })
      .where(and(eq(apiTokens.id, claims.tokenId), or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, stale))));

    // 서명된 scope와 행의 scope가 둘 다 허락한 것만 — 둘은 같아야 하지만 행이 정본이다
    const scopes = claims.scopes.filter((s) => row!.scopes.includes(s));
    return { ok: true, user: toSessionUser(user), scopes, tokenId: claims.tokenId };
  }
}
