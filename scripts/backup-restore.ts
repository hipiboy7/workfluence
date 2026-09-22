import { parseChecksums, verifyChecksums } from '@workfluence/shared';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 복원 (P5_설계서_Release B절, FR-612~617).
 *
 * **빈 볼륨에만 복원한다** (FR-613). 덮어쓰기 복원은 남아 있던 것이 섞여 성공처럼 보인다 —
 * 정작 복원이 안 된 표가 있어도 옛 데이터가 그 자리를 채우고 있으면 알 수 없다.
 *
 * 복원 뒤 **백업 시점의 수치와 대조**해 출력한다 (FR-614). "복원 완료"라는 말은
 * 근거가 아니다.
 */
const COMPOSE = ['compose', '-f', 'deploy/compose.yml', '--env-file', 'deploy/.env'];

function dc(args: string[], input?: Buffer, capture = false): string {
  const r = execFileSync('docker', [...COMPOSE, ...args], {
    input,
    maxBuffer: 1024 * 1024 * 512,
    stdio: [input ? 'pipe' : 'ignore', capture ? 'pipe' : 'inherit', 'inherit'],
  });
  return capture ? r.toString() : '';
}

const psql = (sql: string) =>
  dc(['exec', '-T', 'postgres', 'psql', '-U', 'workfluence', '-d', 'workfluence', '-tAc', sql], undefined, true).trim();

function main(): void {
  const dir = resolve(process.argv[2] ?? '');
  if (!process.argv[2]) throw new Error('복원할 백업 디렉토리를 인자로 준다: pnpm backup:restore <디렉토리>');
  console.log(`[restore] ${dir}`);

  // 체크섬부터 본다. 상한 백업으로 복원하면 **부분 복원**이 되어 더 나쁘다
  const expected = parseChecksums(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'));
  const actual = Object.fromEntries(
    readdirSync(dir).map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]),
  );
  const problems = verifyChecksums(expected, actual);
  if (problems.length) throw new Error(`백업이 온전하지 않다:\n  ${problems.join('\n  ')}`);

  const meta = JSON.parse(readFileSync(join(dir, 'BACKUP.json'), 'utf8')) as {
    migrations: number;
    counts: Record<string, number>;
  };

  // **비어 있는지 확인한다.** public 스키마에 표가 하나라도 있으면 거부한다
  const tables = Number(psql(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`));
  if (tables > 0) {
    throw new Error(
      `대상 데이터베이스가 비어 있지 않다 (public 표 ${tables}개). ` +
        `덮어쓰기 복원은 남은 것이 섞여 성공처럼 보인다 — 빈 볼륨에서 다시 시도한다.`,
    );
  }

  dc(['exec', '-T', 'postgres', 'pg_restore', '-U', 'workfluence', '-d', 'workfluence', '--no-owner'], readFileSync(join(dir, 'dump.pgc')));
  dc(['exec', '-T', 'api', 'tar', '-xf', '-', '-C', '/data'], readFileSync(join(dir, 'attachments.tar')));

  // 대조 (FR-614). 하나라도 어긋나면 **성공이라고 말하지 않는다**
  const after = Object.fromEntries(Object.keys(meta.counts).map((t) => [t, Number(psql(`SELECT count(*) FROM ${t}`))]));
  const mism = Object.entries(meta.counts).filter(([t, n]) => after[t] !== n);
  const files = Number(dc(['exec', '-T', 'api', 'sh', '-lc', 'find /data/attachments -type f | wc -l'], undefined, true).trim());
  // **행 수가 아니라 서로 다른 해시 수와 비교한다** (FR-615). 같은 내용을 여러 메타데이터가
  // 가리키므로(FR-413) 행 수와 파일 수는 원래 다르다 — 그것을 불일치로 읽으면 매번 거짓 경보다
  const blobs = Number(psql(`SELECT count(DISTINCT sha256) FROM attachments WHERE deleted_at IS NULL`));

  console.log(`[restore] 행 수 대조: ${Object.entries(after).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`[restore] 첨부 — DB가 가리키는 파일 ${blobs}개 · 디스크에 있는 파일 ${files}개`);
  if (files < blobs) {
    throw new Error(`첨부 파일이 ${blobs - files}개 모자란다. DB는 있는데 실체가 없는 첨부가 생긴다`);
  }
  if (files > blobs) {
    console.log(`[restore] 참고: 아무도 안 쓰는 파일이 ${files - blobs}개 있다 (pnpm trash:purge가 정리한다)`);
  }
  if (mism.length) {
    throw new Error(`복원 뒤 수치가 백업 시점과 다르다: ${mism.map(([t, n]) => `${t} ${n}→${after[t]}`).join(', ')}`);
  }

  psql(`INSERT INTO audit_events (action, target_type, detail) VALUES ('backup.restore','system','${JSON.stringify({ from: dir }).replace(/'/g, "''")}')`);
  console.log('[restore] 완료 — 백업 시점과 모든 행 수가 같다');
}

main();
