import { BadGatewayException, BadRequestException, HttpException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  maskEmail,
  maskUsername,
  grantsForRole,
  type ChangePasswordDto,
  type DelegableAction,
  type FindIdDto,
  type LoginDto,
  type MeView,
  type RecoverPasswordDto,
  type Role,
  type SignupDto,
} from '@workfluence/shared';
import { createHash, randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { logLine } from '../common/log-line';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { DB, type Db } from '../db/db.module';
import { users, type UserRow } from '../db/schema';
import { NotificationsService } from '../notifications/notifications.service';
import { SpacesService } from '../spaces/spaces.service';
import { UsersService } from '../users/users.service';
import { safeDisplayName } from './domain/display-name';
import { mapGroupsToRole } from './domain/claims';
import { idpFailureKind } from './domain/idp-failure';
import { KeyedSerial } from './domain/keyed-serial';
import { OIDC_PROVIDER, type OidcClaims, type OidcProvider, type PkcePair } from './oidc/oidc.provider';

/** 로그인 실패는 **사유를 구분하지 않는다** (FR-206). 이 문구 하나만 나간다. */
const LOGIN_FAILED = '아이디 또는 비밀번호가 올바르지 않다';

export function newPkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function toMeView(u: UserRow): MeView {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role as Role,
    mustChangePassword: u.mustChangePassword,
    grants: grantsForRole(u.role as Role, u.grants),
    hasPassword: u.passwordHash !== null,
  };
}

/** 사내 계정 로그인에서 정지된 계정을 만났다 — 트랜잭션을 되돌리고 감사를 남기려고 던진다 (P13 FR-1443) */
class SuspendedAccount extends Error {
  constructor(readonly userId: string) {
    super('정지된 계정');
  }
}

@Injectable()
export class AuthService {
  private readonly log = new Logger('Auth');

  /** 한 계정씩 로그인을 줄 세운다 (P13 FR-1431) — 프로세스에 하나. 앱 서버는 한 대다 */
  private readonly loginSerial = new KeyedSerial();

  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly spaces: SpacesService,
    private readonly notifications: NotificationsService,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProvider | null,
  ) {}

  // ---- 로컬 ----

  /**
   * FR-202·205·206. 실패해도 감사로그는 남긴다.
   *
   * **비밀번호 확인은 트랜잭션 밖에서 한다** (P13 FR-1430, 보류 16). 연결을 쥔 채 argon2를 돌리면 로그인이 몰릴 때 연결 풀이 모두
   * "idle in transaction"이 되어 남의 요청이 기다렸다. **잠금과 기록은 같은 트랜잭션에 둔다** (FR-236) — 따로 두면 한쪽만 반영돼
   * "잠겼는데 기록이 없다" 또는 그 반대가 생긴다.
   */
  /**
   * 로컬 로그인. `begin`은 **세션을 만드는 일**이다 — 들어왔을 때 줄 안에서 부른다(병합 전 검토). 비밀번호 변경이 같은 줄에 서므로, 변경은
   * 이 세션이 생긴 뒤에 돌아 그것까지 지운다. 줄 밖에서 만들면 적은 뒤와 만들기 전 사이에 변경이 끼어, 지운 뒤에 세션이 생긴다
   */
  async login(dto: LoginDto, ip?: string, begin?: (user: UserRow) => Promise<void>): Promise<UserRow> {
    // **한 계정씩 줄을 선다** (P13 FR-1431). 확인과 기록이 한 사람씩이라, 동시에 틀린 N건이 와도 확인까지 가는 것은 잠금 기준만큼이다.
    // 줄에서 기다리는 동안 연결을 쥐지 않는다
    const result = await this.loginSerial.run(dto.username, async () => {
      const now = new Date();
      const check = await this.users.checkCredentials(dto.username, dto.password, now);
      const settled = await this.db.transaction(async (tx) => {
        const r = await this.users.settleCredentials(check, now, tx);
        if (!r.ok) {
          await this.audit.record(
            // 사유는 응답에 쓰지 않는다. 운영자가 나중에 볼 수 있게 기록에만 남긴다
            { action: 'auth.login.failure', targetType: 'username', targetId: dto.username, detail: { reason: r.reason }, ip },
            tx,
          );
        } else {
          await this.audit.record({ action: 'auth.login.success', actorId: r.user.id, detail: { method: 'local' }, ip }, tx);
        }
        return r;
      });
      if (settled.ok && begin) await begin(settled.user);
      return settled;
    });
    if (!result.ok) throw new UnauthorizedException(LOGIN_FAILED);
    return result.user;
  }

  async signup(dto: SignupDto, ip?: string): Promise<void> {
    // 해시는 트랜잭션을 열기 전에 (P13 FR-1434)
    const passwordHash = await this.users.preparePassword(dto.password);
    await this.db.transaction(async (tx) => {
      const row = await this.users.signup(dto, tx, passwordHash);
      await this.audit.record(
        { action: 'user.signup', targetType: 'user', targetId: row.id, detail: { username: row.username, email: dto.email }, ip },
        tx,
      );
    });
  }

  /**
   * ID 찾기 (FR-208). email+이름이 모두 맞을 때만 **마스킹된** ID를 준다.
   * 맞지 않아도 404가 아니라 같은 모양으로 답한다 — 존재 여부가 새어 나가지 않게.
   */
  async findId(dto: FindIdDto, ip?: string): Promise<{ username: string | null }> {
    const user = await this.users.findByEmailAndName(dto.email, dto.displayName);
    // target_id에도 마스킹한 값을 넣는다. detail만 가리고 여기에 원본을 두면 가린 의미가 없다 (FR-238)
    await this.audit.record({ action: 'auth.id.recover', targetType: 'email', targetId: maskEmail(dto.email), detail: { found: !!user }, ip });
    return { username: user ? maskUsername(user.username) : null };
  }

  /**
   * 비밀번호 찾기 요청 (FR-209a). **비밀번호를 발급하지 않는다.**
   *
   * 미인증 경로에서 비밀번호를 바꿔 주면 "아이디와 사내 email을 아는 사람"이 곧 계정
   * 소유자가 된다. 둘 다 위키에서 사실상 공개 정보다. 메일 같은 대역 외 전달 수단이 없는
   * 폐쇄망에서는 자가 재설정을 안전하게 만들 수 없으므로 **요청만 기록하고 관리자에게 보낸다.**
   *
   * 응답은 일치 여부와 무관하게 항상 같다 — 여기서 갈라지면 계정 열거가 된다.
   *
   * 맞는 계정이면 **그 사람을 관리할 수 있는 관리자에게 알린다** (P17 F-010 8번) — 예전에는 감사로그에만 남아 관리자가 알 길이 없었다.
   * 알림은 **기다리지 않는다**: 응답이 알림을 만드는 동안 늦어지면 걸린 시간이 "그런 계정이 있다"를 말한다
   */
  async recoverPassword(dto: RecoverPasswordDto, ip?: string): Promise<{ ok: true }> {
    const user = await this.users.findRecoveryTarget(dto.username, dto.email);
    await this.audit.record({
      action: 'auth.password.recover',
      actorId: user?.id ?? null,
      targetType: 'username',
      targetId: dto.username,
      // 관리자가 "이 요청이 실제 계정에 대한 것이었나"를 볼 수 있어야 초기화를 판단한다
      detail: { found: !!user, requested: true },
      ip,
    });
    // **비밀번호가 있는 계정만 알린다** — 사내 계정(IdP)은 관리자가 초기화할 수 없어 알림이 영영 처리되지 않는다(병합 전 검토). 응답·감사는 같다
    if (user && user.passwordHash !== null) this.alertManagers(user);
    return { ok: true };
  }

  /**
   * 초기화 요청을 관리자에게 알린다 — 응답과 따로 돈다(`recoverPassword`). 실패는 우리 쪽 결함이라 error 한 줄이다
   * (`auth.recover_notify_failed`) — 요청은 감사 기록(`auth.password.recover`)에 이미 남았다
   */
  private alertManagers(user: UserRow): void {
    void this.notifications.notifyPasswordResetRequest({ id: user.id, role: user.role as Role, grants: user.grants }).catch((e: unknown) => {
      this.log.error(logLine('auth.recover_notify_failed', '비밀번호 초기화 요청을 관리자에게 알리지 못했다', { userId: user.id }, e));
    });
  }

  async changePassword(userId: string, dto: ChangePasswordDto, ip?: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('사용자를 찾을 수 없다');
    // **그 계정의 로그인과 같은 줄에 선다** (병합 전 검토). 줄 밖에서 바꾸면, 옛 비밀번호로 확인 중이던 로그인이 변경이 세션을 모두 지운
    // 뒤에 세션을 만든다 — 침해를 알아채고 바꾼 비밀번호가 공격자의 세션을 남긴다. 로그인은 아이디가 정확히 같아야 들어오므로 열쇠가 같다
    await this.loginSerial.run(user.username, async () => {
      // 지금 비밀번호 확인과 새 해시는 트랜잭션을 열기 전에 (P13 FR-1434)
      const prepared = await this.users.prepareChangePassword(userId, dto.currentPassword, dto.newPassword);
      await this.db.transaction(async (tx) => {
        await this.users.changePassword(userId, dto.currentPassword, dto.newPassword, tx, prepared);
        await this.audit.record({ action: 'auth.password.change', actorId: userId, ip }, tx);
      });
      // **편집 연결에 알리는 것은 커밋한 뒤에** (좁은 자체 점검 5 — 정지·강제 종료와 같다, `UsersService.destroyAllSessions`)
      this.users.revokeConnections(userId);
    });
  }

  async logout(userId: string | undefined, ip?: string): Promise<void> {
    if (userId) await this.audit.record({ action: 'auth.logout', actorId: userId, ip });
  }

  // ---- OIDC ----

  private provider(): OidcProvider {
    if (!this.env.WF_OIDC_ENABLED || !this.oidc) throw new NotFoundException('OIDC가 꺼져 있다');
    return this.oidc;
  }

  /** 인가 URL과 세션에 보관할 일회용 값들 (FR-211, FR-212) */
  async oidcStart(): Promise<{ url: string; state: string; nonce: string; verifier?: string }> {
    const p = this.provider();
    const state = randomBytes(16).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const pkce = this.env.WF_OIDC_PKCE ? newPkce() : undefined;
    const url = await this.idp('start', () => p.authorizationUrl(state, nonce, pkce));
    return { url, state, nonce, verifier: pkce?.verifier };
  }

  /**
   * 사내 IdP와의 처리 (P11 FR-1215, 코드 리뷰 8). **실패는 바깥 탓이라 warn 한 줄**(`auth.oidc_failed` — 단계·오류). 예전에는 IdP에 닿지
   * 않으면(Discovery·TLS·JWKS) 처리되지 않은 예외(500, `http.unhandled` error)였고, 토큰 교환의 거절은 로그에 아무것도 없었다.
   *
   * - **거절**은 401 — 우리가 판정한 것(`HttpException` — 토큰 교환 실패·nonce 불일치 등)은 그대로, id_token을 받아들이지 않은 것(jose의
   *   서명·iss·aud·exp — `idpFailureKind`)은 401로. 다시 해도 같으니 "잠시 뒤 다시"라고 하지 않는다 (종료 루틴 자체 점검 1)
   * - **닿지 않음**은 502 — 망·TLS·Discovery. 사내 CA를 믿지 못하는 것(반입 가이드 10절 ②)이 여기서 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`로 보인다
   * - **콜백의 실패는 로그인 실패다** — 감사 `auth.login.failure`(6절 "인증 성공·실패"). 시작의 실패는 IdP에 가 보지도 못한 것이라 남기지 않는다
   */
  private async idp<T>(step: 'start' | 'callback', run: () => Promise<T>, ip?: string): Promise<T> {
    try {
      return await run();
    } catch (e) {
      this.log.warn(logLine('auth.oidc_failed', '사내 인증 서버와의 처리가 실패했다', { step }, e));
      const kind = e instanceof HttpException ? 'rejected' : idpFailureKind((e as { code?: unknown } | null)?.code);
      if (step === 'callback') {
        await this.audit.record({ action: 'auth.login.failure', detail: { method: 'oidc', reason: kind === 'rejected' ? 'idp_rejected' : 'idp_unreachable' }, ip });
      }
      if (e instanceof HttpException) throw e;
      if (kind === 'rejected') throw new UnauthorizedException('사내 인증이 보낸 토큰을 받아들이지 못했다 — 관리자에게 알린다');
      throw new BadGatewayException('사내 인증 서버와 처리하지 못했다 — 잠시 뒤 다시 로그인한다. 계속되면 관리자에게 알린다');
    }
  }

  /**
   * 콜백 (FR-213·215·216·217·218).
   * 세션에 넣어 둔 state와 대조하고, 클레임을 역할로 접어 계정을 찾거나 만든다.
   */
  async oidcCallback(
    args: { code: string; state: string },
    saved: { state?: string; nonce?: string; verifier?: string },
    ip?: string,
  ): Promise<UserRow> {
    const p = this.provider();
    if (!saved.state || saved.state !== args.state) throw new UnauthorizedException('state가 일치하지 않는다');

    const claims = await this.idp('callback', () => p.exchange(args.code, saved.nonce ?? '', saved.verifier), ip);
    const role = mapGroupsToRole(claims.groups, this.env.WF_OIDC_ROLE_MAP);
    if (!role) {
      await this.audit.record({ action: 'auth.login.failure', targetType: 'oidc_sub', targetId: claims.sub, detail: { reason: 'no_role_mapped' }, ip });
      throw new UnauthorizedException('이 계정에 부여할 역할이 없다');
    }

    let user: UserRow;
    try {
      user = await this.db.transaction(async (tx) => {
        const { row: u, clearedGrants } = await this.upsertFromClaims(claims, role, tx);
      // IdP가 역할을 내려 위임이 사라졌으면 로그인 행에 함께 남긴다 (P11 FR-1205)
        await this.audit.record(
          { action: 'auth.login.success', actorId: u.id, detail: { method: 'oidc', ...(clearedGrants.length ? { clearedGrants } : {}) }, ip },
          tx,
        );
        return u;
      });
    } catch (e) {
      if (!(e instanceof SuspendedAccount)) throw e;
      // 정지된 계정 (P13 FR-1443). IdP가 이 사람을 확인했으므로 까닭을 말해도 계정이 새지 않는다 — 그 사람 자신의 계정이다
      await this.audit.record({ action: 'auth.login.failure', actorId: e.userId, targetType: 'oidc_sub', targetId: claims.sub, detail: { reason: 'suspended' }, ip });
      throw new UnauthorizedException('이 계정은 정지돼 있다 — 관리자에게 문의한다');
    }
    return user;
  }

  /**
   * JIT 동기화 (FR-215, FR-217). **IdP가 정본**이라 있던 계정도 갱신한다. 역할이 관리자가 아니게 되면 위임을 같은 문장에서 비운다
   * (P11 A.1-4) — 비우지 않으면 DB CHECK가 거부해 **로그인이 통째로 실패한다**
   */
  private async upsertFromClaims(claims: OidcClaims, role: Role, tx: Db): Promise<{ row: UserRow; clearedGrants: DelegableAction[] }> {
    // **조회도 `tx`로 한다.** 트랜잭션 안에서 풀에 두 번째 연결을 달라고 하면 동시 요청이
    // 풀 크기에 닿는 순간 전원이 서로를 기다린다 (T-026)
    // **잠그고 읽는다** — 읽은 위임으로 다시 쓰므로, 그 사이 root가 바꾼 위임을 덮지 않게 (P11 코드 리뷰 4 — `lockForUpdate`)
    const existing = await this.users.lockForUpdate({ oidcSub: claims.sub }, tx);
    // **IdP가 준 값도 검증한다** (P7 보안 검토 F4). 로컬 가입은 `displayNameSchema`가
    // 줄바꿈을 막는데(FR-807) JIT 동기화는 zod를 거치지 않아 **주 로그인 경로가 그 방어를
    // 비켜 갔다.** 이 값은 멘션 메일 제목에 들어간다 — 사내 메일 API가 제목을 헤더로
    // 옮기는 순간 인젝션이 된다 (보류 18)
    const displayName = safeDisplayName(claims.preferredUsername ?? claims.sub, claims.sub);
    const email = await this.freeEmail(claims.email, existing?.id, tx);

    if (existing) {
      // **정지된 계정은 되살리지 않는다** (P13 FR-1443). 예전에는 사내 계정으로 로그인할 때마다 상태를 활성으로 덮어써, 정지해도
      // IdP로 다시 들어오면 되살아났다
      if (existing.status === 'suspended') throw new SuspendedAccount(existing.id);
      const before = grantsForRole(existing.role as Role, existing.grants);
      const grants = grantsForRole(role, before);
      const [row] = await tx
        .update(users)
        .set({ displayName, email, role, grants, status: 'active', updatedAt: sql`now()` })
        .where(eq(users.id, existing.id))
        .returning();
      return { row, clearedGrants: before.filter((g) => !grants.includes(g)) };
    }

    const [row] = await tx
      .insert(users)
      .values({
        username: await this.freeUsername(claims.preferredUsername ?? claims.sub, tx),
        displayName,
        email,
        // password_hash를 비워 둔다 — IdP 계정은 비밀번호로 로그인할 수 없다 (FR-217)
        passwordHash: null,
        oidcSub: claims.sub,
        role,
        status: 'active',
        approvedAt: sql`now()`,
      })
      .returning();
    // IdP 계정도 쓸 공간이 필요하다 (FR-309). **운영의 주 로그인 경로가 여기다** —
    // 승인 경로에만 두면 IdP로 들어온 사람은 첫 화면이 비어 있다
    await this.spaces.ensurePersonalSpace(row.id, row.displayName, tx);
    return { row, clearedGrants: [] };
  }

  /**
   * 쓸 수 있는 email을 고른다.
   *
   * **로컬 계정이 이미 같은 email을 쓰고 있으면 비워 둔다.** `users_email_uq` 때문에 그대로
   * 넣으면 unique 위반으로 500이 나고, 로컬로 가입한 사람이 나중에 IdP로 들어오는 것은
   * 드문 경로가 아니다. 로그인을 막지 않고 email만 포기한다 — **계정을 자동으로 합치지는
   * 않는다**(같은 이름의 다른 사람일 수 있고 합치면 되돌릴 수 없다). 관리자가 감사로그를
   * 보고 정리하도록 남긴다.
   */
  private async freeEmail(raw: string | undefined, selfId: string | undefined, tx: Db): Promise<string | null> {
    const email = raw?.toLowerCase() ?? null;
    if (!email) return null;
    const owner = await this.users.findByEmail(email, tx);
    if (!owner || owner.id === selfId) return email;
    return null;
  }

  /**
   * 쓸 수 있는 username을 찾는다. 이미 쓰이고 있으면 뒤에 숫자를 붙인다.
   * **로컬 계정과 이름이 같아도 합치지 않는다** — 같은 이름의 다른 사람일 수 있고, 합치면 되돌릴 수 없다.
   */
  private async freeUsername(base: string, tx: Db): Promise<string> {
    const clean = base.toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'idp-user';
    for (let i = 0; i < 100; i++) {
      const candidate = i === 0 ? clean : `${clean}${i}`;
      if (!(await this.users.findByUsername(candidate, tx))) return candidate;
    }
    throw new BadRequestException('사용 가능한 사용자명을 만들지 못했다');
  }
}
