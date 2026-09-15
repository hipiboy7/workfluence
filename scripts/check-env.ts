/**
 * pnpm check:env — CLAUDE.md 1.1절 0단계 환경 확인. 전부 통과하면 마지막 줄에 READY.
 * 검사: Node·pnpm 버전, .env 존재·스키마, 데이터 경로가 이 디렉토리의 .local/ 아래(D 드라이브)인지,
 *       드라이브 여유 공간, PostgreSQL 연결.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { parseEnv } from '../packages/shared/src/env';

const root = resolve(__dirname, '..');
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

async function main(): Promise<void> {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check('Node 24', nodeMajor === 24, `node ${process.versions.node}`);

  let pnpmVersion = '(없음)';
  try {
    pnpmVersion = execSync('pnpm --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    /* pnpm 미설치 */
  }
  const wanted = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).packageManager as string).split('@')[1];
  check('pnpm 버전 = packageManager', pnpmVersion === wanted, `pnpm ${pnpmVersion}, 요구 ${wanted}`);

  const envPath = resolve(root, '.env');
  check('.env 존재', existsSync(envPath), envPath);
  let env: ReturnType<typeof parseEnv> | undefined;
  if (existsSync(envPath)) {
    try {
      env = parseEnv(loadDotenv(envPath));
      check('.env 스키마 (WF_* strict)', true, `${Object.keys(env).length}개 키`);
    } catch (e) {
      check('.env 스키마 (WF_* strict)', false, (e as Error).message);
    }
  }

  const localDir = resolve(root, '.local');
  const onSameDrive = localDir.toLowerCase().startsWith(root.toLowerCase());
  check('데이터 경로 = 이 디렉토리의 .local/', existsSync(localDir) && onSameDrive, localDir);
  if (env) {
    const pgDir = resolve(root, env.WF_PG_EMBEDDED_DIR);
    check('WF_PG_EMBEDDED_DIR이 .local/ 아래', pgDir.toLowerCase().startsWith(localDir.toLowerCase()), pgDir);
  }

  try {
    const fs = statfsSync(root);
    const freeGb = (Number(fs.bavail) * Number(fs.bsize)) / 1024 ** 3;
    check('드라이브 여유 ≥ 3GB', freeGb >= 3, `${freeGb.toFixed(1)}GB 여유 (${root.slice(0, 2)})`);
  } catch (e) {
    check('드라이브 여유', false, (e as Error).message);
  }

  if (env) {
    const client = new Client({ connectionString: env.WF_DATABASE_URL, connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      const v = await client.query('select version()');
      check('PostgreSQL 연결', true, String(v.rows[0].version).split(',')[0]);
      const m = await client.query(
        "select count(*)::int as n from information_schema.tables where table_schema='drizzle' and table_name='__drizzle_migrations'",
      );
      check('마이그레이션 테이블', m.rows[0].n === 1, m.rows[0].n === 1 ? '적용 이력 있음' : '아직 없음 → pnpm db:migrate');
    } catch (e) {
      check('PostgreSQL 연결', false, `${(e as Error).message} → pnpm dev:db 로 임베디드 DB를 먼저 띄운다`);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name} — ${r.detail}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\nNOT READY (${failed.length}건 실패)`);
    process.exit(1);
  }
  console.log('\nREADY');
}

function loadDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
