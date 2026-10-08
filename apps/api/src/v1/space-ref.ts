import { NotFoundException, ConflictException } from '@nestjs/common';
import { idSchema, matchSpaces, V1_DEFAULTS, type SpaceView } from '@workfluence/shared';
import type { SessionUser } from '../auth/auth.guard';
import { SpacesService } from '../spaces/spaces.service';

/** 내가 읽을 수 있는 스페이스 — 팀과 개인을 합쳐 한 목록으로(에이전트는 둘을 가르지 않는다). 읽지 못하는 것은 서비스가 이미 뺐다 */
export async function readableSpaces(spaces: SpacesService, me: SessionUser, filter: { q?: string } = {}, limit: number = V1_DEFAULTS.spaceLookupMax): Promise<SpaceView[]> {
  const [team, personal] = await Promise.all([spaces.list(me, 'team', limit, filter), spaces.list(me, 'personal', limit, filter)]);
  return [...new Map([...team, ...personal].map((s) => [s.id, s])).values()];
}

/**
 * 스페이스를 id나 이름으로 — 에이전트가 uuid를 외우지 않게. **이름이 겹치면 고르지 않고 후보를 준다**(임의로 고르면 엉뚱한 곳에 쓴다). 볼 수 없는
 * 스페이스는 없는 것과 같다 (docs/spinoff/public-api 설계서 3.5절)
 */
export async function resolveSpaceRef(spaces: SpacesService, ref: string, me: SessionUser): Promise<{ id: string; name: string }> {
  const notFound = () => new NotFoundException({ code: 'SPACE_NOT_FOUND', message: '스페이스를 찾을 수 없다' });
  if (idSchema.safeParse(ref.trim()).success) {
    try {
      const s = await spaces.get(ref.trim().toLowerCase(), me);
      return { id: s.id, name: s.name };
    } catch (e) {
      throw e instanceof NotFoundException ? notFound() : e;
    }
  }
  const found = matchSpaces(ref, await readableSpaces(spaces, me));
  if (found.length === 0) throw notFound();
  if (found.length > 1) {
    throw new ConflictException({
      code: 'SPACE_AMBIGUOUS',
      message: '같은 이름의 스페이스가 여럿이다 — id로 고른다',
      details: { candidates: found.map((s) => ({ id: s.id, name: s.name, kind: s.kind })) },
    });
  }
  return { id: found[0]!.id, name: found[0]!.name };
}
