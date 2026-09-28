import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  can,
  canAssignRole,
  canGrant,
  checkPasswordPolicy,
  canManageUser,
  DELEGABLE_ACTIONS,
  DELEGATION,
  generateTemporaryPassword,
  grantsForRole,
  suspendProblem,
  unsuspendProblem,
  type CreateUserDto,
  type DelegableAction,
  type Principal,
  type Role,
  type ListUsersDto,
  type SignupDto,
  type UserListView,
  type UserStatus,
  type UserView,
} from '@workfluence/shared';
import { and, count, desc, eq, gt, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { containsPattern } from '../common/like';
import { randomInt } from 'node:crypto';
import { afterSuccess, isLocked, lockAfterFailure, type LockoutPolicy } from '../auth/domain/lockout';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password';
import { RevocationBus } from '../common/revocation.bus';
import { DB, type Db } from '../db/db.module';
import { byName } from '../db/order';
import { SettingsService } from '../settings/settings.service';
import { users, type UserRow } from '../db/schema';

/**
 * 마지막 root 강등을 줄 세우는 잠금의 이름 (FR-233). 잠그지 않으면 root 둘을 두 요청이 동시에 내릴 때 둘 다 "root 2명"을 세고
 * root가 0명이 된다 (P11 종료 루틴 자체 점검 6). 다른 잠금과 같이 이름을 `hashtext`로 번호로 바꾼다
 */
const LAST_ROOT_LOCK = 'users:last-root';

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
    status: u.status === 'pending' ? 'pending' : u.status === 'suspended' ? 'suspended' : locked ? 'locked' : 'active',
    mustChangePassword: u.mustChangePassword,
    grants: grantsForRole(u.role as Role, u.grants),
    createdAt: u.createdAt.toISOString(),
  };
}

/** `changed` — 확인한 뒤 적기 전에 비밀번호가 바뀌었다(본인 변경·관리자 초기화). 옛 비밀번호로 들어온 것이 된다 */
export type CredentialResult =
  | { ok: true; user: UserRow }
  | { ok: false; reason: 'unknown' | 'locked' | 'wrong' | 'pending' | 'suspended' | 'changed' };

/**
 * **확인까지 한 결과** — 아직 DB에 적지 않았다 (P13 D.4). `checkCredentials`가 연결을 쥐지 않고 만들고, `settleCredentials`가 호출부의
 * 짧은 트랜잭션에서 적는다(감사와 같은 트랜잭션 — P1 FR-236)
 */
export type CredentialCheck =
  | { kind: 'unknown' }
  | { kind: 'locked' }
  | { kind: 'mismatch' | 'match'; user: UserRow; policy: LockoutPolicy };

/** 관리자 초기화의 임시 비밀번호 — 해시는 트랜잭션을 열기 전에 만든다 (P13 FR-1434) */
export type TemporaryPassword = { temporaryPassword: string; hash: string };

/** 비밀번호 변경의 준비물 — 읽은 해시(그 사이 바뀌었는지 볼 때)와 새 해시 */
export type PreparedPasswordChange = { readHash: string; nextHash: string };

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

  /**
   * **잠그고** 읽는다(`SELECT … FOR UPDATE`) — 역할·위임을 읽고 그 값으로 다시 쓰는 곳(역할 변경·위임·사내 계정 동기화)이 쓴다.
   *
   * 잠그지 않으면 읽은 뒤 끝난 다른 요청의 위임을 **옛 값으로 덮는다** — 역할을 그대로 두는 변경(admin → admin)도 읽은 `grants`를 다시
   * 쓰므로, 그 사이 맡긴 것이 사라지거나 거둔 것이 되살아나고, 감사 행의 이전 값도 틀린다 (P11 코드 리뷰 4·보안 검토 후보 1).
   * 잠금은 트랜잭션이 끝날 때 풀린다 — 호출부가 트랜잭션 안에서 부른다
   */
  async lockForUpdate(by: { id: string } | { oidcSub: string }, tx: Db): Promise<UserRow | undefined> {
    const where = 'id' in by ? eq(users.id, by.id) : eq(users.oidcSub, by.oidcSub);
    const [row] = await tx.select().from(users).where(where).for('update');
    return row;
  }

  /**
   * 사용자 목록 — **서버가 찾고 거르고 나눈다** (P13 C.6, FR-1450~1452). 화면에서 거르면 한 번에 받은 100명 밖을 못 찾는다. 찾는 말은
   * 아이디·이름·email의 부분 일치, 상태의 '잠김'은 저장값이 아니라 잠금 시각에서 판다(FR-230). 새로 온 사람부터, 같은 시각이면 id 순
   */
  async list(f: ListUsersDto): Promise<UserListView> {
    const now = new Date();
    const conds: SQL[] = [];
    if (f.q) {
      const like = containsPattern(f.q);
      conds.push(or(ilike(users.username, like), ilike(users.displayName, like), ilike(users.email, like))!);
    }
    const notLocked = or(isNull(users.lockedUntil), lte(users.lockedUntil, now))!;
    if (f.status === 'pending' || f.status === 'suspended') conds.push(eq(users.status, f.status));
    if (f.status === 'active') conds.push(eq(users.status, 'active'), notLocked);
    if (f.status === 'locked') conds.push(eq(users.status, 'active'), gt(users.lockedUntil, now));
    const where = conds.length ? and(...conds) : undefined;
    const [rows, [{ n }]] = await Promise.all([
      this.db.select().from(users).where(where).orderBy(desc(users.createdAt), desc(users.id)).limit(f.limit).offset(f.offset),
      this.db.select({ n: count() }).from(users).where(where),
    ]);
    return { items: rows.map((r) => toUserView(r, now)), total: n };
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
   *
   * **열린 편집 연결에 알리는 것은 커밋한 뒤다** (`revokeConnections`, P13 D.5). 세션 행을 지우는 것만으로는 부족하다 — 이미 열려 있는
   * 편집용 WebSocket은 그 행을 다시 읽지 않는다(P6 보안 검토 발견 1). 그런데 트랜잭션 안에서 알리면 커밋 전 몇 ms 사이에 다시 붙은 연결이
   * 아직 지워지지 않은 행을 읽고 주기 재판정까지 살아남고, 감사 기록이 실패해 되돌려지면 비밀번호는 그대로인데 연결만 끊긴다 (좁은 자체 점검 5)
   */
  async destroyAllSessions(userId: string, tx: Db = this.db): Promise<void> {
    await tx.execute(sql`DELETE FROM sessions WHERE sess->>'userId' = ${userId}`);
  }

  /** 그 사람의 열린 편집 연결을 끊으라고 알린다 — **세션을 지운 트랜잭션이 커밋한 뒤에** 부른다 (`destroyAllSessions`) */
  revokeConnections(userId: string): void {
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

  /**
   * **해시를 트랜잭션 밖에서 만든다** (P13 FR-1434). 강도를 먼저 본다 — 약한 비밀번호에 argon2를 쓰지 않는다. 호출부는 이 값을 들고
   * 트랜잭션을 연다
   */
  async preparePassword(pw: string): Promise<string> {
    await this.assertPasswordStrength(pw, this.db);
    return hashPassword(pw);
  }

  /**
   * `passwordHash`는 `preparePassword`가 만든 것이다. 없으면 여기서 만든다 — 트랜잭션 없이 부르는 시험·도구용이다. 강도는 늘 다시 본다(값싸다)
   */
  async signup(dto: SignupDto, tx: Db = this.db, passwordHash?: string): Promise<UserRow> {
    await this.assertPasswordStrength(dto.password, tx);
    await this.assertUnique(dto.username, dto.email, tx);
    const hashed = passwordHash ?? (await hashPassword(dto.password));
    const [row] = await tx
      .insert(users)
      .values({
        username: dto.username,
        displayName: dto.displayName,
        email: dto.email,
        passwordHash: hashed,
        role: 'member',
        status: 'pending',
      })
      .returning();
    return row;
  }

  /** 관리자가 직접 생성 → 바로 활성 (FR-231) */
  async create(dto: CreateUserDto, actor: Principal, tx: Db = this.db, passwordHash?: string): Promise<UserRow> {
    if (!canAssignRole(actor, dto.role)) throw new ForbiddenException(`'${dto.role}' 역할을 부여할 권한이 없다`);
    // **여기도 강도를 본다.** 계약(zod)이 바닥만 보게 바뀐 뒤로 이 경로만 검사가 없었다 —
    // 관리자가 만든 계정은 바로 활성이라, 비어 있으면 가장 센 계정이 가장 약한 비밀번호를 갖는다
    await this.assertPasswordStrength(dto.password, tx);
    await this.assertUnique(dto.username, dto.email, tx);
    const hashed = passwordHash ?? (await hashPassword(dto.password));
    const [row] = await tx
      .insert(users)
      .values({
        username: dto.username,
        displayName: dto.displayName,
        email: dto.email,
        passwordHash: hashed,
        role: dto.role,
        status: 'active',
        approvedAt: sql`now()`,
        approvedBy: actor.id,
      })
      .returning();
    return row;
  }

  /**
   * 트랜잭션 안에서 돈다 — 받은 `tx`가 풀(`this.db`)이면 트랜잭션을 연다. 행 잠금(`lockForUpdate`)은 트랜잭션이 끝날 때 풀리므로, 풀로
   * 부르면 읽은 직후 풀려 **판정이 쓰기까지 이어지지 않는다** (P11 종료 루틴 자체 점검 5). 컨트롤러는 늘 트랜잭션을 넘긴다 — 시험과
   * 다른 호출부도 같은 모양으로 돈다
   */
  private inTx<T>(tx: Db, run: (t: Db) => Promise<T>): Promise<T> {
    return tx === this.db ? this.db.transaction((t) => run(t)) : run(tx);
  }

  /**
   * 관리할 대상 — 역할과 **위임까지** 보고 판정한다(`canManageUser`, P11 보안 검토 1). **행을 잠그고 읽는다**(`lockForUpdate`) — 판정한
   * 뒤 쓰기 전에 root가 그 사람에게 위임을 주면, 위임 없는 관리자가 방금 위임받은 관리자를 초기화하는 틈이 생긴다 (종료 루틴 자체 점검 2).
   * 부르는 쪽은 `inTx` 안이다
   */
  private async getManaged(id: string, actor: Principal, tx: Db): Promise<UserRow> {
    const target = await this.lockForUpdate({ id }, tx);
    if (!target) throw new NotFoundException('사용자를 찾을 수 없다');
    if (!canManageUser(actor, { role: target.role as Role, grants: target.grants })) throw new ForbiddenException('이 사용자를 관리할 권한이 없다');
    return target;
  }

  async approve(id: string, actor: Principal, tx: Db = this.db): Promise<UserRow> {
    return this.inTx(tx, async (t) => {
      const target = await this.getManaged(id, actor, t);
      if (target.status !== 'pending') throw new BadRequestException('승인 대기 상태가 아니다');
      const [row] = await t
        .update(users)
        .set({ status: 'active', approvedAt: sql`now()`, approvedBy: actor.id, updatedAt: sql`now()` })
        .where(eq(users.id, id))
        .returning();
      return row;
    });
  }

  async unlock(id: string, actor: Principal, tx: Db = this.db): Promise<UserRow> {
    return this.inTx(tx, async (t) => {
      await this.getManaged(id, actor, t);
      const cleared = afterSuccess();
      const [row] = await t
        .update(users)
        .set({ failedAttempts: cleared.failedAttempts, lockedUntil: cleared.lockedUntil, updatedAt: sql`now()` })
        .where(eq(users.id, id))
        .returning();
      return row;
    });
  }

  /** 임시 비밀번호와 그 해시 — 트랜잭션을 열기 전에 만든다 (P13 FR-1434) */
  async prepareTemporaryPassword(): Promise<TemporaryPassword> {
    const temporaryPassword = generateTemporaryPassword((max) => randomInt(max));
    return { temporaryPassword, hash: await hashPassword(temporaryPassword) };
  }

  /**
   * 관리자 초기화 (FR-209). 임시 비밀번호는 **돌려주기만** 하고 저장하지 않는다. 트랜잭션을 넘겨받으면 편집 연결에 알리는 것은 커밋한 호출부가
   * 한다 — 정지와 같다 (`destroyAllSessions`)
   */
  async resetPassword(id: string, actor: Principal, tx: Db = this.db, prepared?: TemporaryPassword): Promise<{ user: UserRow; temporaryPassword: string }> {
    const opened = tx === this.db;
    const result = await this.inTx(tx, async (t) => {
      const target = await this.getManaged(id, actor, t);
      // IdP 계정에 비밀번호를 붙이면 IdP가 강제하던 인증(사내 MFA·정책)을 건너뛰는 옆문이 생긴다.
      // FR-217이 "IdP 계정은 비밀번호로 로그인할 수 없다"고 한 것을 초기화가 뚫으면 안 된다.
      if (target.oidcSub !== null) {
        throw new BadRequestException('사내 IdP 계정이다. 비밀번호를 부여하지 않는다 — IdP로 로그인한다');
      }
      return this.applyTemporaryPassword(id, t, prepared ?? (await this.prepareTemporaryPassword()));
    });
    if (opened) this.revokeConnections(id);
    return result;
  }

  private async applyTemporaryPassword(id: string, tx: Db, prepared: TemporaryPassword): Promise<{ user: UserRow; temporaryPassword: string }> {
    const { temporaryPassword } = prepared;
    const cleared = afterSuccess();
    const [user] = await tx
      .update(users)
      .set({
        passwordHash: prepared.hash,
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
    return this.inTx(tx, async (t) => {
      // **잠그고 읽는다** — 읽은 위임으로 다시 쓰므로, 그 사이의 위임 변경을 덮지 않게 (`getManaged` → `lockForUpdate`)
      const target = await this.getManaged(id, actor, t);
      if (!canAssignRole(actor, role)) throw new ForbiddenException(`'${role}' 역할을 부여할 권한이 없다`);
      // 마지막 root를 강등하면 아무도 root 권한을 되돌릴 수 없다 (FR-233). 순수 함수로 두기 어려워 여기서 센다.
      // **활성 root를 강등할 때만 센다** (병합 전 검토 — 코드 리뷰 5·자체 점검 5). 셈은 활성 root만 세므로, 정지된 root를 강등해도 그 수는
      // 줄지 않는다 — 대상의 상태를 보지 않으면 활성 root가 한 명일 때 퇴사한(정지된) root를 정리할 수 없었다
      if (target.role === 'root' && target.status === 'active' && role !== 'root') {
        // **root 강등을 줄 세운 뒤 센다** — 잠금을 쥔 다음 문장은 앞선 강등이 커밋한 것을 본다 (`LAST_ROOT_LOCK`)
        await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LAST_ROOT_LOCK}))`);
        // **`t`로 센다.** `this.db`는 풀이라, 트랜잭션 안에서 부르면 연결을 하나 쥔 채
        // 두 번째를 달라고 한다 — 동시 요청이 풀 크기에 닿으면 서로를 기다린다 (T-026).
        // 지금은 10초 뒤 500으로 끝나지만 그것은 증상을 시끄럽게 만든 것이고 원인은 이 줄이다
        const [{ n }] = await t.select({ n: count() }).from(users).where(and(eq(users.role, 'root'), eq(users.status, 'active')));
        if (n <= 1) throw new BadRequestException('마지막 root는 강등할 수 없다');
      }
      const before = grantsForRole(target.role as Role, target.grants);
      const grants = grantsForRole(role, before);
      const [row] = await t.update(users).set({ role, grants, updatedAt: sql`now()` }).where(eq(users.id, id)).returning();
      return { row, clearedGrants: before.filter((g) => !grants.includes(g)) };
    });
  }

  /**
   * 위임을 주고 거둔다 (P11_설계서_Ops D.1 · P15_설계서_Grants D.1, FR-1600~1603). 창구는 root와 관리자다 — 가드가 먼저 막고 여기서 한 번 더
   * 본다. **무엇을 줄 수 있는지는 규칙표**(`DELEGATION` — `canGrant`)가 정한다: LLM 연결 관리는 root가 관리자에게, 셋은 관리자·root가
   * member에게. 목록 전체를 받는다(멱등). 이전·이후를 돌려준다 — 호출부가 감사 `user.grants.change`에 싣는다 (FR-1205)
   */
  async changeGrants(
    id: string,
    grants: readonly DelegableAction[],
    actor: Principal,
    tx: Db = this.db,
  ): Promise<{ row: UserRow; before: DelegableAction[]; after: DelegableAction[]; changed: boolean }> {
    if (!can(actor, 'user.grants.change')) throw new ForbiddenException('위임은 관리자와 시스템 관리자만 주고 거둔다');
    return this.inTx(tx, (t) => this.changeGrantsIn(id, grants, actor, t));
  }

  private async changeGrantsIn(
    id: string,
    grants: readonly DelegableAction[],
    actor: Principal,
    tx: Db,
  ): Promise<{ row: UserRow; before: DelegableAction[]; after: DelegableAction[]; changed: boolean }> {
    // **잠그고 읽는다** — 이전 값이 감사 행에 가고, 동시에 바꾸는 두 요청이 서로를 덮지 않게 (`lockForUpdate`)
    const target = await this.lockForUpdate({ id }, tx);
    if (!target) throw new NotFoundException('사용자를 찾을 수 없다');
    const role = target.role as Role;
    // 관리할 수 없는 사람의 위임은 건드리지 않는다 — 관리자는 root를, 자기에게 없는 위임을 가진 관리자를 관리하지 못한다 (P11 보안 검토 1)
    if (!canManageUser(actor, { role, grants: target.grants })) throw new ForbiddenException('이 사용자를 관리할 권한이 없다');
    // 그 역할이 받지 않는 위임을 보내면 400 — 조용히 버리지 않는다(관리자에게 셋, member에게 LLM 연결 관리, root에게 무엇이든)
    const unfit = grants.filter((g) => DELEGATION[g].holder !== role);
    if (unfit.length) throw new BadRequestException(`이 역할(${role})은 받지 않는 위임이다: ${unfit.join(', ')}`);
    const before = grantsForRole(role, target.grants);
    const after = grantsForRole(role, grants);
    // **바뀌는 것마다 줄 수 있어야 한다** — 관리자는 LLM 연결 관리를 주지도 거두지도 못한다(규칙표의 주는 사람이 root다)
    const moved = DELEGABLE_ACTIONS.filter((a) => before.includes(a) !== after.includes(a));
    const denied = moved.filter((a) => !canGrant(actor, a, role));
    if (denied.length) throw new ForbiddenException(`주고 거둘 수 없는 위임이다: ${denied.join(', ')}`);
    // **바뀌는 것이 없으면 쓰지 않는다** — 같은 목록을 다시 보내도 감사 행(1년 남는다)이 쌓이지 않게 (P11 코드 리뷰 9)
    if (!moved.length) return { row: target, before, after, changed: false };
    // 역할은 잠근 행으로 보았다. 조건은 한 번 더 둔다 — 잠그지 않고 부르는 호출부가 생겨도 판정한 상태에서만 쓴다
    const [row] = await tx
      .update(users)
      .set({ grants: after, updatedAt: sql`now()` })
      .where(and(eq(users.id, id), eq(users.role, role)))
      .returning();
    if (!row) throw new ConflictException('그 사이 역할이 바뀌었다 — 목록을 다시 본다');
    return { row, before, after, changed: true };
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
   * **정지** (P13 C.5, FR-1441·1442). 퇴사자 처리 — 로그인하지 못하고 내용·Crew 소속·감사 기록은 남는다.
   *
   * 판정은 공유 함수(`suspendProblem`)가 한다 — 관리의 우열(P11), 자기 자신, 활성 계정만, 마지막 활성 root. 대상 행을 **잠그고** 읽는다
   * (`lockForUpdate` — 판정과 쓰기 사이에 위임·역할이 바뀌지 않게). root를 셀 때는 root 강등과 **같은 줄**에 선다(`LAST_ROOT_LOCK`) —
   * 둘이 동시에 root 둘을 하나씩 정지·강등하면 root가 0명이 된다. 정지하는 순간 세션을 모두 지우고 열린 실시간 편집 연결을 끊는다
   * (RevocationBus — 강제 종료와 같다). 이전 상태를 돌려준다 — 호출부가 감사에 싣는다
   */
  async suspend(id: string, actor: Principal, tx: Db = this.db): Promise<{ row: UserRow; before: UserStatus }> {
    const opened = tx === this.db;
    const result = await this.inTx(tx, async (t) => {
      const target = await this.lockForUpdate({ id }, t);
      if (!target) throw new NotFoundException('사용자를 찾을 수 없다');
      let activeRoots = 0;
      if (target.role === 'root') {
        await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LAST_ROOT_LOCK}))`);
        // **`t`로 센다** — 트랜잭션 안에서 풀에 두 번째 연결을 달라고 하지 않는다 (T-026)
        [{ n: activeRoots }] = await t.select({ n: count() }).from(users).where(and(eq(users.role, 'root'), eq(users.status, 'active')));
      }
      const before = target.status as UserStatus;
      this.assertAllowed(suspendProblem(actor, { id: target.id, role: target.role as Role, status: before, grants: target.grants }, activeRoots));
      const [row] = await t.update(users).set({ status: 'suspended', updatedAt: sql`now()` }).where(eq(users.id, id)).returning();
      await t.execute(sql`DELETE FROM sessions WHERE sess->>'userId' = ${id}`);
      return { row, before };
    });
    // **끊는 알림은 커밋한 뒤에** (FR-1442, 병합 전 검토). 트랜잭션을 여기서 열었으면 지금이 커밋 뒤다. 호출부가 넘긴 트랜잭션이면 커밋은
    // 호출부의 일이라 알림도 호출부가 한다(`UsersController.suspend`) — 여기서 울리면 커밋 전이다
    if (opened) this.revocation.revoke(id);
    return result;
  }

  /** **정지 해제** (P13 FR-1441) — 활성으로 돌아간다. 비밀번호·Crew 소속은 그대로다 */
  async unsuspend(id: string, actor: Principal, tx: Db = this.db): Promise<UserRow> {
    return this.inTx(tx, async (t) => {
      const target = await this.lockForUpdate({ id }, t);
      if (!target) throw new NotFoundException('사용자를 찾을 수 없다');
      this.assertAllowed(unsuspendProblem(actor, { id: target.id, role: target.role as Role, status: target.status as UserStatus, grants: target.grants }));
      const [row] = await t.update(users).set({ status: 'active', updatedAt: sql`now()` }).where(eq(users.id, id)).returning();
      return row;
    });
  }

  /** 판정 함수의 까닭을 응답으로 — 권한이면 403, 나머지는 400 */
  private assertAllowed(problem: string | null): void {
    if (!problem) return;
    if (problem === '이 사용자를 관리할 권한이 없다') throw new ForbiddenException(problem);
    throw new BadRequestException(problem);
  }

  /**
   * 관리자 강제 종료 (`scope-definition` 4.1절 #4, FR-539).
   *
   * **서버측 세션을 파기한다.** 쿠키만 지우게 하면 훔친 세션이 계속 산다 — 로그아웃·비밀번호
   * 변경과 같은 판단이다 (FR-224). `sess`는 connect-pg-simple가 넣은 세션 객체 전체다.
   */
  async terminateSessions(id: string, actor: Principal, tx: Db = this.db): Promise<number> {
    const opened = tx === this.db;
    const n = await this.inTx(tx, async (t) => {
      await this.getManaged(id, actor, t);
      const r = await t.execute(sql`DELETE FROM sessions WHERE sess->>'userId' = ${id}`);
      return r.rowCount ?? 0;
    });
    // 끊는 알림은 커밋한 뒤에 — 정지와 같다(넘겨받은 트랜잭션이면 호출부가 알린다)
    if (opened) this.revocation.revoke(id);
    return n;
  }

  /**
   * 비밀번호 변경의 준비 — 지금 비밀번호를 확인하고 새 해시를 만든다. **연결을 쥐지 않는다** (P13 FR-1434). 읽은 해시를 함께 돌려
   * 쓰는 쪽이 그 사이 바뀌지 않았는지 본다
   */
  async prepareChangePassword(id: string, currentPassword: string, newPassword: string): Promise<PreparedPasswordChange> {
    const user = await this.findById(id);
    if (!user?.passwordHash) throw new NotFoundException('사용자를 찾을 수 없다');
    if (!(await verifyPassword(user.passwordHash, currentPassword))) throw new BadRequestException('현재 비밀번호가 올바르지 않다');
    await this.assertPasswordStrength(newPassword, this.db);
    return { readHash: user.passwordHash, nextHash: await hashPassword(newPassword) };
  }

  /** 비밀번호 변경. 트랜잭션을 넘겨받으면 편집 연결에 알리는 것은 커밋한 호출부가 한다 (`destroyAllSessions`) */
  async changePassword(id: string, currentPassword: string, newPassword: string, tx: Db = this.db, prepared?: PreparedPasswordChange): Promise<void> {
    const p = prepared ?? (await this.prepareChangePassword(id, currentPassword, newPassword));
    // **읽은 해시가 그대로일 때만** 바꾼다 — 확인과 쓰기 사이에 관리자 초기화나 다른 변경이 끼면 옛 비밀번호로 확인한 것이 된다
    const done = await tx
      .update(users)
      .set({ passwordHash: p.nextHash, mustChangePassword: false, updatedAt: sql`now()` })
      .where(and(eq(users.id, id), eq(users.passwordHash, p.readHash)))
      .returning({ id: users.id });
    if (done.length === 0) throw new ConflictException('그 사이 비밀번호가 바뀌었다 — 다시 시도한다');
    // 비밀번호가 바뀌면 그 사용자의 세션을 전부 끊는다. 호출부가 자기 세션은 다시 만든다
    await this.destroyAllSessions(id, tx);
    if (tx === this.db) this.revokeConnections(id);
  }

  /**
   * 로컬 계정 확인 (FR-202, FR-205, FR-206) — **DB 연결을 쥐지 않는다** (P13 D.4, FR-1430·1432, 보류 16).
   *
   * 사용자 행을 읽고(트랜잭션 없이), 없거나 비밀번호가 없으면(사내 계정) 또는 잠겨 있으면 **더미 해시로 한 번** 확인하고 끝낸다 — 그런
   * 계정만 빨리 답하면 응답 시간으로 계정 상태가 드러난다(측정 S0b — 잠긴 계정은 약 5ms였다). 아니면 argon2로 확인한다 — 한 줄(동시 실행
   * 상한) 안에서, 연결 없이.
   *
   * **한 계정의 로그인은 줄을 서서 부른다**(`AuthService` — `KeyedSerial`). 그래야 여기서 읽은 잠금이 앞 사람의 기록 뒤의 값이다.
   * 적는 것(실패 횟수·잠금·초기화)은 `settleCredentials`가 호출부의 짧은 트랜잭션에서 감사와 함께 한다
   */
  async checkCredentials(username: string, password: string, now: Date = new Date()): Promise<CredentialCheck> {
    const user = await this.findByUsername(username);
    if (!user || !user.passwordHash) {
      await burnPasswordCheck(password);
      return { kind: 'unknown' };
    }
    if (isLocked({ failedAttempts: user.failedAttempts, lockedUntil: user.lockedUntil }, now)) {
      await burnPasswordCheck(password);
      return { kind: 'locked' };
    }
    // **운영이 조절한 값을 쓴다** (FR-521). 코드 기본값은 DB가 비었을 때만 쓰인다
    const policy = await this.settings.get();
    const ok = await verifyPassword(user.passwordHash, password);
    return { kind: ok ? 'match' : 'mismatch', user, policy };
  }

  /**
   * 확인한 결과를 적는다 — **호출부의 트랜잭션에서** 감사와 함께 (P1 FR-236, P13 FR-1435).
   *
   * 틀렸으면 실패 횟수를 **한 문장으로** 올리고(`failed_attempts + 1 RETURNING` — 읽고 계산해 쓰면 동시에 온 요청이 서로를 덮는다),
   * 올린 뒤의 수가 기준에 닿으면 잠근다. 읽은 비밀번호 그대로일 때만 — 그 사이 관리자 초기화가 풀어 둔 계정을 다시 잠그지 않게.
   * 맞았으면 횟수와 잠금을 지운다. 비밀번호가 맞아도 승인 대기·정지면 못 들어간다 — **비밀번호 확인 뒤에** 보는 이유는 먼저 보면
   * 계정 상태가 비밀번호 없이 새어 나가기 때문이다(FR-206·1443). 호출부는 `reason`으로 응답을 나누지 않는다 — 전부 같은 401이다
   */
  async settleCredentials(check: CredentialCheck, now: Date, tx: Db = this.db): Promise<CredentialResult> {
    if (check.kind === 'unknown') return { ok: false, reason: 'unknown' };
    if (check.kind === 'locked') return { ok: false, reason: 'locked' };
    const { user } = check;
    if (check.kind === 'mismatch') {
      const [row] = await tx
        .update(users)
        .set({ failedAttempts: sql`${users.failedAttempts} + 1`, updatedAt: sql`now()` })
        .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash!)))
        .returning({ failedAttempts: users.failedAttempts });
      // 그 사이 비밀번호가 바뀌었으면(초기화) 옛 비밀번호의 실패는 세지 않는다
      const lockUntil = row ? lockAfterFailure(row.failedAttempts, now, check.policy) : null;
      if (!lockUntil) return { ok: false, reason: 'wrong' };
      await tx.update(users).set({ lockedUntil: lockUntil }).where(eq(users.id, user.id));
      return { ok: false, reason: 'locked' };
    }
    // **읽은 비밀번호 그대로일 때만 들인다** (병합 전 검토 — 보안 L1·코드 리뷰 2·자체 점검 3). 확인(argon2)은 연결 없이 돌아, 그 사이 본인이
    // 비밀번호를 바꾸면 변경이 세션을 모두 지운 **뒤에** 이 로그인이 세션을 새로 만들었다 — "비밀번호를 바꾸면 모두 끊긴다"(`CLAUDE.md` 7절)를
    // 비켜 간다. 확인과 초기화를 한 문장으로 하고, 상태도 돌려받은 값(지금의 값)으로 판정한다 — 그 사이 정지됐으면 들이지 않는다.
    // 남는 틈(적은 뒤 세션을 만들기 전)은 호출부가 막는다 — 세션을 같은 계정 줄 안에서 만들고, 비밀번호 변경도 그 줄에 선다(`AuthService`)
    const [fresh] = await tx
      .update(users)
      .set(afterSuccess())
      .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash!)))
      .returning();
    if (!fresh) return { ok: false, reason: 'changed' };
    if (fresh.status === 'pending') return { ok: false, reason: 'pending' };
    if (fresh.status === 'suspended') return { ok: false, reason: 'suspended' };
    return { ok: true, user: fresh };
  }

  /** 확인하고 적는다 — 한 번에. 트랜잭션 없이 부르는 시험·도구용이다. 로그인은 둘을 나눠 부른다(연결을 쥐지 않게) */
  async verifyCredentials(username: string, password: string, now: Date = new Date(), tx: Db = this.db): Promise<CredentialResult> {
    return this.settleCredentials(await this.checkCredentials(username, password, now), now, tx);
  }
}
