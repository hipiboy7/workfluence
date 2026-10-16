import { NotFoundException } from '@nestjs/common';
import { idSchema, usernameSchema } from '@workfluence/shared';
import { UsersService } from '../users/users.service';

/** 사람 찾기의 좁은 면 (2절 ISP) — 시험은 진짜 `UsersService`를 넣는다 */
export type UserLookup = Pick<UsersService, 'findById' | 'findByUsername'>;

/**
 * 사람을 아이디(username)나 id로 — 목록을 "누가 만들었나"로 거를 때 (기능백로그 F-023). 에이전트는 채팅방 참여자의 아이디를 안다.
 * **없으면 404 `USER_NOT_FOUND`다** — 빈 목록으로 얼버무리면 오타를 "그 사람이 만든 것은 없다"로 잘못 읽는다(`resolveSpaceRef`와 같은 까닭).
 * 사람이 있는지 드러나는 것은 사용자 결정으로 받아들였다(2026-10-16 — "id 오픈되도 되")
 */
export async function resolveUserRef(users: UserLookup, ref: string): Promise<string> {
  const wanted = ref.trim();
  const asId = idSchema.safeParse(wanted);
  const asName = usernameSchema.safeParse(wanted.toLowerCase());
  const found = asId.success ? await users.findById(asId.data) : asName.success ? await users.findByUsername(asName.data) : undefined;
  if (!found) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '그런 사용자가 없다 — 아이디(username)나 id를 확인한다' });
  return found.id;
}

/** 있는 칸만 풀어 준다 — 안 준 칸은 그대로 비운다 */
export async function resolveUserRefs<K extends string>(users: UserLookup, refs: Partial<Record<K, string>>): Promise<Partial<Record<K, string>>> {
  const out: Partial<Record<K, string>> = {};
  for (const [k, v] of Object.entries(refs) as [K, string | undefined][]) if (v !== undefined) out[k] = await resolveUserRef(users, v);
  return out;
}
