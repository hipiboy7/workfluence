import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  PASSWORD_POLICY,
  canAssignRole,
  canManageUser,
  generateTemporaryPassword,
  type CreateUserDto,
  type Principal,
  type Role,
  type SignupDto,
  type UserView,
} from '@workfluence/shared';
import * as argon2 from 'argon2';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { afterFailure, afterSuccess, isLocked } from '../auth/domain/lockout';
import { DB, type Db } from '../db/db.module';
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
  constructor(@Inject(DB) private readonly db: Db) {}

  findById(id: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.id, id) });
  }

  findByUsername(username: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.username, username) });
  }

  findByEmail(email: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.email, email.toLowerCase()) });
  }

  findByOidcSub(sub: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.oidcSub, sub) });
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
      .orderBy(users.displayName);
    return rows.map((r) => r.name);
  }

  private async assertUnique(username: string, email: string): Promise<void> {
    if (await this.findByUsername(username)) throw new ConflictException('이미 있는 사용자명');
    if (await this.findByEmail(email)) throw new ConflictException('이미 등록된 email');
  }

  /** 가입 요청 → 승인 대기 (FR-200) */
  async signup(dto: SignupDto, tx: Db = this.db): Promise<UserRow> {
    await this.assertUnique(dto.username, dto.email);
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
    await this.assertUnique(dto.username, dto.email);
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

  private async getManaged(id: string, actor: Principal): Promise<UserRow> {
    const target = await this.findById(id);
    if (!target) throw new NotFoundException('사용자를 찾을 수 없다');
    if (!canManageUser(actor, target.role as Role)) throw new ForbiddenException('이 사용자를 관리할 권한이 없다');
    return target;
  }

  async approve(id: string, actor: Principal, tx: Db = this.db): Promise<UserRow> {
    const target = await this.getManaged(id, actor);
    if (target.status !== 'pending') throw new BadRequestException('승인 대기 상태가 아니다');
    const [row] = await tx
      .update(users)
      .set({ status: 'active', approvedAt: sql`now()`, approvedBy: actor.id, updatedAt: sql`now()` })
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  async unlock(id: string, actor: Principal, tx: Db = this.db): Promise<UserRow> {
    await this.getManaged(id, actor);
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
    await this.getManaged(id, actor);
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
    return { user, temporaryPassword };
  }

  /** 역할 변경 (FR-232, FR-233) */
  async changeRole(id: string, role: Role, actor: Principal, tx: Db = this.db): Promise<UserRow> {
    if (id === actor.id) throw new BadRequestException('자기 자신의 역할은 바꿀 수 없다');
    const target = await this.getManaged(id, actor);
    if (!canAssignRole(actor, role)) throw new ForbiddenException(`'${role}' 역할을 부여할 권한이 없다`);
    // 마지막 root를 강등하면 아무도 root 권한을 되돌릴 수 없다 (FR-233). 순수 함수로 두기 어려워 여기서 센다
    if (target.role === 'root' && role !== 'root') {
      const [{ n }] = await this.db.select({ n: count() }).from(users).where(and(eq(users.role, 'root'), eq(users.status, 'active')));
      if (n <= 1) throw new BadRequestException('마지막 root는 강등할 수 없다');
    }
    const [row] = await tx.update(users).set({ role, updatedAt: sql`now()` }).where(eq(users.id, id)).returning();
    return row;
  }

  /** ID 찾기 (FR-208): email + 이름이 **모두** 일치할 때만 */
  async findByEmailAndName(email: string, displayName: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({
      where: and(eq(users.email, email.toLowerCase()), eq(users.displayName, displayName)),
    });
  }

  /** 비밀번호 찾기: ID + email 일치 시 임시 비밀번호. 불일치는 null (호출부가 같은 응답을 준다) */
  async recoverPassword(username: string, email: string, tx: Db = this.db): Promise<{ user: UserRow; temporaryPassword: string } | null> {
    const user = await this.findByUsername(username);
    if (!user || !user.email || user.email !== email.toLowerCase() || user.status !== 'active') return null;
    return this.applyTemporaryPassword(user.id, tx);
  }

  async changePassword(id: string, currentPassword: string, newPassword: string, tx: Db = this.db): Promise<void> {
    const user = await this.findById(id);
    if (!user?.passwordHash) throw new NotFoundException('사용자를 찾을 수 없다');
    if (!(await argon2.verify(user.passwordHash, currentPassword))) throw new BadRequestException('현재 비밀번호가 올바르지 않다');
    await tx
      .update(users)
      .set({ passwordHash: await hash(newPassword), mustChangePassword: false, updatedAt: sql`now()` })
      .where(eq(users.id, id));
  }

  /**
   * 로컬 계정 검증 (FR-202, FR-205, FR-206).
   *
   * 호출부는 `reason`으로 응답을 나누지 않는다 — 전부 같은 401이다. 이 값은 **감사로그와
   * 관리자 화면에만** 쓴다.
   */
  async verifyCredentials(username: string, password: string, now: Date = new Date()): Promise<CredentialResult> {
    const user = await this.findByUsername(username);
    if (!user || !user.passwordHash) {
      await argon2.verify(DUMMY_HASH, password).catch(() => false);
      return { ok: false, reason: 'unknown' };
    }

    const state = { failedAttempts: user.failedAttempts, lockedUntil: user.lockedUntil };
    if (isLocked(state, now)) return { ok: false, reason: 'locked' };

    if (!(await argon2.verify(user.passwordHash, password))) {
      const next = afterFailure(state, now, PASSWORD_POLICY);
      await this.db
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
      await this.db
        .update(users)
        .set({ failedAttempts: cleared.failedAttempts, lockedUntil: cleared.lockedUntil })
        .where(eq(users.id, user.id));
    }
    return { ok: true, user };
  }
}
