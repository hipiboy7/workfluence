/**
 * 시드 (CLAUDE.md 6절: 멱등, 운영은 최소 관리자·기본 역할만).
 * - 관리자 계정: WF_ADMIN_USERNAME / WF_ADMIN_INITIAL_PASSWORD (없으면 건너뜀)
 * - 개발(WF_ENV=development)에서만 합성 데모 스페이스 1개 + 시작 페이지 1개
 * 두 번 실행해도 결과가 같다.
 */
import { emptyDocument, type DocNode } from '@workfluence/shared';
import * as argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadEnv } from '../config/config.module';
import * as schema from './schema';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.WF_DATABASE_URL });
  const db = drizzle(pool, { schema });
  try {
    let admin = await db.query.users.findFirst({ where: eq(schema.users.username, env.WF_ADMIN_USERNAME) });
    if (!admin) {
      if (!env.WF_ADMIN_INITIAL_PASSWORD) {
        console.log('[seed] WF_ADMIN_INITIAL_PASSWORD가 없어 관리자 계정을 만들지 않는다');
        return;
      }
      const passwordHash = await argon2.hash(env.WF_ADMIN_INITIAL_PASSWORD, { type: argon2.argon2id });
      [admin] = await db
        .insert(schema.users)
        .values({ username: env.WF_ADMIN_USERNAME, displayName: '관리자', passwordHash, role: 'admin' })
        .returning();
      console.log(`[seed] 관리자 계정 생성: ${admin.username}`);
    } else {
      console.log(`[seed] 관리자 계정 있음: ${admin.username} (건너뜀)`);
    }

    if (env.WF_ENV !== 'development') return;

    let demo = await db.query.spaces.findFirst({ where: and(eq(schema.spaces.key, 'DEMO'), isNull(schema.spaces.deletedAt)) });
    if (!demo) {
      [demo] = await db
        .insert(schema.spaces)
        .values({ key: 'DEMO', name: '데모 스페이스', description: '합성 데이터로 만든 예시 스페이스', createdBy: admin.id })
        .returning();
      const content: DocNode = {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'workfluence 시작하기' }] },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '이 페이지는 시드가 만든 ' },
              { type: 'text', text: '합성 예시', marks: [{ type: 'bold' }] },
              { type: 'text', text: '입니다. 왼쪽 트리에서 페이지를 추가하고, 편집기에서 표·목록·코드 블록을 써 보세요.' },
            ],
          },
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '저장할 때마다 새 버전이 쌓이고 이력에서 복원할 수 있습니다.' }] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '두 사람이 같은 버전을 동시에 저장하면 뒤에 저장한 쪽이 충돌 안내를 받습니다.' }] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '검색은 한글 부분 일치로 동작합니다.' }] }] },
            ],
          },
        ],
      };
      const text = content.content!.map((n) => (n.content ?? []).map((c) => c.text ?? '').join('')).join('\n');
      const [page] = await db
        .insert(schema.pages)
        .values({ spaceId: demo.id, parentId: null, title: '시작하기', position: 0, currentVersionNo: 1, searchText: text, createdBy: admin.id, updatedBy: admin.id })
        .returning();
      await db.insert(schema.pageVersions).values({ pageId: page.id, versionNo: 1, title: '시작하기', contentJson: content, contentText: text, createdBy: admin.id });
      const [child] = await db
        .insert(schema.pages)
        .values({ spaceId: demo.id, parentId: page.id, title: '하위 페이지 예시', position: 0, currentVersionNo: 1, searchText: '', createdBy: admin.id, updatedBy: admin.id })
        .returning();
      await db.insert(schema.pageVersions).values({ pageId: child.id, versionNo: 1, title: '하위 페이지 예시', contentJson: emptyDocument(), contentText: '', createdBy: admin.id });
      console.log('[seed] 데모 스페이스(DEMO) + 페이지 2개 생성');
    } else {
      console.log('[seed] 데모 스페이스 있음 (건너뜀)');
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[seed] 실패:', e);
  process.exit(1);
});
