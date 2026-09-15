/**
 * 시드 (CLAUDE.md 6절: 멱등, 운영은 최소 계정만).
 * - root 계정: WF_ROOT_USERNAME / WF_ROOT_INITIAL_PASSWORD / WF_ROOT_EMAIL (비밀번호가 없으면 건너뜀)
 *   v1에서 만든 'admin'(마이그레이션으로 root가 됨)이 있고 env의 root 사용자명이 아직 없으면 그 계정을 env 이름으로 바꾼다.
 * - 기본 카테고리 '일반'·'개발'·'운영'
 * - 개발(WF_ENV=development)에서만 합성 계정 admin1(admin)·member1(member)·pending1(승인 대기)과
 *   DEMO 팀 스페이스(root owner, member1 editor) + 개인 스페이스. 비밀번호는 root 초기 비밀번호와 같다.
 * 두 번 실행해도 결과가 같다.
 */
import { emptyDocument, generateSpaceKey, type DocNode } from '@workfluence/shared';
import * as argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomInt } from 'node:crypto';
import { Pool } from 'pg';
import { loadEnv } from '../config/config.module';
import * as schema from './schema';

type Db = NodePgDatabase<typeof schema>;
const key = () => generateSpaceKey((max) => randomInt(max));

async function ensureUser(db: Db, u: { username: string; displayName: string; email: string; role: string; status: string; password: string }) {
  const found = await db.query.users.findFirst({ where: eq(schema.users.username, u.username) });
  if (found) {
    // v1에서 email 없이 만들어진 계정이면 채운다 (ID·PWD 찾기에 email이 필요)
    if (!found.email) {
      const [row] = await db.update(schema.users).set({ email: u.email }).where(eq(schema.users.id, found.id)).returning();
      return { row, created: false };
    }
    return { row: found, created: false };
  }
  const [row] = await db
    .insert(schema.users)
    .values({
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      passwordHash: await argon2.hash(u.password, { type: argon2.argon2id }),
      role: u.role,
      status: u.status,
      approvedAt: u.status === 'active' ? new Date() : null,
    })
    .returning();
  return { row, created: true };
}

async function ensureCategory(db: Db, name: string, createdBy: string) {
  const found = await db.query.spaceCategories.findFirst({ where: eq(schema.spaceCategories.name, name) });
  if (found) return found;
  const [row] = await db.insert(schema.spaceCategories).values({ name, createdBy }).returning();
  return row;
}

async function ensureSpace(db: Db, s: { name: string; kind: string; categoryId: string | null; createdBy: string; description: string }) {
  const found = await db.query.spaces.findFirst({ where: and(eq(schema.spaces.name, s.name), eq(schema.spaces.createdBy, s.createdBy), isNull(schema.spaces.deletedAt)) });
  if (found) return { row: found, created: false };
  const [row] = await db.insert(schema.spaces).values({ key: key(), ...s }).returning();
  await db.insert(schema.spaceMembers).values({ spaceId: row.id, userId: s.createdBy, role: 'owner', addedBy: s.createdBy }).onConflictDoNothing();
  return { row, created: true };
}

async function ensureMember(db: Db, spaceId: string, userId: string, role: string, addedBy: string) {
  await db.insert(schema.spaceMembers).values({ spaceId, userId, role, addedBy }).onConflictDoNothing();
}

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.WF_DATABASE_URL });
  const db = drizzle(pool, { schema });
  try {
    if (!env.WF_ROOT_INITIAL_PASSWORD) {
      console.log('[seed] WF_ROOT_INITIAL_PASSWORD가 없어 계정 시드를 건너뛴다');
      return;
    }

    // root: env 이름의 계정이 없고 v1 root(옛 admin)가 있으면 이름을 맞춘다
    let root = await db.query.users.findFirst({ where: eq(schema.users.username, env.WF_ROOT_USERNAME) });
    if (!root) {
      const legacy = await db.query.users.findFirst({ where: eq(schema.users.role, 'root') });
      if (legacy) {
        [root] = await db
          .update(schema.users)
          .set({ username: env.WF_ROOT_USERNAME, email: legacy.email ?? env.WF_ROOT_EMAIL, displayName: '시스템 관리자' })
          .where(eq(schema.users.id, legacy.id))
          .returning();
        console.log(`[seed] v1 root 계정 '${legacy.username}' → '${root.username}'으로 이름 변경`);
      }
    }
    if (!root) {
      root = (await ensureUser(db, { username: env.WF_ROOT_USERNAME, displayName: '시스템 관리자', email: env.WF_ROOT_EMAIL, role: 'root', status: 'active', password: env.WF_ROOT_INITIAL_PASSWORD })).row;
      console.log(`[seed] root 계정 생성: ${root.username}`);
    } else {
      console.log(`[seed] root 계정 있음: ${root.username} (건너뜀)`);
    }

    const general = await ensureCategory(db, '일반', root.id);
    await ensureCategory(db, '개발', root.id);
    await ensureCategory(db, '운영', root.id);
    await ensureSpace(db, { name: `${root.displayName}의 개인 스페이스`, kind: 'personal', categoryId: general.id, createdBy: root.id, description: 'root의 개인 공간' });

    if (env.WF_ENV !== 'development') return;

    const pw = env.WF_ROOT_INITIAL_PASSWORD;
    const admin1 = (await ensureUser(db, { username: 'admin1', displayName: '관리자 하나', email: 'admin1@example.internal', role: 'admin', status: 'active', password: pw })).row;
    const member1 = (await ensureUser(db, { username: 'member1', displayName: '팀원 하나', email: 'member1@example.internal', role: 'member', status: 'active', password: pw })).row;
    await ensureUser(db, { username: 'pending1', displayName: '가입 대기자', email: 'pending1@example.internal', role: 'member', status: 'pending', password: pw });
    await ensureSpace(db, { name: `${admin1.displayName}의 개인 스페이스`, kind: 'personal', categoryId: general.id, createdBy: admin1.id, description: '' });
    await ensureSpace(db, { name: `${member1.displayName}의 개인 스페이스`, kind: 'personal', categoryId: general.id, createdBy: member1.id, description: '' });

    // v1의 DEMO 스페이스(name '데모 스페이스')가 있으면 재사용, 없으면 생성
    let demo = await db.query.spaces.findFirst({ where: and(eq(schema.spaces.key, 'DEMO'), isNull(schema.spaces.deletedAt)) });
    if (!demo) {
      demo = (await ensureSpace(db, { name: '데모 스페이스', kind: 'team', categoryId: general.id, createdBy: root.id, description: '합성 데이터로 만든 예시 팀 스페이스' })).row;
    }
    await db.update(schema.spaces).set({ kind: 'team', categoryId: demo.categoryId ?? general.id }).where(eq(schema.spaces.id, demo.id));
    await ensureMember(db, demo.id, root.id, 'owner', root.id);
    await ensureMember(db, demo.id, member1.id, 'editor', root.id);

    const firstPage = await db.query.pages.findFirst({ where: and(eq(schema.pages.spaceId, demo.id), isNull(schema.pages.deletedAt)) });
    if (!firstPage) {
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
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Crew 버튼에서 이 스페이스를 함께 쓰는 사람을 볼 수 있습니다.' }] }] },
            ],
          },
        ],
      };
      const text = content.content!.map((n) => (n.content ?? []).map((c) => c.text ?? '').join('')).join('\n');
      const [page] = await db
        .insert(schema.pages)
        .values({ spaceId: demo.id, parentId: null, title: '시작하기', position: 0, currentVersionNo: 1, searchText: text, createdBy: root.id, updatedBy: root.id })
        .returning();
      await db.insert(schema.pageVersions).values({ pageId: page.id, versionNo: 1, title: '시작하기', contentJson: content, contentText: text, createdBy: root.id });
      const [child] = await db
        .insert(schema.pages)
        .values({ spaceId: demo.id, parentId: page.id, title: '하위 페이지 예시', position: 0, currentVersionNo: 1, searchText: '', createdBy: root.id, updatedBy: root.id })
        .returning();
      await db.insert(schema.pageVersions).values({ pageId: child.id, versionNo: 1, title: '하위 페이지 예시', contentJson: emptyDocument(), contentText: '', createdBy: root.id });
    }
    console.log('[seed] 개발 계정 admin1·member1·pending1, 카테고리 3개, DEMO 팀 스페이스, 개인 스페이스 준비 완료');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[seed] 실패:', e);
  process.exit(1);
});
