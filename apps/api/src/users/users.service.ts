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
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { DB, type Db } from '../db/db.module';
import { users, type UserRow } from '../db/schema';

export function toUserView(u: UserRow): UserView {
  const locked = !!u.lockedUntil && u.lockedUntil.getTime() > Date.now();
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    role: u.role as Role,
    status: u.status === 'pending' ? 'pending' : locked ? 'locked' : 'active',
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt.toISOString(),
  };
}

export type CredentialResult = { ok: true; user: UserRow } | { ok: false; reason: 'unknown' | 'locked' | 'wrong' | 'pending' };

const hash = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });

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

  async list(limit: number): Promise<UserView[]> {
    const rows = await this.db.select().from(users).orderBy(desc(users.createdAt)).limit(limit);
    return rows.map(toUserView);
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

  /** 가입 요청 → 승인 대기 (prototype-v2 2절 2번) */
  async signup(dto: SignupDto): Promise<UserRow> {
    await this.assertUnique(dto.username, dto.email);
    const [row] = await this.db
      .insert(users)
      .values({ username: dto.username, displayName: dto.displayName, email: dto.email, passwordHash: await hash(dto.password), role: 'member', status: 'pending' })
      .returning();
    return row;
  }

  /** 관리자가 직접 생성 → 바로 활성. 부여 가능한 역할은 canAssignRole */
  async create(dto: CreateUserDto, actor: Principal): Promise<UserRow> {
    if (!canAssignRole(actor, dto.role)) throw new ForbiddenException(`'${dto.role}' 역할을 부여할 권한이 없다`);
    await this.assertUnique(dto.username, dto.email);
    const [row] = await this.db
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

  async approve(id: string, actor: Principal): Promise<UserRow> {
    const target = await this.getManaged(id, actor);
    if (target.status !== 'pending') throw new BadRequestException('승인 대기 상태가 아니다');
    const [row] = await this.db
      .update(users)
      .set({ status: 'active', approvedAt: sql`now()`, approvedBy: actor.id, updatedAt: sql`now()` })
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  async unlock(id: string, actor: Principal): Promise<UserRow> {
    await this.getManaged(id, actor);
    const [row] = await this.db.update(users).set({ failedAttempts: 0, lockedUntil: null, updatedAt: sql`now()` }).where(eq(users.id, id)).returning();
    return row;
  }

  /** 관리자 초기화: 임시 비밀번호를 만들어 돌려주고 다음 로그인에서 변경을 강제한다 */
  async resetPassword(id: string, actor: Principal): Promise<{ user: UserRow; temporaryPassword: string }> {
    await this.getManaged(id, actor);
    return this.applyTemporaryPassword(id);
  }

  private async applyTemporaryPassword(id: string): Promise<{ user: UserRow; temporaryPassword: string }> {
    const temporaryPassword = generateTemporaryPassword((max) => randomInt(max));
    const [user] = await this.db
      .update(users)
      .set({ passwordHash: await hash(temporaryPassword), mustChangePassword: true, failedAttempts: 0, lockedUntil: null, updatedAt: sql`now()` })
      .where(eq(users.id, id))
      .returning();
    return { user, temporaryPassword };
  }

  async changeRole(id: string, role: Role, actor: Principal): Promise<UserRow> {
    if (id === actor.id) throw new BadRequestException('자기 자신의 역할은 바꿀 수 없다');
    await this.getManaged(id, actor);
    if (!canAssignRole(actor, role)) throw new ForbiddenException(`'${role}' 역할을 부여할 권한이 없다`);
    const [row] = await this.db.update(users).set({ role, updatedAt: sql`now()` }).where(eq(users.id, id)).returning();
    return row;
  }

  /** ID 찾기: email + 이름이 모두 일치하는 활성·대기 계정 */
  async findByEmailAndName(email: string, displayName: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: and(eq(users.email, email.toLowerCase()), eq(users.displayName, displayName)) });
  }

  /** PWD 찾기: ID + email 일치 시 임시 비밀번호. 불일치는 null (호출부가 일정 지연 후 404) */
  async recoverPassword(username: string, email: string): Promise<{ user: UserRow; temporaryPassword: string } | null> {
    const user = await this.findByUsername(username);
    if (!user || !user.email || user.email !== email.toLowerCase() || user.status !== 'active') return null;
    return this.applyTemporaryPassword(user.id);
  }

  async changePassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.findById(id);
    if (!user?.passwordHash) throw new NotFoundException('사용자를 찾을 수 없다');
    if (!(await argon2.verify(user.passwordHash, currentPassword))) throw new BadRequestException('현재 비밀번호가 올바르지 않다');
    await this.db
      .update(users)
      .set({ passwordHash: await hash(newPassword), mustChangePassword: false, updatedAt: sql`now()` })
      .where(eq(users.id, id));
  }

  /** 로컬 계정 검증 + 실패 횟수·잠금 (CLAUDE.md 7절 기본 정책) */
  async verifyCredentials(username: string, password: string): Promise<CredentialResult> {
    const user = await this.findByUsername(username);
    if (!user || !user.passwordHash) {
      // 사용자가 없어도 해시 검증에 걸리는 시간을 비슷하게 맞춘다 (타이밍으로 계정 존재 유추 방지)
      await argon2.verify(DUMMY_HASH, password).catch(() => false);
      return { ok: false, reason: 'unknown' };
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) return { ok: false, reason: 'locked' };

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      const attempts = user.failedAttempts + 1;
      const lock = attempts >= PASSWORD_POLICY.lockoutThreshold;
      await this.db
        .update(users)
        .set({
          failedAttempts: lock ? 0 : attempts,
          lockedUntil: lock ? new Date(Date.now() + PASSWORD_POLICY.lockoutMinutes * 60_000) : null,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, user.id));
      return { ok: false, reason: lock ? 'locked' : 'wrong' };
    }
    if (user.status === 'pending') return { ok: false, reason: 'pending' };
    if (user.failedAttempts > 0 || user.lockedUntil) {
      await this.db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, user.id));
    }
    return { ok: true, user };
  }
}

// argon2id 더미 해시 ("존재하지 않는 계정"의 검증 시간을 맞추기 위한 상수. 어떤 비밀번호와도 일치하지 않는다)
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$QkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY';
