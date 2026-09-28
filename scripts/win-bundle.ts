/**
 * F-009 — Docker 없이 Windows에서 받아서 풀고 바로 띄워 보는 묶음을 만든다 (백로그 F-009, 탐색 브랜치 `exp/windows-local`).
 *
 * **Windows에서** `pnpm build` 뒤에 돈다 — GitHub의 windows-latest 러너(`.github/workflows/windows-local.yml`). 묶음에 담는 네이티브 파일
 * (argon2, PostgreSQL, node.exe)이 이 스크립트를 돌리는 Windows의 것이어야 해서 Linux에서는 멈춘다.
 *
 * 만드는 폴더 `.local/win-bundle/workfluence/` — 워크플로가 그대로 결과물(artifact)로 올린다:
 * - `시작.cmd` · `멈추기.cmd` · `읽어보기.txt`
 * - `node/` — 이 스크립트를 돌리는 node.exe(러너는 24.21.0 — 운영 이미지와 같다)와 그 LICENSE
 * - `app/api/` — `pnpm --filter @workfluence/api deploy --legacy --prod`(운영 이미지와 같은 모양 — `deploy/Dockerfile`), `app/web/dist/`
 * - `app/launcher.mjs`(`scripts/win-launcher.mjs`) · `app/env.example`(`.env.example` — 처음 실행에서 설정 파일을 만든다)
 * - `app/links.json` — api의 node_modules는 pnpm이 폴더 연결로 짠다(Windows는 junction). zip은 연결을 담지 못하고, 연결을 따라 복사하면 pnpm의
 *   배치가 깨진다(패키지가 자기 의존성을 옆자리에서 찾는다). 그래서 연결을 목록으로 적고 지운다 — 여는 스크립트가 시작할 때 다시 만든다
 *   (junction은 관리자 권한 없이 만든다). pnpm의 평평한 배치(`node-linker=hoisted`)로 배포하면 node_modules가 비었다(pnpm 12.4.1, 2026-09-28)
 * - `pgsql/` — `@embedded-postgres/windows-x64`의 PostgreSQL 17과, 그것이 쓰는 VC++ 런타임 DLL(사용자 승인 2026-09-28 — Microsoft의 재배포
 *   허용 파일, `CLAUDE.md` 7절의 상용 구성 요소). 앱 폴더에 두면 Windows가 System32보다 먼저 찾는다
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(__dirname, '..');
const out = join(root, '.local', 'win-bundle', 'workfluence');

/** PostgreSQL 실행 파일이 쓰는 VC++ 런타임 — 있는 것만 옮긴다. 앞의 둘은 반드시 있어야 한다 */
const VC_RUNTIME = ['vcruntime140.dll', 'msvcp140.dll', 'vcruntime140_1.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'concrt140.dll'];

const README = `workfluence 체험 묶음 (Windows)

1. 이 폴더를 원하는 곳에 둔다. 경로는 영문이 안전하다(예: C:\\workfluence).
2. 시작.cmd 를 두 번 누른다.
   - 처음에는 데이터베이스를 만드느라 1~2분 걸린다.
   - "위키가 떴다"가 나오면 브라우저가 열린다(http://127.0.0.1:3000).
   - 처음 로그인: 아이디 root, 비밀번호는 그 창에 보인다. 첫 로그인에서 새 비밀번호로 바꾼다.
     잊었으면 data\\settings.env 의 WF_ROOT_PASSWORD 줄이다(첫 로그인 전까지만 쓸모 있다).
3. 멈추기: 그 창에서 Ctrl+C. 창을 그냥 닫았으면 멈추기.cmd 를 누른다.
4. 다시 쓰기: 시작.cmd 를 다시 누른다. 데이터는 data 폴더에 남는다.
5. 지우기: 멈춘 뒤 이 폴더를 통째로 지운다.

- "Windows의 PC 보호" 창이 뜨면 "추가 정보" -> "실행"을 누른다. 내려받은 파일이라 붙는 표시다
  (zip 파일의 속성에서 "차단 해제"를 켜고 풀면 뜨지 않는다).
- 이 컴퓨터 안에서만 접속을 받는다. 운영 설치가 아니다 — 암호화 연결(TLS) 없이 http로 뜬다. 합성 데이터로만 써 본다.

들어 있는 것: node\\ (Node.js — MIT, node\\LICENSE), pgsql\\ (PostgreSQL 17 — PostgreSQL License,
Microsoft Visual C++ 재배포 가능 런타임 DLL), app\\ (workfluence).
`;

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 실패 (종료 코드 ${r.status})`);
}

/** `.cmd`의 내용은 ASCII만 쓴다(명령 창은 시스템 코드 페이지로 읽는다). 줄 끝은 CRLF */
const cmdFile = (lines: string[]): string => lines.join('\r\n') + '\r\n';

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows에서만 만든다 — 묶음의 네이티브 파일(argon2·PostgreSQL·node.exe)이 이 컴퓨터의 것이어야 한다');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'app'), { recursive: true });

  // 1) api — 운영 이미지와 같은 모양(production 의존성만, 이 컴퓨터용 네이티브)
  run('pnpm', ['--filter', '@workfluence/api', 'deploy', '--legacy', '--prod', JSON.stringify(join(out, 'app', 'api'))]);
  // 1-1) 연결을 목록으로 — 모두 묶음 안을 가리켜야 한다
  const apiDir = join(out, 'app', 'api');
  const links: { path: string; target: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        const target = resolve(dirname(p), readlinkSync(p));
        if (!target.startsWith(apiDir + sep)) throw new Error(`묶음 밖을 가리키는 연결: ${p} -> ${target}`);
        links.push({ path: relative(apiDir, p), target: relative(apiDir, target) });
      } else if (st.isDirectory()) walk(p);
    }
  };
  walk(join(apiDir, 'node_modules'));
  for (const l of links) {
    const p = join(apiDir, l.path);
    try {
      unlinkSync(p);
    } catch {
      rmdirSync(p);
    }
  }
  writeFileSync(join(out, 'app', 'links.json'), JSON.stringify(links));
  // 2) 화면 — api가 `WF_WEB_DIST=../web/dist`로 찾는다
  cpSync(join(root, 'apps', 'web', 'dist'), join(out, 'app', 'web', 'dist'), { recursive: true });
  // 3) 여는 스크립트와 설정의 본
  cpSync(join(root, 'scripts', 'win-launcher.mjs'), join(out, 'app', 'launcher.mjs'));
  cpSync(join(root, '.env.example'), join(out, 'app', 'env.example'));
  // 4) Node — 이 스크립트를 돌리는 것
  mkdirSync(join(out, 'node'));
  cpSync(process.execPath, join(out, 'node', 'node.exe'));
  const nodeLicense = join(dirname(process.execPath), 'LICENSE');
  if (existsSync(nodeLicense)) cpSync(nodeLicense, join(out, 'node', 'LICENSE'));
  // 5) PostgreSQL — 개발 DB 스크립트(`scripts/dev-db.ts`)와 같은 길로 찾는다
  const fromEmbedded = createRequire(createRequire(__filename).resolve('embedded-postgres'));
  const pgEntry = fromEmbedded.resolve('@embedded-postgres/windows-x64');
  const { pg_ctl: pgCtl } = (await import(pathToFileURL(pgEntry).href)) as { pg_ctl: string };
  cpSync(dirname(dirname(pgCtl)), join(out, 'pgsql'), { recursive: true });
  let pkgDir = dirname(pgEntry);
  while (!existsSync(join(pkgDir, 'package.json')) && dirname(pkgDir) !== pkgDir) pkgDir = dirname(pkgDir);
  for (const f of readdirSync(pkgDir)) if (/^(license|copyright|notice)/i.test(f)) cpSync(join(pkgDir, f), join(out, 'pgsql', f));
  // 6) VC++ 런타임
  const sys32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const copied = VC_RUNTIME.filter((d) => existsSync(join(sys32, d)));
  if (!copied.includes('vcruntime140.dll') || !copied.includes('msvcp140.dll')) throw new Error(`VC++ 런타임이 이 컴퓨터에 없다: ${sys32}`);
  for (const d of copied) cpSync(join(sys32, d), join(out, 'pgsql', 'bin', d));
  // 7) 여는 명령과 읽어보기. 실패하면 창이 닫히지 않게 멈춘다(자동 확인은 TRIAL_NO_PAUSE=1)
  writeFileSync(
    join(out, '시작.cmd'),
    cmdFile(['@echo off', 'setlocal', '"%~dp0node\\node.exe" "%~dp0app\\launcher.mjs" start %*', 'if errorlevel 1 if not "%TRIAL_NO_PAUSE%"=="1" pause']),
  );
  writeFileSync(
    join(out, '멈추기.cmd'),
    cmdFile(['@echo off', 'setlocal', '"%~dp0node\\node.exe" "%~dp0app\\launcher.mjs" stop %*', 'if not "%TRIAL_NO_PAUSE%"=="1" pause']),
  );
  writeFileSync(join(out, '읽어보기.txt'), '\ufeff' + README.replace(/\n/g, '\r\n'));
  console.log(`[win-bundle] ${out} — 연결 ${links.length}개, VC++ 런타임 ${copied.join(', ')}`);
}

main().catch((e: unknown) => {
  console.error(`[win-bundle] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
