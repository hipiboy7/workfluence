# linux서버배포가이드 — 리눅스 서버에서 이미지를 만들고 반입 묶음을 싼다

- 자리: `docs/guide/shortcut/` — 바로가기다. 들고 갈 것을 만드는 쪽의 절차이고, 폐쇄망에서 하는 일은 [설치및실행가이드](../설치및실행가이드.md)다 (2026-09-30 옮김 — 옛 이름 운영가이드_리눅스빌드.md)

- 읽는 사람: **개발·빌드 서버(사내 Linux)에서 앱 이미지를 만들고, 띄워 확인하고, 폐쇄망 반입 묶음을 만드는 사람**
- 이 서버는 개발과 빌드를 **같이 한다** (`CLAUDE.md` 0.3절). 다른 프로젝트와 함께 쓰는 공유 서버다 — 저장소와 Node·pnpm이 있다
- 목적: `main`의 지금 코드로 앱 이미지를 만들고(빌드한 커밋을 라벨로 단다) → 이 서버에서 띄워 살아 있는지 보고 → 반입 묶음을 만들어
  검사한 뒤 → tar 하나로 싸서 반입 매체에 담는다(대상 서버에 Docker가 없으면 Docker 묶음도 — 12-1절). 폐쇄망에서 하는 일은 [`docs/guide/설치및실행가이드.md`](../설치및실행가이드.md)다
- 작성일: 2026-09-17 / 개정: 2026-09-21 (첫 실행에서 드러난 것 반영), 2026-09-27 (Phase 13 — Phase 0 기준이던 것을 지금 코드로 다시
  썼다: `main`을 받는다, `deploy/.env`의 필수 키 셋과 첫 root 비밀번호, 커밋 라벨을 단 빌드, 앱 계정이 있어 표 만들기가 앱보다 먼저, 반입 묶음 12절)
  , 2026-09-30 (Phase 20 — 대상 서버에 Docker가 없을 때 들고 갈 Docker 묶음 12-1절) / 작성 LLM: Claude Opus 5, 개정 Claude Opus 5.5

> **이 문서의 명령은 bash다.** 도커·git 명령은 그대로 적고, 저장소의 도구는 `pnpm <script>`로 적는다 (`CLAUDE.md` 4.1절).
> **명령은 모두 저장소의 맨 위 디렉토리에서 친다** — 그래서 compose 파일을 `-f deploy/compose.yml --env-file deploy/.env`로 가리킨다.
> 폐쇄망의 가이드는 묶음을 푼 디렉토리에서 치므로 `-f compose.yml --env-file .env`다. 가리키는 파일은 같다.

## 1. 서버에 무엇이 있어야 하나

| 필요한 것 | 확인 |
|---|---|
| Docker 24 이상 | `docker --version` |
| Docker Compose v2 이상 (띄어 쓴 `docker compose`) | `docker compose version` |
| git | `git --version` |
| 도커가 쓰는 디스크의 여유 5GB 이상 | `df -h /var/lib/docker` — 이 서버는 데이터 디스크다(`CLAUDE.md` 8.2절) |
| `openssl` | `openssl version` — 4절에서 비밀번호를 만든다 |
| Node 24와 pnpm — **12절(묶음 만들기)에만** 필요하다 | `node --version` · `pnpm --version` |
| Docker CE가 Docker의 RHEL 저장소 RPM으로 깔려 있다 — **12-1절(Docker 묶음)에만** 필요하다 | `rpm -q docker-ce` · `dnf repolist`에 `docker-ce-stable` |
| 이 저장소를 받을 수 있는 곳 | `git clone`이 되는지 |
| **빌드 컨테이너가 인터넷에 나갈 수 있는 곳** | 아래 1.1절 |

**이미지를 만드는 일(5절)에는 Node와 pnpm이 필요 없다.** 의존성 설치와 빌드가 전부 이미지 안에서 일어난다. 묶음을 만드는 스크립트
(`pnpm release:bundle`)가 저장소의 도구라서 12절에만 필요하다. 이 서버에서는 둘 다 **사용자 홈에** 둔다 — 공유 서버라 시스템 전역에
깔지 않는다 (`CLAUDE.md` 8.1절).

#### 1.1 `git clone`이 된다고 빌드가 되는 것은 아니다

프록시 뒤에 있는 서버에서는 **`clone`은 되는데 빌드는 막힐 수 있다.** 셸에는 프록시
환경변수가 있어 `git`이 쓰지만, 도커 빌드 안의 `RUN` 단계는 그것을 물려받지 못하기
때문이다. 도커 데몬에만 프록시가 설정돼 있으면 **베이스 이미지 받기까지는 성공**해서
더 헷갈린다. 2026-09-21 첫 실행에서 실제로 이 일이 났고 `npm install`이 471초 뒤
`ETIMEDOUT`으로 죽었다.

미리 한 줄로 확인한다. 값이 나오면 프록시 뒤에 있는 것이고, 그래도 괜찮다 —
`deploy/compose.yml`이 이 값을 빌드에 넘기도록 돼 있다.

```bash
echo "${HTTP_PROXY:-(프록시 없음)}"
```

셸에 값이 있는데도 빌드가 네트워크에서 막히면 10절을 본다.

**pnpm(과 그것을 붙이는 corepack)은 `NODE_USE_ENV_PROXY=1`이 있어야 프록시를 쓴다.** Node에 들어 있는 요청 기능은 프록시 환경변수를
기본으로 무시한다 — `npm`은 되는데 pnpm만 안 되는 것처럼 보인다 (`CLAUDE.md` 8.1절, T-014). 12절 전에 셸에 둔다.

```bash
export NODE_USE_ENV_PROXY=1
```

## 2. 이 문서로 하는 일과 적을 값

| 순서 | 절 | 하는 일 |
|---|---|---|
| 1 | 3절 | `main`을 받는다 |
| 2 | 4절 | `deploy/.env`를 만든다 — 필수 키 셋과 첫 root 비밀번호 |
| 3 | 5절 | 앱 이미지를 만든다 — 빌드한 커밋을 라벨로 단다 |
| 4 | 6절 | 데이터베이스를 띄우고 표와 첫 root 계정을 만든다 — **앱보다 먼저** |
| 5 | 7~9절 | 앱을 띄우고 살아 있는지 본다 |
| 6 | 12절 | 반입 묶음을 만들어 검사하고 tar 하나로 싼다 |
| 6-1 | 12-1절 | (대상 서버에 Docker가 없을 때만) Docker 묶음을 만든다 |
| 7 | 13절 | 정리한다 |

적을 값 — 그 Phase의 검증기록과 PR 설명에 적는다(14절). **넘겼는지보다 실제 값이 중요하다.** 넘지 못하면 왜 그런지 찾아서 고치는 것이
다음 일이다.

| # | 항목 | 어느 단계에서 나오나 | 목표 |
|---|---|---|---|
| 1 | Docker 버전과 Compose 버전 | 3절 | 24 이상, v2 이상 |
| 2 | 디스크 여유 | 3절 | 5GB 이상 |
| 3 | 빌드한 커밋과 **이미지 크기** | 5절 | **400MB 이하** |
| 4 | **기동 시간** | 7절 | **30초 이내** |
| 5 | **헬스체크 응답 원문** | 8절 | `{"status":"ok","db":"ok",...}` |
| 6 | 재시작 정책 (재부팅 실측은 소유자 합의 후) | 11절 | `unless-stopped` + 도커 `enabled` |
| 7 | 묶음의 `MANIFEST.txt`, 검사 결과, tar 크기 | 12절 | `[verify] 통과` |

## 3. 받아서 준비한다

```bash
git clone https://github.com/hipiboy7/workfluence.git
cd workfluence
git checkout main
```

이미 받아 둔 저장소가 있으면 위 대신 이렇게 한다.

```bash
cd workfluence
git fetch origin
git checkout main
git pull --ff-only
```

**반입할 묶음은 `main`에서 만든다.** Phase 도중에 빌드·기동을 확인할 때는 그 Phase 브랜치(`impl-phase{N}`)를 받아도 된다 — 그때 만든
묶음은 반입하지 않는다.

작업 폴더가 깨끗한지 본다.

```bash
git status --short
git log -1 --oneline
```

**`git status --short`가 아무것도 내지 않아야 한다.** 이미지는 작업 폴더에 있는 그대로 만들어지는데, 라벨(5절)은 커밋 번호만 적는다 —
커밋하지 않은 변경이 있으면 **라벨과 내용이 다른 이미지**가 반입된다.

**여기서 값 1·2를 적는다.**

```bash
docker --version
docker compose version
df -h /var/lib/docker
```

> 디스크 여유가 **5GB 미만이면 빌드하지 않는다.** 빌드 중 디스크가 차면 옆 컨테이너의 쓰기까지 깨지고 원인 추적이 어려워진다 (`CLAUDE.md` 8.2절).

#### 3.1 공유 서버에서 공간을 비우는 방법

**`docker system prune`을 쓰지 않는다.** 그 명령은 **멈춰 있는 컨테이너를 전부 지운다.** 다른 프로젝트가 잠시 내려 둔 컨테이너까지 함께 사라진다. 이 서버를 혼자 쓰는 것이 아니면 아래 순서로 좁게 비운다.

```bash
docker system df                  # 무엇이 공간을 먹는지 먼저 본다
docker builder prune -f           # ① 빌드 캐시만. 가장 안전하고 보통 가장 크다
docker image prune -f             # ② 태그 없는 중간 이미지만. 태그 붙은 이미지는 건드리지 않는다
```

①②로 부족하면 **거기서 멈추고 서버 소유자와 확인한다.** 아래는 이름을 하나씩 확인한 뒤에만 한다.

```bash
docker images                     # 지울 대상을 눈으로 고른다
docker rmi <이미지이름:태그>       # 하나씩
```

전에 만든 반입 묶음(12절)도 크다 — 매체에 옮겼으면 `ls -lh .local/release/`로 보고 지운다(13절).

**절대 하지 않는 것**

| 명령 | 왜 |
|---|---|
| `docker system prune` | 다른 프로젝트의 멈춘 컨테이너와 네트워크를 지운다 |
| `docker volume prune` | **데이터가 사라진다.** 남의 데이터일 수도 있다 |
| `docker rmi -f $(docker images -q)` | 이름을 보지 않고 전부 지운다 |

우리 스택이 쓰는 볼륨은 **`deploy_postgres_data`**와 **`deploy_attachments`** 둘이고(첨부 볼륨은
Phase 3에서 생겼다), 둘 다 확인이 끝난 뒤 13절에서만 지운다. compose 파일이 `deploy/`에 있어
프로젝트 이름이 `deploy`로 잡히고 볼륨 이름 앞에 붙는다. `docker volume ls`에서 찾을 때
`postgres_data`·`attachments`로는 안 나온다.

**이 둘 말고는 건드리지 않는다.** 이 서버는 다른 프로젝트와 공유한다.

## 4. 환경 파일을 만든다 — `deploy/.env`

compose가 읽는 값이다. **파일이 없을 때** 아래를 그대로 치면 비밀번호를 새로 만들어 넣는다. 이미 있으면 아무것도 하지 않는다.

```bash
test -e deploy/.env || cat > deploy/.env <<EOF
WF_PG_PASSWORD=$(openssl rand -hex 16)
WF_PG_APP_PASSWORD=$(openssl rand -hex 16)
WF_SESSION_SECRET=$(openssl rand -hex 32)
WF_ROOT_PASSWORD=$(openssl rand -hex 12)
EOF
chmod 600 deploy/.env
grep -o '^WF_[A-Z_]*=' deploy/.env
```

마지막 줄에 키 이름 넷이 보여야 한다(값은 보이지 않는다).

**이미 있는 파일은 덮어쓰지 않는다.** `WF_PG_PASSWORD`는 데이터베이스를 처음 만들 때만 먹는다 — 볼륨에 데이터베이스가 있는데 값을
바꾸면 붙지 못한다. Phase 13 전에 만든 파일에는 `WF_PG_APP_PASSWORD`가 없다. 마지막 줄에 그 키가 안 보이면 더한다.

```bash
grep -q '^WF_PG_APP_PASSWORD=.' deploy/.env || echo "WF_PG_APP_PASSWORD=$(openssl rand -hex 16)" >> deploy/.env
```

| 키 | 필요한가 | 뜻 · 없으면 |
|---|---|---|
| `WF_PG_PASSWORD` | **필수** | 데이터베이스 소유 계정(`workfluence`)의 비밀번호. 표를 만드는 `tools`(6절)가 쓴다. 없으면 compose가 기동을 거부하고 이유를 출력한다 |
| `WF_PG_APP_PASSWORD` | **필수** (Phase 13) | 앱 계정(`workfluence_app`)의 비밀번호. 기동 중인 앱이 이 계정으로 붙는다. 계정은 6절의 표 만들기가 만든다. 없으면 compose가 거부한다 |
| `WF_SESSION_SECRET` | **필수** | 세션 서명 키. 32자 이상. 없으면 compose가 거부하고, 짧으면 앱이 거부한다 |
| `WF_ROOT_PASSWORD` | 첫 root를 만들 때 | 6절의 시드가 쓴다. 계정이 이미 있으면 쓰이지 않는다 |
| `WF_LOG_LEVEL` | 선택 | `info` |
| `WF_HTTPS_PORT` | 선택 | `8443` (nginx를 띄울 때만 쓴다) |
| `WF_APP_IMAGE` | **반입 묶음을 만들 때는 두지 않는다** | 비우면 `workfluence-app:latest`. 폐쇄망의 compose는 이 이름을 찾는다 — 다른 이름으로 묶으면 거기서 `up -d`가 "이미지 없음"으로 죽는다 |

값을 손으로 넣을 때는 `openssl rand -hex …`처럼 숫자와 a~f만 쓴다. 비밀번호는 데이터베이스 접속 주소에 그대로 들어가서 `/ ? # %`가
있으면 주소가 깨지고, `$`는 compose가 변수로 읽는다.

> **왜 저장소 루트의 `.env`가 아니라 `deploy/.env`인가.** 루트 `.env`는 **개발용**이다 (`CLAUDE.md` 8.1절). 한 파일에 둘을 섞으면 앱이 기동을 거부한다 — 앱의 환경변수 스키마는 strict라서 compose 전용 키인 `WF_PG_PASSWORD`를 **모르는 키로 보고 죽는다.** 이 서버에서 빌드만 한다면 어느 쪽이든 상관없지만, 같은 서버에서 개발도 하면 반드시 갈라야 한다 (T-015).

`deploy/.env`는 커밋하지 않는다. 저장소의 `.gitignore`가 이미 막고 있다 (`git check-ignore -v deploy/.env`로 확인된다).

## 5. 이미지를 만든다 — 값 3

```bash
deploy/build.sh
```

**빌드는 compose가 아니라 `deploy/build.sh`가 한다**(`docker build`) — compose는 만들어 둔 이미지를 띄우기만 한다. 스크립트가 `GIT_SHA`를 넣는다. 이미지에 빌드한 커밋이 라벨(`org.opencontainers.image.revision`)로 붙는다. 반입 묶음을 만들 때(12절)
이 라벨이 저장소의 지금 커밋과 다르면 **묶지 않는다** — 다른 커밋으로 만든 이미지를 반입하지 않게. 빼면 라벨이 `unknown`이 된다.

처음 빌드는 의존성 설치까지 하므로 몇 분 걸린다. 끝나면 라벨과 크기를 본다.

```bash
docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' workfluence-app:latest
git rev-parse HEAD
docker images workfluence-app --format '{{.Repository}}:{{.Tag}}  {{.Size}}'
```

앞의 두 줄이 같아야 한다. **여기서 값 3(커밋과 이미지 크기)을 적는다.**

크기 칸의 이름이 도커 버전마다 다르다. Docker 28까지는 `SIZE` 한 칸이고, **Docker 29는
`DISK USAGE`와 `CONTENT SIZE`로 갈린다.** 400MB 목표와 비교할 값은 앞의 것이다.
위의 `--format`은 버전에 상관없이 그 값을 낸다.

커밋을 특정할 수 있게 태그를 하나 더 붙여 둔다 (`CLAUDE.md` 8.2절). 묶음에 담기는 것은 compose가 쓰는 `workfluence-app:latest`다.

```bash
docker tag workfluence-app:latest workfluence-app:$(git rev-parse --short HEAD)
docker images workfluence-app
```

## 6. 데이터베이스를 띄우고 표와 첫 계정을 만든다 — **앱보다 먼저**

이 서버에서 처음 올리는 것이면 **postgres·nginx 이미지를 먼저 받아 둔다.** 안 그러면 내려받는 시간이 기동 시간에 섞여 값이 몇 배로
나오고, 12절의 묶음도 이 둘을 담는다. 5절은 앱 이미지만 만든다.

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env pull postgres nginx
```

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env up -d postgres
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm tools node dist/db/migrate.js
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm tools node dist/db/seed.js
```

운영에서는 표 구조가 기동과 함께 자동으로 바뀌지 않는다. **사람이 따로 실행하는 단계**다.

- `tools`는 앱 이미지로 **한 번 돌고 끝나는 작업 칸**이다. 소유 계정으로 붙고, `up`으로는 뜨지 않는다(`CLAUDE.md` 8.3절).
- `migrate.js`가 표를 만들고 **앱 계정(`workfluence_app`)과 그 권한도 만든다.** 출력 끝에 `앱 계정 workfluence_app: 권한 적용`이 있어야
  한다. 두 번 실행해도 결과가 같다 — 한 번 더 돌려 출력이 같은지 본다.
- **앱보다 먼저 하는 이유**: 앱은 앱 계정으로 붙는데 그 계정을 이 단계가 만든다. 앱을 먼저 띄우면 데이터베이스에 붙지 못한다
  (`28P01 password authentication failed for user "workfluence_app"`).
- `seed.js`는 첫 root 계정을 만든다 — 아이디 `root`, 비밀번호는 `deploy/.env`의 `WF_ROOT_PASSWORD`, 첫 로그인에서 바꾼다. 이미 있으면
  `root 계정 이미 정상`이고 비밀번호를 바꾸지 않는다.

## 7. 앱을 띄운다 — 값 4

```bash
start=$(date +%s)
docker compose -f deploy/compose.yml --env-file deploy/.env up -d api
until docker exec workfluence-api node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do sleep 1; done
echo "기동 시간: $(( $(date +%s) - start ))초"
```

**여기서 값 4(기동 시간)를 적는다.**

> **`docker compose ps`의 healthy 표시는 이보다 늦다.** 이미지의 헬스체크가 30초 간격이라 앱이 2초에 떴어도 첫 검사가 30초 뒤다. 그래서 위처럼 **직접 물어서** 시간을 잰다. 두 값이 다른 것은 정상이다.

**nginx는 TLS 인증서가 있을 때만 띄운다.** 인증서(`deploy` 아래 `certs/cert.pem`·`certs/key.pem`)는 저장소에 넣지 않는다. 확인용 자체
서명본이 있으면 함께 올린다.

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env up -d nginx
```

상태를 함께 본다.

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env ps
```

## 8. 살아 있는지 묻는다 — 값 5

```bash
docker exec workfluence-api node -e "fetch('http://127.0.0.1:3000/api/health').then(async r=>{console.log('HTTP',r.status);console.log(await r.text())})"
```

**여기서 값 5(응답 원문)를 그대로 복사해 적는다.**

> **이름을 함께 확인한다.** 이 서버에 다른 프로젝트의 컨테이너가 함께 돌고 있으면 엉뚱한 것을 재고 있을 수 있다. 우리 것은 이름이 정해져 있다.
>
> ```bash
> docker compose -f deploy/compose.yml --env-file deploy/.env ps
> docker ps --filter name=workfluence
> ```
>
> `workfluence-api`, `workfluence-postgres`(nginx를 띄웠으면 `workfluence-nginx`), 이미지 `workfluence-app`이 나와야 한다. 다른 이름이 나오면 그것은 우리 스택이 아니다.

| 응답 | 뜻 |
|---|---|
| `HTTP 200` + `{"status":"ok","db":"ok",...}` | 앱과 데이터베이스 모두 정상 |
| `HTTP 503` + `{"status":"degraded","db":"unreachable"}` | 앱은 떴고 데이터베이스가 안 된다. 10절 |
| 아무 응답 없음 | 앱이 죽었다. 9절 로그를 본다 |

**데이터베이스 계정이 나뉘었는지도 본다** — 앱이 앱 계정으로 붙는지, 감사기록에 앱 계정이 `INSERT`·`SELECT`만 갖는지.
명령은 [설치및실행가이드](../설치및실행가이드.md) 7.2절 ①·②다(`docker exec`라 이 서버에서도 그대로 된다).

> **`curl`을 쓰지 않는 이유.** 이미지에 `curl`을 넣지 않았다. 넣으면 크기와 공격 표면이 늘고, 어차피 이미지 안에 있는 Node로 물어볼 수 있다. 헬스체크도 같은 방식이다.
>
> 브라우저로 화면을 보고 싶으면 nginx(7절)를 띄우고 `https://<서버주소>:8443`을 연다. 인증서가 없으면 포트를 잠시 열어야 한다 — `deploy/compose.yml`의 `api` 항목에서 `expose`를 `ports: ["3000:3000"]`으로 바꾸고 다시 올린 뒤 `http://<서버주소>:3000`을 연다. **확인이 끝나면 되돌린다.** 운영에서는 nginx만 바깥에 노출한다.

## 9. 로그를 본다

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env logs api --tail 50
docker compose -f deploy/compose.yml --env-file deploy/.env logs postgres --tail 30
```

앱 로그는 한 줄에 JSON 하나로 나온다. **첫 오류 줄**을 본다. 뒤쪽 줄은 그 결과일 뿐이다.

## 10. 잘 안 될 때

| 증상 | 원인 | 조치 |
|---|---|---|
| `WF_PG_PASSWORD를 .env에 설정` (또는 `WF_PG_APP_PASSWORD`·`WF_SESSION_SECRET`) | 환경 파일이 없거나 그 키가 비었다 | 4절을 다시 한다. `--env-file deploy/.env`를 빼먹지 않았는지, 루트 `.env`를 가리키고 있지 않은지 확인한다 |
| 빌드가 의존성 설치에서 멈춘다 (`ETIMEDOUT`) | 프록시가 빌드 컨테이너에 전달되지 않는다 | 셸에 `HTTP_PROXY`가 있는지 본다 (1.1절). `deploy/build.sh`가 그 값을 넘기므로, 셸에 값이 있으면 그대로 다시 빌드하면 된다. 값이 없으면 서버 담당자에게 프록시 주소를 받아 셸에 넣고 빌드한다 |
| 빌드 중 `no space left` | 디스크 부족 | 3.1절 순서로 좁게 비운 뒤 다시. `docker system prune`은 쓰지 않는다 |
| `db":"unreachable"` | 데이터베이스가 안 떴거나 앱 계정으로 붙지 못한다 | `docker compose ps`로 postgres가 healthy인지, 로그에 디스크 오류가 없는지 본다. 앱 로그에 `28P01 … "workfluence_app"`이면 6절의 표 만들기를 앱보다 먼저 하지 않았거나 `WF_PG_APP_PASSWORD`를 바꾸고 표 만들기를 다시 치지 않았다 — 6절의 `migrate.js`를 치고 `up -d api` ([장애대응](../장애대응가이드.md) 7.31절) |
| 화면이 500이고 앱 로그에 `permission denied` | 앱 계정에 권한이 없다 | 6절의 `migrate.js`를 다시 친다 ([장애대응](../장애대응가이드.md) 7.30절) |
| 기동하다 바로 죽는다 | 설정 항목 오류 | 로그 첫 줄을 본다. 값의 모양이 틀리면(짧은 `WF_SESSION_SECRET` 등) **일부러 기동을 멈춘다** |
| 화면은 404인데 헬스체크는 정상 | SPA 경로 설정 | 지금은 이 상태면 기동이 멈춘다. 그래도 나오면 `docs/guide/장애대응가이드.md` 3절 |
| `pnpm release:bundle`이 `앱 이미지(…)는 커밋 …로 빌드됐다`로 멈춘다 | 빌드한 뒤 커밋이 바뀌었거나 `GIT_SHA` 없이 빌드했다 | 5절대로 다시 빌드하고 12절을 다시 한다 ([장애대응](../장애대응가이드.md) 7.33절) |
| `pnpm release:bundle`이 이미지 저장(`docker save`)에서 이미지를 찾지 못한다며 멈춘다 | postgres·nginx 이미지를 받지 않았다 | 6절의 첫 명령(`pull postgres nginx`) |

더 자세한 것은 [`docs/guide/장애대응가이드.md`](../장애대응가이드.md)에 있다.

## 11. 재부팅 후 자동 기동 — 값 6

**이 서버를 혼자 쓰지 않으면 재부팅하지 않는다.** 다른 프로젝트가 돌고 있으면 그쪽 서비스가 함께 내려간다. 그래서 두 단계로 나눈다.

### 11.1 재부팅 없이 확인하는 것 (지금 한다)

재시작 정책이 실제로 붙어 있는지 본다. 컨테이너가 죽거나 호스트가 재부팅될 때 도커가 다시 띄우는 근거는 이 값이다.

```bash
docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' workfluence-api workfluence-postgres
systemctl is-enabled docker
```

| 나와야 하는 것 | 뜻 |
|---|---|
| `restart=unless-stopped` 둘 다 | 컨테이너 쪽 준비는 됐다 (nginx를 띄웠으면 `workfluence-nginx`도 넣어 본다) |
| `enabled` | 도커 데몬이 부팅 시 올라온다 |

둘 다 맞으면 **값 6은 "정책 확인, 실제 재부팅은 미실시"**로 적는다. 하나라도 다르면 그 값을 그대로 적는다.

### 11.2 실제로 재부팅해 보는 것 (서버 소유자와 합의한 뒤)

정책이 붙어 있어도 실제로 올라오는지는 해 봐야 안다. **설정만 보고 넘기면 정작 필요한 날에 안 올라온다.** 다만 공유 서버에서는 남의 서비스까지 내려가므로 합의가 먼저다.

합의가 됐으면 재부팅한 뒤 사람 손을 대지 않고 상태를 본다.

```bash
docker ps --filter name=workfluence
docker exec workfluence-api node -e "fetch('http://127.0.0.1:3000/api/health').then(async r=>console.log(r.status, await r.text()))"
```

폐쇄망 운영 서버는 우리만 쓰므로 거기서는 반드시 실제 재부팅으로 확인한다 (`CLAUDE.md` 8.3절, 설치및실행가이드 7.1절). 이 빌드 서버에서는 **정책이 붙어 있는지**와 **정책이 실제로 되살리는지**까지 확인할 수 있다. 실제 재부팅은 공유 서버라 할 수 없다 (방법은 `P5_설계서_Release` C절).

## 12. 반입 묶음을 만든다 — 값 7

5절의 이미지와 6절에서 받은 postgres·nginx 이미지를 한 묶음으로 만든다. **인터넷을 쓰지 않는다** — 이미 받아 둔 이미지와 설치된
의존성만 쓴다. 저장소의 도구라 Node·pnpm이 있어야 한다(1절).

```bash
pnpm install --frozen-lockfile
V=workfluence-$(date -u +%Y-%m-%d)
rm -rf ".local/release/${V:?}"
pnpm release:bundle .local/release/$V
pnpm release:verify .local/release/$V
```

`pnpm release:bundle`이 하는 일:

- compose가 요구하는 이미지 셋을 compose에게 물어 **`images.tar` 하나로** 저장한다. 그 전에 **앱 이미지의 커밋 라벨(5절)이 저장소의
  지금 커밋(HEAD)과 같은지 보고, 다르면 묶지 않는다** — `앱 이미지(workfluence-app:latest)는 커밋 …로 빌드됐다 — 지금은 …다`라며 다시
  빌드하는 명령을 알려 준다. 5절대로 다시 빌드하고 이 절을 처음부터 다시 한다. 같은 자리에서 **작업 폴더에 커밋하지 않은 변경이 없는지**,
  **앱 이미지 이름이 폐쇄망의 compose가 찾는 이름(`workfluence-app:latest`)인지**도 보고 다르면 멈춘다(장애대응 7.33절).
- `compose.yml`·`nginx.conf`, 설치및실행가이드(`반입절차.md`), **운영 문서 다섯**(저장소와 같은 자리 — `docs/guide/`의 설치및실행가이드·운영가이드·장애대응가이드·
  사용자가이드와 `docs/learnSystem/`의 학습가이드), 사내 CA 자리(`ca/README.md`), 값이 없는 `env.template`, 부품 목록(`sbom.cdx.json`·`LICENSES.txt`),
  `MANIFEST.txt`(버전·커밋)를 넣고, 마지막에 모든 파일의 지문(`SHA256SUMS`)을 적는다. 묶음이 갖춰야 할 목록은 코드
  (`packages/shared/src/release.ts`의 `RELEASE_REQUIRED_FILES`)가 들고 있다 — 빠지면 스스로 멈춘다.

`pnpm release:verify`는 `[verify] 통과 — 필수 …개 · 체크섬 …개 일치`와 버전 줄을 내야 한다. 같은 날 다시 만들면 `rm -rf`가 먼저 옛 것을
지운다 — 남은 파일이 섞이지 않게.

**맨 위 디렉토리 하나로** tar를 싼다. 반입 매체에 담을 지문도 함께 만든다.

```bash
tar -cf .local/release/$V.tar -C .local/release $V
(cd .local/release && sha256sum $V.tar > $V.tar.sha256)
tar -tf .local/release/$V.tar | head -3
ls -lh .local/release/
```

`tar -tf`의 첫 줄이 `workfluence-<날짜>/`여야 한다. 설치및실행가이드 1절이 `--strip-components=1`로 그 한 겹을 벗겨 `deploy/`에 푼다 —
파일을 맨 위에 흩어 싸면 그 명령이 파일 이름의 첫 조각을 떼어 버린다.

반입 매체에는 **`workfluence-<날짜>.tar`와 `workfluence-<날짜>.tar.sha256` 둘을** 담는다. 받는 쪽은 `.sha256`으로 옮기다 상하지 않았는지
먼저 본다(설치및실행가이드 1절 — 새 버전은 11절 ①). **그 지문 값(`.tar.sha256`의 앞 64자)은 반입 신청서처럼 매체와 따로 가는 기록에도 적는다** — 지문 파일은
매체에 같이 가므로, 현장은 매체째 바뀌지 않았는지를 그 기록과 견주어 가린다(설치및실행가이드 0.1절).

**여기서 값 7을 적는다** — `cat .local/release/$V/MANIFEST.txt`, `release:verify`의 두 줄, tar 크기.

## 12-1. Docker 설치 묶음을 만든다 — 대상 서버에 Docker가 없을 때만

폐쇄망의 RHEL 9 서버에 Docker가 없으면 반입 묶음과 함께 **Docker 묶음**을 들고 간다(설치및실행가이드 0.1·0.3절). 이 서버(RHEL 9)에 **깔린 판 그대로**의 RPM을
받아 싼다 — 반입 묶음의 이미지를 이 판으로 만들고 띄워 봤기 때문이다. **아무것도 설치하지 않는다**(`dnf download`는 파일만 받는다). 인터넷이 필요하다(1.1절의 프록시).
반입 묶음(12절)과 같은 날 만든다.

| 자리 | 싣는 것 | 왜 |
|---|---|---|
| 맨 위 | `docker-ce`·`docker-ce-cli`·`containerd.io`·`docker-compose-plugin`(Docker — Apache-2.0) · `container-selinux`(Red Hat — GPLv2) | Docker와, Docker가 늘 요구하는 RHEL 부품 — 컨테이너를 쓴 적 없는 서버에는 `container-selinux`가 없다 |
| `deps/` | `iptables-nft`·`nftables`·`libnftnl`(Red Hat — GPL 계열) · `jansson`(Red Hat — MIT) | **firewalld가 없는 RHEL 9에 모자란 것** — firewalld가 없는 RHEL 9에 Docker와 한 거래로 들어오는 부품과, `nftables`가 쓰는 `jansson`. firewalld가 있는 표준 설치에는 이미 있다. 판이 이 서버의 부 버전에 묶여 있어 대상이 같은 부 버전일 때만 쓴다(설치및실행가이드 0.3절 ④) |
| `PACKAGES.txt` | 첫 줄은 이 서버의 `/etc/redhat-release`, 다음 줄부터 RPM마다 파일·라이선스·만든 곳 | 판의 기록이자 라이선스 목록(`CLAUDE.md` 7절). 현장은 첫 줄을 자기 서버의 판과 견주어 `deps/`를 쓸지 정한다 |
| `docker-ce.gpg` · `SHA256SUMS` | Docker의 공개키 · 모든 파일의 지문 | 현장이 같은 키로 서명을 보고(설치및실행가이드 0.3절 ②), 지문으로 상했는지 본다 |

**Red Hat의 부품(GPL 계열)은 고치지 않고 싣는다** — 사용자 승인 2026-09-30(`CLAUDE.md` 7절). 대상 서버의 RHEL과 같은 배포판의 부품이고, 현장은 그 서버 자신의
Red Hat 키로 서명을 본다. 앱 이미지와 반입 묶음에는 들어가지 않는다.

```bash
export NODE_USE_ENV_PROXY=1
pnpm release:docker
ls -lh .local/release/
```

`pnpm release:docker`가 하는 일 — **어느 단계든 틀리면 까닭을 말하고 멈춘다**(종료 코드 1, 마지막 줄이 나오지 않는다):

1. 위 표의 RPM이 이 서버에 깔린 판을 읽는다 — 하나라도 없으면 멈춘다.
2. 그 판을 아키텍처까지 적어 `dnf download`로 받는다(다른 아키텍처 `i686`이 섞이지 않게 — T-096). 받은 파일이 기대와 하나라도 다르면 멈춘다.
3. Docker의 공개키를 받아 **키가 하나이고 그 지문이 `060A 61C5 1B55 8A7F 742B  77AA C52F EB6B 621E 9F35`**(Docker Release (CE rpm))인지 본다 — 첫 키만 보면 키를 하나
   더 붙인 파일이 지나간다.
4. **임시 RPM DB**에 Docker 키와 이 서버의 Red Hat 키를 넣고, 모든 RPM이 `digests signatures OK`인지 본다 — 서명이 없는 RPM(`digests OK`)과 결과가 없는 RPM도 멈춘다
   (T-097). 이 서버의 RPM DB는 건드리지 않는다.
5. `PACKAGES.txt`와 `SHA256SUMS`를 쓰고, 맨 위 디렉토리 하나(`docker-rhel9-<날짜>/`)로 싸고(파일 주인은 숫자 0 — 만든 계정의 이름이 묶음에 남지 않게) 지문 파일을 쓴다.

판정은 공유 코드(`packages/shared/src/release.ts`의 `dockerKeyProblem`·`rpmSignatureProblems`)가 하고, 현장의 설치및실행가이드 0.3절 ②가 같은 판정을 셸 한 줄씩으로 한다.

마지막 두 줄이 `[docker] 완료 — …`와 `[docker] 지문 — <64자>  docker-rhel9-<날짜>.tar …`여야 한다. 반입 매체에는 **`docker-rhel9-<날짜>.tar`와 `.tar.sha256` 둘을** 반입
묶음의 둘 옆에 담는다 — 대상 서버에 Docker가 이미 있으면 담지 않는다. **두 묶음의 지문 값은 반입 신청서처럼 매체와 따로 가는 기록에도 적는다**(설치및실행가이드 0.1절).

## 13. 정리

확인이 끝나고 서버를 비우려면 이렇게 한다.

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env down
```

데이터까지 지우려면 아래를 쓴다. **볼륨이 지워지므로 되돌릴 수 없다.**

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env down -v
```

다음에 또 빌드할 것이면 이미지는 남겨 둔다. 레이어 캐시가 있어 다음 빌드가 훨씬 빠르다.

반입 매체에 옮긴 묶음은 지운다 — 묶음 디렉토리와 tar를 합치면 수백 MB다. 12절의 `V`가 남아 있는 셸이면:

```bash
rm -rf ".local/release/${V:?}" ".local/release/${V:?}.tar" ".local/release/${V:?}.tar.sha256"
```

12-1절의 Docker 묶음도 옮겼으면 지운다 — 날짜가 다른 옛 묶음도 함께 지워진다(모두 `pnpm release:docker`로 다시 만들 수 있다):

```bash
rm -rf .local/release/docker-rhel9-*
```

## 14. 결과를 적는 곳

2절의 값은 **그 Phase의 검증기록**(`docs/P{N}_검증기록_<Topic>.md`)과 PR 설명에 적는다 (`CLAUDE.md` 1.1절 8-1 ②·12.1절). 형식은 자유다.
출력을 통째로 붙이는 것이 가장 정확하다.

반입한 묶음이면 `MANIFEST.txt`의 버전과 커밋을 반입 기록에도 남긴다 — 폐쇄망에서 "무엇이 들어갔나"를 답하는 유일한 단서다.
