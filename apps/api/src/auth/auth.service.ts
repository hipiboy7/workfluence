import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  maskEmail,
  maskUsername,
  type ChangePasswordDto,
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
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { DB, type Db } from '../db/db.module';
import { users, type UserRow } from '../db/schema';
import { UsersService } from '../users/users.service';
import { mapGroupsToRole } from './domain/claims';
import { OIDC_PROVIDER, type OidcClaims, type OidcProvider, type PkcePair } from './oidc/oidc.provider';

/** 로그인 실패는 **사유를 구분하지 않는다** (FR-206). 이 문구 하나만 나간다. */
const LOGIN_FAILED = '아이디 또는 비밀번호가 올바르지 않다';

export function newPkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function toMeView(u: UserRow): MeView {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role as Role, mustChangePassword: u.mustChangePassword };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProvider | null,
  ) {}

  // ---- 로컬 ----

  /** FR-202·205·206. 실패해도 감사로그는 남긴다 */
  async login(dto: LoginDto, ip?: string): Promise<UserRow> {
    const result = await this.users.verifyCredentials(dto.username, dto.password);
    if (!result.ok) {
      await this.audit.record({
        action: 'auth.login.failure',
        targetType: 'username',
        targetId: dto.username,
        // 사유는 응답에 쓰지 않는다. 운영자가 나중에 볼 수 있게 기록에만 남긴다
        detail: { reason: result.reason },
        ip,
      });
      throw new UnauthorizedException(LOGIN_FAILED);
    }
    await this.audit.record({ action: 'auth.login.success', actorId: result.user.id, detail: { method: 'local' }, ip });
    return result.user;
  }

  async signup(dto: SignupDto, ip?: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.users.signup(dto, tx);
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
    return { ok: true };
  }

  async changePassword(userId: string, dto: ChangePasswordDto, ip?: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.users.changePassword(userId, dto.currentPassword, dto.newPassword, tx);
      await this.audit.record({ action: 'auth.password.change', actorId: userId, ip }, tx);
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
    const url = await p.authorizationUrl(state, nonce, pkce);
    return { url, state, nonce, verifier: pkce?.verifier };
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

    const claims = await p.exchange(args.code, saved.nonce ?? '', saved.verifier);
    const role = mapGroupsToRole(claims.groups, this.env.WF_OIDC_ROLE_MAP);
    if (!role) {
      await this.audit.record({ action: 'auth.login.failure', targetType: 'oidc_sub', targetId: claims.sub, detail: { reason: 'no_role_mapped' }, ip });
      throw new UnauthorizedException('이 계정에 부여할 역할이 없다');
    }

    const user = await this.db.transaction(async (tx) => this.upsertFromClaims(claims, role, tx));
    await this.audit.record({ action: 'auth.login.success', actorId: user.id, detail: { method: 'oidc' }, ip });
    return user;
  }

  /** JIT 동기화 (FR-215, FR-217). **IdP가 정본**이라 있던 계정도 갱신한다 */
  private async upsertFromClaims(claims: OidcClaims, role: Role, tx: Db): Promise<UserRow> {
    const existing = await this.users.findByOidcSub(claims.sub);
    const displayName = claims.preferredUsername ?? claims.sub;
    const email = claims.email?.toLowerCase() ?? null;

    if (existing) {
      const [row] = await tx
        .update(users)
        .set({ displayName, email, role, status: 'active', updatedAt: sql`now()` })
        .where(eq(users.id, existing.id))
        .returning();
      return row;
    }

    const [row] = await tx
      .insert(users)
      .values({
        username: await this.freeUsername(claims.preferredUsername ?? claims.sub),
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
    return row;
  }

  /**
   * 쓸 수 있는 username을 찾는다. 이미 쓰이고 있으면 뒤에 숫자를 붙인다.
   * **로컬 계정과 이름이 같아도 합치지 않는다** — 같은 이름의 다른 사람일 수 있고, 합치면 되돌릴 수 없다.
   */
  private async freeUsername(base: string): Promise<string> {
    const clean = base.toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'idp-user';
    for (let i = 0; i < 100; i++) {
      const candidate = i === 0 ? clean : `${clean}${i}`;
      if (!(await this.users.findByUsername(candidate))) return candidate;
    }
    throw new BadRequestException('사용 가능한 사용자명을 만들지 못했다');
  }
}
