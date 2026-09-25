import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  can,
  canAssignRole,
  checkPasswordPolicy,
  canManageUser,
  generateTemporaryPassword,
  grantsForRole,
  type CreateUserDto,
  type DelegableAction,
  type Principal,
  type Role,
  type SignupDto,
  type UserView,
} from '@workfluence/shared';
import * as argon2 from 'argon2';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { afterFailure, afterSuccess, isLocked } from '../auth/domain/lockout';
import { RevocationBus } from '../common/revocation.bus';
import { DB, type Db } from '../db/db.module';
import { byName } from '../db/order';
import { SettingsService } from '../settings/settings.service';
import { users, type UserRow } from '../db/schema';

/**
 * 사용자 (P1_설계서_Auth 5절). B등급 — 실제 PostgreSQL로 통합 테스트한다.
 *
 * 잠금 판정은 여기서 하지 않고 `auth/domain/lockout.ts`(A등급)에 넘긴다.
 * 시간이 얽힌 판정을 서비스 안에 두면 경계를 테스트하기 어렵다.
 */

export function toUserView(u: UserRow, now: Date = new Date()): UserView {
  const locked = isLocked({ failedAttempts: u.failedAttempts, lockedUntil: u.lockedUntil }, now);
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    role: u.role as Role,
    // '잠김'은 저장값이 아니라 파생값이다 (FR-230)
    status: u.status === 'pending' ? 'pending' : locked ? 'locked' : 'active',
    mustChangePassword: u.mustChangePassword,
    grants: grantsForRole(u.role as Role, u.grants),
    createdAt: u.createdAt.toISOString(),
  };
}

export type CredentialResult = { ok: true; user: UserRow } | { ok: false; reason: 'unknown' | 'locked' | 'wrong' | 'pending' };

const hash = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });

/**
 * 어떤 비밀번호와도 맞지 않는 argon2id 해시.
 * **계정이 없을 때도 이것으로 검증을 한 번 돌린다** — 안 그러면 "없는 계정"만 빨리 답해서
 * 응답 시간으로 계정 존재가 새어 나간다 (P1_설계서_Auth 2.2절).
 */
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$QkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY';

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly revocation: RevocationBus,
  ) {}

  /**
   * 조회 도우미는 **전부 `tx`를 받는다.**
   *
   * 트랜잭션 안에서 `this.db`로 조회하면 **같은 풀에서 두 번째 연결을 달라고 한다.** 동시
   * 요청 수가 풀 크기에 닿는 순간 전원이 서로의 연결을 기다려 앱이 영구히 멈춘다 (T-026).
   * 인자를 받아 두면 호출부가 트랜잭션 안인지 밖인지에 상관없이 맞는다.
   */
  findById(id: string, tx: Db = this.db): Promise<UserRow | undefined> {
    return tx.query.users.findFirst({ where: eq(users.id, id) });
  }

  findByUsername(username: string, tx: Db = this.db): Promise<UserRow | undefined> {
    return tx.query.users.findFirst({ where: eq(users.username, username) });
  }

  findByEmail(email: string, tx: Db = this.db): Promise<UserRow | undefined> {
    return tx.query.users.findFirst({ where: eq(users.email, email.toLowerCase()) });
  }

  findByOidcSub(sub: string, tx: Db = this.db): Promise<UserRow | undefined> {
    return tx.query.users.findFirst({ where: eq(users.oidcSub, sub) });
  }

  async list(limit: number): Promise<UserView[]> {
    const rows = await this.db.select().from(users).orderBy(desc(users.createdAt)).limit(limit);
    const now = new Date();
    return rows.map((r) => toUserView(r, now));
  }

  async adminDisplayNames(): Promise<string[]> {
    const rows = await this.db
      .select({ name: users.displayName })
      .from(users)
      .where(and(inArray(users.role, ['root', 'admin']), eq(users.status, 'active')))
      .orderBy(byName(users.displayName));
    return rows.map((r) => r.name);
  }

  /**
   * 가입 가능한 값인지 본다.
   *
   * **어느 쪽이 중복인지 알려 주지 않는다.** 아이디와 email의 존재 여부를 정확히 답하면
   * 미인증 공격자가 "이 사람이 여기 있다"를 확인하는 오라클이 된다. 이 코드베이스는 다른
   * 곳에서 열거를 막고 있는데(로그인 단일 문구·ID 찾기 마스킹) 여기만 새면 의미가 없다.
   */
  private async assertUnique(username: string, email: string, tx: Db = this.db): Promise<void> {
    if ((await this.findByUsername(username, tx)) || (await this.findByEmail(email, tx))) {
      throw new ConflictException('이미 사용 중인 아이디이거나 등록된 email이다');
    }
  }

  /**
   * 그 사용자의 **모든 세션**을 파기한다 (CLAUDE.md 7절).
   *
   * `req.session.regenerate()`는 지금 요청의 세션 하나만 바꾼다. 다른 기기·다른 브라우저에
   * 남아 있는 세션은 그대로 살아 있어서, 침해를 알아채고 비밀번호를 바꿔도 공격자의 세션이
   * 만료될 때까지 끊기지 않는다. 비밀번호가 바뀌면 **전부** 끊는다.
   */
  async destroyAllSessions(userId: string, tx: Db = this.db): Promise<void> {
    await tx.execute(sql`DELETE FROM sessions WHERE sess->>'userId' = ${userId}`);
    // **세션 행을 지우는 것만으로는 부족하다.** 이미 열려 있는 편집용 WebSocket은
    // 그 행을 다시 읽지 않아 계속 살아 있다 (P6 보안 검토 발견 1). 버스로 알린다
    this.revocation.revoke(userId);
  }

  /** 가입 요청 → 승인 대기 (FR-200) */
  /**
   * 비밀번호 강도를 **살아 있는 정책값으로** 다시 본다 (FR-521).
   *
   * `passwordSchema`(zod)도 같은 판정을 하지만 그것은 **파싱 시점에 코드 기본값을 읽는다** —
   * 관리자가 화면에서 최소 길이를 올려도 거기까지는 닿지 않는다. 두 겹이 되는 것이 맞다:
   * zod는 모양을, 여기서는 운영이 정한 세기를 본다.
   */
  private async assertPasswordStrength(pw: string, tx: Db): Promise<void> {
    const p = await this.settings.get(tx);
    const violations = checkPasswordPolicy(pw, { minLength: p.passwordMinLength, minCharClasses: p.passwordMinCharClasses });
    if (violations.length) throw new BadRequestException(violations.join('; '));
  }

  async signup(dto: SignupDto, tx: Db = this.db): Promise<UserRow> {
    await this.assertPasswordStrength(dto.password, tx);
    await this.assertUnique(dto.username, dto.email, tx);
    const [row] = await tx
      .insert(users)
      .values({
        username: dto.username,
        displayName: dto.displayName,
        email: dto.email,
        passwordHash: await hash(dto.password),
        role: 'member',
        status: 'pending',
      })
      .returning();
    return row;
  }

  /** 관리자가 직접 생성 → 바로 활성 (FR-231) */
  async create(dto: CreateUserDto, actor: Principal, tx: Db = this.db): Promise<UserRow> {
    if (!canAssignRole(actor, dto.role)) throw new ForbiddenException(`'${dto.role}' 역할을 부여할 권한이 없다`);
    // **여기도 강도를 본다.** 계약(zod)이 바닥만 보게 바뀐 뒤로 이 경로만 검사가 없었다 —
    // 관리자가 만든 계정은 바로 활성이라, 비어 있으면 가장 센 계정이 가장 약한 비밀번호를 갖는다
    await this.assertPasswordStrength(dto.password, tx);
    await this.assertUnique(dto.username, dto.email, tx);
    const [row] = await tx
      .insert(users)
      .values({
        username: dto.username,
        displayName: dto.displayName,
        email: dto.email,
        passwordHash: await hash(dto.password),
        role: dto.role,
        status: 'active',
        approvedAt: sql`now()`,
        approvedBy: actor.id,
      })
      .returning();
    return row;
  }

  private async getManaged(id: string, actor: Principal, tx: Db = this.db): Promise<UserRow> {
    const target = await this.findById(id, tx);
    if (!target) throw new NotFoundException('사용자를 찾을 수 없다');
    if (!canManageUser(actor, target.role as Role)) throw new ForbiddenException('이 사용자를 관리할 권한이 없다');
    return target;
  }

  async approve(id: string, actor: Principal, tx: Db = this.db): Promise<UserRow> {
    const target = await this.getManaged(id, actor, tx);
    if (target.status !== 'pending') throw new BadRequestException('승인 대기 상태가 아니다');
    const [row] = await tx
      .update(users)
      .set({ status: 'active', approvedAt: sql`now()`, approvedBy: actor.id, updatedAt: sql`now()` })
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  async unlock(id: string, actor: Principal, tx: Db = this.db): Promise<UserRow> {
    await this.getManaged(id, actor, tx);
    const cleared = afterSuccess();
    const [row] = await tx
      .update(users)
      .set({ failedAttempts: cleared.failedAttempts, lockedUntil: cleared.lockedUntil, updatedAt: sql`now()` })
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  /** 관리자 초기화 (FR-209). 임시 비밀번호는 **돌려주기만** 하고 저장하지 않는다 */
  async resetPassword(id: string, actor: Principal, tx: Db = this.db): Promise<{ user: UserRow; temporaryPassword: string }> {
    const target = await this.getManaged(id, actor, tx);
    // IdP 계정에 비밀번호를 붙이면 IdP가 강제하던 인증(사내 MFA·정책)을 건너뛰는 옆문이 생긴다.
    // FR-217이 "IdP 계정은 비밀번호로 로그인할 수 없다"고 한 것을 초기화가 뚫으면 안 된다.
    if (target.oidcSub !== null) {
      throw new BadRequestException('사내 IdP 계정이다. 비밀번호를 부여하지 않는다 — IdP로 로그인한다');
    }
    return this.applyTemporaryPassword(id, tx);
  }

  private async applyTemporaryPassword(id: string, tx: Db = this.db): Promise<{ user: UserRow; temporaryPassword: string }> {
    const temporaryPassword = generateTemporaryPassword((max) => randomInt(max));
    const cleared = afterSuccess();
    const [user] = await tx
      .update(users)
      .set({
        passwordHash: await hash(temporaryPassword),
        mustChangePassword: true,
        failedAttempts: cleared.failedAttempts,
        lockedUntil: cleared.lockedUntil,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, id))
      .returning();
    // 초기화는 "이 계정이 탈취됐을지 모른다"는 상황에서도 쓴다. 살아 있는 세션을 남기면 안 된다
    await this.destroyAllSessions(id, tx);
    return { user, temporaryPassword };
  }

  /**
   * 역할 변경 (FR-232, FR-233). **관리자가 아니게 되면 위임을 같은 문장에서 비운다** (P11 A.1-4) — 비우지 않으면 DB CHECK가 거부한다.
   * 거둔 위임(`clearedGrants`)은 호출부가 역할 변경의 감사 행에 싣는다 (FR-1205)
   */
  async changeRole(id: string, role: Role, actor: Principal, tx: Db = this.db): Promise<{ row: UserRow; clearedGrants: DelegableAction[] }> {
    if (id === actor.id) throw new BadRequestException('자기 자신의 역할은 바꿀 수 없다');
    const target = await this.getManaged(id, actor, tx);
    if (!canAssignRole(actor, role)) throw new ForbiddenException(`'${role}' 역할을 부여할 권한이 없다`);
    // 마지막 root를 강등하면 아무도 root 권한을 되돌릴 수 없다 (FR-233). 순수 함수로 두기 어려워 여기서 센다
    if (target.role === 'root' && role !== 'root') {
      // **`tx`로 센다.** `this.db`는 풀이라, 트랜잭션 안에서 부르면 연결을 하나 쥔 채
      // 두 번째를 달라고 한다 — 동시 요청이 풀 크기에 닿으면 서로를 기다린다 (T-026).
      // 지금은 10초 뒤 500으로 끝나지만 그것은 증상을 시끄럽게 만든 것이고 원인은 이 줄이다
      const [{ n }] = await tx.select({ n: count() }).from(users).where(and(eq(users.role, 'root'), eq(users.status, 'active')));
      if (n <= 1) throw new BadRequestException('마지막 root는 강등할 수 없다');
    }
    const before = grantsForRole(target.role as Role, target.grants);
    const grants = grantsForRole(role, before);
    const [row] = await tx.update(users).set({ role, grants, updatedAt: sql`now()` }).where(eq(users.id, id)).returning();
    return { row, clearedGrants: before.filter((g) => !grants.includes(g)) };
  }

  /**
   * 위임을 주고 거둔다 (P11_설계서_Ops D.1, FR-1201~1203). **root만** — 가드가 먼저 막고 여기서 한 번 더 본다. **관리자에게만** 준다.
   * 목록 전체를 받는다(멱등). 이전·이후를 돌려준다 — 호출부가 감사 `user.grants.change`에 싣는다 (FR-1205)
   */
  async changeGrants(
    id: string,
    grants: readonly DelegableAction[],
    actor: Principal,
    tx: Db = this.db,
  ): Promise<{ row: UserRow; before: DelegableAction[]; after: DelegableAction[] }> {
    if (!can(actor, 'user.grants.change')) throw new ForbiddenException('위임은 시스템 관리자만 주고 거둔다');
    const target = await tx.query.users.findFirst({ where: eq(users.id, id) });
    if (!target) throw new NotFoundException('사용자를 찾을 수 없다');
    if (target.role !== 'admin') throw new BadRequestException('위임은 관리자에게만 준다 — 관리자가 아니다');
    const before = grantsForRole('admin', target.grants);
    const after = grantsForRole('admin', grants);
    // 읽은 뒤 역할이 바뀌었으면(다른 요청이 member로 내렸다) 아무것도 바꾸지 않는다 — 판정한 상태에서만 쓴다
    const [row] = await tx
      .update(users)
      .set({ grants: after, updatedAt: sql`now()` })
      .where(and(eq(users.id, id), eq(users.role, 'admin')))
      .returning();
    if (!row) throw new ConflictException('그 사이 역할이 바뀌었다 — 목록을 다시 본다');
    return { row, before, after };
  }

  /** ID 찾기 (FR-208): email + 이름이 **모두** 일치할 때만 */
  async findByEmailAndName(email: string, displayName: string, tx: Db = this.db): Promise<UserRow | undefined> {
    return tx.query.users.findFirst({
      where: and(eq(users.email, email.toLowerCase()), eq(users.displayName, displayName)),
    });
  }

  /**
   * 비밀번호 찾기 요청의 대상을 **조회만** 한다. 비밀번호를 바꾸지 않는다.
   *
   * **미인증 경로에서 비밀번호를 발급하지 않는다.** 아이디와 사내 email은 위키에서 사실상
   * 공개 정보라 "둘을 아는 사람 = 본인"이 성립하지 않는다. 메일 같은 대역 외 전달 수단이
   * 없는 폐쇄망에서는 자가 재설정을 안전하게 만들 방법이 없으므로 **기능을 두지 않고**
   * 관리자 초기화(인증·권한 검사가 있는 경로)로 보낸다.
   */
  async findRecoveryTarget(username: string, email: string, tx: Db = this.db): Promise<UserRow | null> {
    const user = await this.findByUsername(username, tx);
    if (!user || !user.email || user.email !== email.toLowerCase() || user.status !== 'active') return null;
    return user;
  }

  /**
   * 관리자 강제 종료 (`scope-definition` 4.1절 #4, FR-539).
   *
   * **서버측 세션을 파기한다.** 쿠키만 지우게 하면 훔친 세션이 계속 산다 — 로그아웃·비밀번호
   * 변경과 같은 판단이다 (FR-224). `sess`는 connect-pg-simple가 넣은 세션 객체 전체다.
   */
  async terminateSessions(id: string, actor: Principal, tx: Db = this.db): Promise<number> {
    const target = await this.findById(id, tx);
    if (!target) throw new NotFoundException('사용자를 찾을 수 없다');
    if (!canManageUser(actor, target.role as Role)) throw new ForbiddenException('이 사용자를 관리할 권한이 없다');
    const r = await tx.execute(sql`DELETE FROM sessions WHERE sess->>'userId' = ${id}`);
    this.revocation.revoke(id);
    return r.rowCount ?? 0;
  }

  async changePassword(id: string, currentPassword: string, newPassword: string, tx: Db = this.db): Promise<void> {
    const user = await this.findById(id, tx);
    if (!user?.passwordHash) throw new NotFoundException('사용자를 찾을 수 없다');
    if (!(await argon2.verify(user.passwordHash, currentPassword))) throw new BadRequestException('현재 비밀번호가 올바르지 않다');
    await this.assertPasswordStrength(newPassword, tx);
    await tx
      .update(users)
      .set({ passwordHash: await hash(newPassword), mustChangePassword: false, updatedAt: sql`now()` })
      .where(eq(users.id, id));
    // 비밀번호가 바뀌면 그 사용자의 세션을 전부 끊는다. 호출부가 자기 세션은 다시 만든다
    await this.destroyAllSessions(id, tx);
  }

  /**
   * 로컬 계정 검증 (FR-202, FR-205, FR-206).
   *
   * 호출부는 `reason`으로 응답을 나누지 않는다 — 전부 같은 401이다. 이 값은 **감사로그와
   * 관리자 화면에만** 쓴다.
   */
  async verifyCredentials(username: string, password: string, now: Date = new Date(), tx: Db = this.db): Promise<CredentialResult> {
    const user = await this.findByUsername(username, tx);
    if (!user || !user.passwordHash) {
      await argon2.verify(DUMMY_HASH, password).catch(() => false);
      return { ok: false, reason: 'unknown' };
    }

    const state = { failedAttempts: user.failedAttempts, lockedUntil: user.lockedUntil };
    if (isLocked(state, now)) return { ok: false, reason: 'locked' };

    if (!(await argon2.verify(user.passwordHash, password))) {
      // **운영이 조절한 값을 쓴다** (FR-521). 코드 기본값은 DB가 비었을 때만 쓰인다
      const next = afterFailure(state, now, await this.settings.get(tx));
      await tx
        .update(users)
        .set({ failedAttempts: next.failedAttempts, lockedUntil: next.lockedUntil, updatedAt: sql`now()` })
        .where(eq(users.id, user.id));
      return { ok: false, reason: isLocked(next, now) ? 'locked' : 'wrong' };
    }

    // 비밀번호가 맞아도 승인 대기면 못 들어간다. 비밀번호 확인 **뒤에** 보는 이유는
    // 먼저 보면 "이 아이디는 승인 대기다"가 비밀번호 없이 새어 나가기 때문이다.
    if (user.status === 'pending') return { ok: false, reason: 'pending' };

    if (user.failedAttempts > 0 || user.lockedUntil) {
      const cleared = afterSuccess();
      await tx
        .update(users)
        .set({ failedAttempts: cleared.failedAttempts, lockedUntil: cleared.lockedUntil })
        .where(eq(users.id, user.id));
    }
    return { ok: true, user };
  }
}
