import * as argon2 from 'argon2';
import { availableParallelism } from 'node:os';
import { argonSlots, NODE_DEFAULT_THREADPOOL } from '../auth/domain/argon-slots';
import { ConcurrencyGate } from '../auth/domain/concurrency-gate';

/**
 * 비밀번호 해시와 확인 (P13_설계서_Readiness D.4, FR-1430·1433). B등급.
 *
 * **한 프로세스의 argon2를 한 줄에 세운다** — 코어 수까지, 그리고 Node의 작업 스레드 풀에 한 자리를 남기고(`argonSlots`) 한꺼번에 돈다.
 * argon2는 한 건이 코어 하나를 넘게 쓴다(`p=4`). 한꺼번에 여럿을 돌려도 처리량은 그대로인데, 요청을 처리하는 스레드의 CPU를 빼앗아 다른
 * 사람의 요청이 늦어진다(P13 측정 S0a·S2). 풀을 다 쥐면 화면 파일·첨부의 읽기·쓰기가 argon2 뒤에 선다(병합 전 코드 리뷰 9).
 *
 * **호출부는 DB 트랜잭션을 연 채 부르지 않는다.** 연결을 쥔 채 해싱하면 로그인이 몰릴 때 남의 요청이 연결 풀을 기다린다(보류 16 —
 * 몰린 동안 연결 10개가 모두 idle in transaction이었다). 줄에서 기다리는 동안에도 연결을 쥐지 않는다.
 */
const gate = new ConcurrencyGate(argonSlots(availableParallelism(), NODE_DEFAULT_THREADPOOL));

/**
 * 어떤 비밀번호와도 맞지 않는 argon2id 해시. 앱의 해시와 **같은 옵션**이다(검증 시간은 해시에 적힌 옵션을 따른다).
 * **계정이 없을 때, 비밀번호가 없는 계정일 때, 잠긴 계정일 때도 이것으로 한 번 돌린다** — 안 그러면 그런 계정만 빨리 답해서 응답 시간으로
 * 계정 상태가 새어 나간다 (P1_설계서_Auth 2.2절, P13 FR-1432 — 잠긴 계정은 약 5ms, 다른 실패는 130~170ms였다)
 */
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$QkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY';

export function hashPassword(pw: string): Promise<string> {
  return gate.run(() => argon2.hash(pw, { type: argon2.argon2id }));
}

export function verifyPassword(hash: string, pw: string): Promise<boolean> {
  return gate.run(() => argon2.verify(hash, pw));
}

/** 결과를 쓰지 않는 확인 한 번 — 응답 시간을 맞추려고 돈다 */
export async function burnPasswordCheck(pw: string): Promise<void> {
  await gate.run(() => argon2.verify(DUMMY_HASH, pw)).catch(() => false);
}
