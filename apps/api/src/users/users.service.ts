import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { PASSWORD_POLICY, type CreateUserDto, type Role, type UserView } from '@workfluence/shared';
import * as argon2 from 'argon2';
import { asc, eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { users, type UserRow } from '../db/schema';

export function toUserView(u: UserRow): UserView {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role as Role, createdAt: u.createdAt.toISOString() };
}

export type CredentialResult = { ok: true; user: UserRow } | { ok: false; reason: 'unknown' | 'locked' | 'wrong' };

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  findById(id: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.id, id) });
  }

  findByUsername(username: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.username, username) });
  }

  async list(): Promise<UserView[]> {
    const rows = await this.db.select().from(users).orderBy(asc(users.username));
    return rows.map(toUserView);
  }

  async create(dto: CreateUserDto): Promise<UserRow> {
    if (await this.findByUsername(dto.username)) throw new ConflictException('이미 있는 사용자명');
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    const [row] = await this.db
      .insert(users)
      .values({ username: dto.username, displayName: dto.displayName, passwordHash, role: dto.role })
      .returning();
    return row;
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
    if (user.failedAttempts > 0 || user.lockedUntil) {
      await this.db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, user.id));
    }
    return { ok: true, user };
  }
}

// argon2id 더미 해시 ("존재하지 않는 계정"의 검증 시간을 맞추기 위한 상수. 어떤 비밀번호와도 일치하지 않는다)
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$QkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY';
