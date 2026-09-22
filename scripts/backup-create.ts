import { BACKUP_COUNTED_TABLES, BACKUP_REQUIRED_FILES, formatChecksums } from '@workfluence/shared';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 백업 (P5_설계서_Release B절, FR-610~611·616).
 *
 * 대상은 **운영 형상의 compose 스택**이다 — 개발용 임베디드 PG가 아니다. 백업은
 * `pg_dump -Fc`(압축·병렬 복원 가능한 사용자 지정 형식)와 첨부 디렉토리 tar 둘이다.
 *
 * **스키마 버전을 함께 적는다** (FR-611). 옛 백업을 새 스키마에 부으면 조용히 깨지는데,
 * 그때 "이 백업이 어느 시점 것인가"를 알 방법이 이것뿐이다.
 */
const COMPOSE = ['compose', '-f', 'deploy/compose.yml', '--env-file', 'deploy/.env'];

function dc(args: string[], opts: { capture?: boolean } = {}): Buffer {
  return execFileSync('docker', [...COMPOSE, ...args], {
    maxBuffer: 1024 * 1024 * 512,
    stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
  }) as Buffer;
}

function psql(sql: string): string {
  return dc(['exec', '-T', 'postgres', 'psql', '-U', 'workfluence', '-d', 'workfluence', '-tAc', sql], { capture: true })
    .toString()
    .trim();
}

function main(): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(process.argv[2] ?? join('.local', 'backups', stamp));
  mkdirSync(out, { recursive: true });
  console.log(`[backup] ${out}`);

  // 세는 것을 **먼저** 한다. 덤프 도중 쓰기가 들어오면 수치와 덤프가 어긋나는데,
  // 먼저 세면 "적어도 이만큼은 있어야 한다"는 **하한**이 되어 복원 검사가 거짓 통과하지 않는다.
  // 복원 쪽도 이 값을 하한으로 쓴다 — 완전 일치를 요구하면 백업 도중에 로그인 하나만
  // 들어와도 복원이 다 끝난 뒤에 실패로 뒤집힌다 (`backup-restore.ts`)
  const migrations = psql(`SELECT count(*) FROM drizzle.__drizzle_migrations`);
  // 표 목록은 `packages/shared`에 있다. **복원도 같은 목록을 쓴다** — 복원이 이 파일의
  // 키를 읽어 SQL에 넣던 것이 주입 통로였다 (보안 검토 1)
  const counts = Object.fromEntries(BACKUP_COUNTED_TABLES.map((t) => [t, Number(psql(`SELECT count(*) FROM ${t}`))]));

  writeFileSync(join(out, 'dump.pgc'), dc(['exec', '-T', 'postgres', 'pg_dump', '-U', 'workfluence', '-Fc', 'workfluence'], { capture: true }));
  // **`exec api`를 쓰지 않는다.** 복원 절차는 api를 멈춘 뒤에 돌 수 있어야 하고, 백업도
  // 같은 이유로 떠 있는 컨테이너에 기대지 않는다 — `run --rm --no-deps`는 새 컨테이너를
  // 띄우므로 api가 멈춰 있어도 같게 동작한다 (`backup-restore.ts`의 같은 판단)
  writeFileSync(
    join(out, 'attachments.tar'),
    dc(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'api', '-cf', '-', '-C', '/data', 'attachments'], { capture: true }),
  );

  // **`BACKUP.json`을 먼저 쓰고 그것까지 체크섬에 넣는다.** 예전에는 체크섬을 먼저 만들고
  // 이 파일을 그 뒤에 써서, **대조 근거를 담은 파일이 무결성 검사 밖에** 있었다 (보안 검토 1)
  writeFileSync(
    join(out, 'BACKUP.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), migrations: Number(migrations), counts }, null, 2) + '\n',
  );
  const sums = BACKUP_REQUIRED_FILES.map((f) => ({
    file: f,
    sha256: createHash('sha256').update(readFileSync(join(out, f))).digest('hex'),
  }));
  writeFileSync(join(out, 'SHA256SUMS'), formatChecksums(sums));

  // 감사로그에 남긴다 (FR-616). 백업을 언제 떴는지는 사고 뒤에 가장 먼저 찾는 것이다
  psql(`INSERT INTO audit_events (action, target_type, detail) VALUES ('backup.create','system','${JSON.stringify({ path: out }).replace(/'/g, "''")}')`);

  console.log(`[backup] 완료 — 마이그레이션 ${migrations}개 · ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
}

main();
