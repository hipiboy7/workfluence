import { ConflictException } from '@nestjs/common';
import { PAGE_TREE_LOCK_WAIT_MS } from '@workfluence/shared';
import { sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import type { Db } from '../db/db.module';

/** 잠금 대기가 한도를 넘었다 — PostgreSQL `lock_not_available`(55P03). drizzle은 원래 오류를 `cause`에 싣는다 */
function isLockTimeout(e: unknown): boolean {
  const codeOf = (x: unknown) => (typeof x === 'object' && x !== null && 'code' in x ? (x as { code?: unknown }).code : undefined);
  return codeOf(e) === '55P03' || codeOf((e as { cause?: unknown } | null)?.cause) === '55P03';
}

/**
 * **한 스페이스의 페이지 트리를 바꾸는 일은 줄을 선다** (P14_설계서_Spaces D.1, FR-1503) — 옮기기·만들기·지우기·되살리기.
 *
 * 옮기기만 줄을 세우면 옆의 일과 엇갈린다(병합 전 코드 리뷰 6·자체 점검 10) — 깊이 9 아래로 옮기는 사이 그 아래에 만들면 깊이 11이 되고, 지우는
 * 부모 아래로 옮기면 고아가 생기고, 동시에 만들면 자리가 겹친다. 잠금 이름은 이 저장소의 다른 줄 세우기와 같은 모양이다(`users:last-root`).
 *
 * **기다림은 `PAGE_TREE_LOCK_WAIT_MS`까지** — 기다리는 동안 연결을 쥐므로, 끝없이 기다리면 한 사람이 옮기기를 거듭 보내 연결 풀을 말린다(T-026,
 * 병합 전 보안 검토 1). 넘으면 409 — 잠시 뒤 다시 한다. 잠금은 트랜잭션이 끝나면 풀린다 — **트랜잭션 안에서 부른다.** 밖에서 부르면 잠금이
 * 그 문장 하나로 끝나 줄 세우기가 오류 없이 사라지므로 막는다(반영분 점검 10). 부르는 쪽은 잠근 뒤 대상을 **다시 읽는다** — 기다리는 사이 누가
 * 지우거나 옮겼을 수 있다(반영분 점검 1)
 */
export async function lockTree(tx: Db, spaceId: string): Promise<void> {
  if (!((tx as unknown) instanceof PgTransaction)) throw new Error('lockTree는 트랜잭션 안에서 부른다');
  const prev = (await tx.execute<{ lock_timeout: string }>(sql`SELECT current_setting('lock_timeout') AS lock_timeout`)).rows[0].lock_timeout;
  await tx.execute(sql`SELECT set_config('lock_timeout', ${`${PAGE_TREE_LOCK_WAIT_MS}ms`}, true)`);
  try {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`page-tree:${spaceId}`}))`);
  } catch (e) {
    if (isLockTimeout(e)) throw new ConflictException('이 스페이스의 페이지 트리를 다른 사람이 바꾸는 중이다 — 잠시 뒤 다시 한다');
    throw e;
  }
  // 이 트랜잭션의 다른 잠금(형제 줄 고치기 등)은 원래 한도대로 기다린다 — 잠금 대기 상한은 트리 잠금에만
  await tx.execute(sql`SELECT set_config('lock_timeout', ${prev}, true)`);
}
