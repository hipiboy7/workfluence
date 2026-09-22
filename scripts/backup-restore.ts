import { BACKUP_COUNTED_TABLES, BACKUP_REQUIRED_FILES, backupCounts, parseChecksums, verifyChecksums } from '@workfluence/shared';
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

/**
 * 첨부 볼륨을 만지는 명령. **`exec api`를 쓰지 않는다.**
 *
 * 복원 절차의 첫 단계는 "사람들이 계속 쓰지 못하게 api를 멈추는 것"이다
 * (`운영가이드_장애대응.md` 7.18절). 그런데 `docker compose exec`는 **떠 있는 컨테이너에만**
 * 붙는다 — 멈춘 뒤에 부르면 실패한다. 그러면 `pg_restore`는 이미 끝나 있고 첨부만 빠진
 * **절반 복원**으로 끝난다. 다시 돌리려 해도 "비어 있지 않다"로 거부되어 되돌릴 길이 없다.
 *
 * `run --rm --no-deps`는 **새 컨테이너를 띄운다.** api가 떠 있든 멈춰 있든 같게 동작하고,
 * 볼륨 이름을 손으로 적지 않아도 compose가 같은 마운트를 붙여 준다.
 */
const inAttachments = (args: string[], input?: Buffer, capture = false) =>
  dc(['run', '--rm', '--no-deps', '-T', '--entrypoint', args[0], 'api', ...args.slice(1)], input, capture);

function main(): void {
  const dir = resolve(process.argv[2] ?? '');
  if (!process.argv[2]) throw new Error('복원할 백업 디렉토리를 인자로 준다: pnpm backup:restore <디렉토리>');
  console.log(`[restore] ${dir}`);

  // 체크섬부터 본다. 상한 백업으로 복원하면 **부분 복원**이 되어 더 나쁘다.
  // 필수 파일이 **체크섬 목록에 올라 있는지도** 본다 — 목록에 없는 파일은 검사를 받지 않고
  // 통과하므로, 근거를 담은 파일이 빠져 있으면 대조 자체가 의미를 잃는다 (보안 검토 1)
  const expected = parseChecksums(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'));
  const listed = new Set(expected.map((e) => e.file));
  const unlisted = BACKUP_REQUIRED_FILES.filter((f) => !listed.has(f));
  if (unlisted.length) {
    throw new Error(`백업의 필수 파일이 체크섬 목록에 없다: ${unlisted.join(', ')}. 검사받지 않은 파일로는 복원하지 않는다`);
  }
  const actual = Object.fromEntries(
    readdirSync(dir).map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]),
  );
  const problems = verifyChecksums(expected, actual);
  if (problems.length) throw new Error(`백업이 온전하지 않다:\n  ${problems.join('\n  ')}`);

  const raw = JSON.parse(readFileSync(join(dir, 'BACKUP.json'), 'utf8')) as { migrations?: unknown; counts?: unknown };
  // **표 이름을 이 파일에서 읽지 않는다.** 예전에는 `counts`의 키를 그대로 SQL에 넣었고,
  // 백업 파일을 고칠 수 있는 사람이 키 이름에 SQL을 적으면 복원할 때 DB 관리자 권한으로
  // 실행됐다. 목록은 `packages/shared`의 것을 쓰고, 이 파일에서는 **숫자만** 받는다.
  // 숫자가 아니면 `NaN`이 되어 어떤 비교에도 걸리지 않고 대조를 통째로 건너뛴다 (보안 검토 1)
  const meta = { migrations: Number(raw.migrations), counts: backupCounts(raw.counts) };

  // **비어 있는지 확인한다.** public 스키마에 표가 하나라도 있으면 거부한다
  const tables = Number(psql(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`));
  if (tables > 0) {
    throw new Error(
      `대상 데이터베이스가 비어 있지 않다 (public 표 ${tables}개). ` +
        `덮어쓰기 복원은 남은 것이 섞여 성공처럼 보인다 — 빈 볼륨에서 다시 시도한다.`,
    );
  }

  dc(['exec', '-T', 'postgres', 'pg_restore', '-U', 'workfluence', '-d', 'workfluence', '--no-owner'], readFileSync(join(dir, 'dump.pgc')));
  inAttachments(['tar', '-xf', '-', '-C', '/data'], readFileSync(join(dir, 'attachments.tar')));

  // 대조 (FR-614). **백업 시점의 수치는 하한이다.**
  //
  // 백업은 세는 것을 덤프보다 먼저 한다(`backup-create.ts`). 그래서 백업 도중에 쓰기가
  // 들어오면 **덤프가 더 많이** 담는다 — 주간 백업은 서비스가 도는 채로 뜨므로 로그인 하나만
  // 끼어도 `audit_events`가 늘어난다. 완전 일치를 요구하면 **복원이 다 끝난 뒤에** 그걸
  // 불일치로 보고 예외를 던지고, DB는 이미 비어 있지 않아 다시 시도할 수도 없다.
  // 모자란 것만 실패로 본다. 넘치는 것은 알려 주기만 한다.
  const after = Object.fromEntries(BACKUP_COUNTED_TABLES.map((t) => [t, Number(psql(`SELECT count(*) FROM ${t}`))]));
  const missing = Object.entries(meta.counts).filter(([t, n]) => after[t] < n);
  const extra = Object.entries(meta.counts).filter(([t, n]) => after[t] > n);
  const files = Number(inAttachments(['sh', '-lc', 'find /data/attachments -type f | wc -l'], undefined, true).trim());
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
  if (missing.length) {
    throw new Error(
      `복원 뒤 행이 모자란다: ${missing.map(([t, n]) => `${t} ${n} → ${after[t]}`).join(', ')}. ` +
        `백업 시점의 수치는 하한이므로 이것은 실제 손실이다`,
    );
  }
  if (extra.length) {
    // 백업을 뜨는 동안 들어온 쓰기다. 손실이 아니므로 실패로 보지 않는다
    console.log(`[restore] 참고: 백업 도중 들어온 쓰기 — ${extra.map(([t, n]) => `${t} ${n} → ${after[t]}`).join(', ')}`);
  }

  psql(`INSERT INTO audit_events (action, target_type, detail) VALUES ('backup.restore','system','${JSON.stringify({ from: dir }).replace(/'/g, "''")}')`);
  console.log('[restore] 완료 — 백업 시점의 행 수를 모두 채웠다');
}

main();
