# P20 검증기록 — Install (RHEL 9 서버에 반입해 실행한다 — 필요한 파일만, F-014)

- 작성일: 2026-09-30 / 작성 LLM: Claude Opus 5.5
- 설계: [`docs/P20_설계서_Install.md`](P20_설계서_Install.md) · 검토: 6절과 [`docs/internal/P20_검토서_Review.md`](internal/P20_검토서_Review.md)
- 요청 원문: `docs/prompts/phase20/scope.md`
- 시행착오는 [`docs/internal/검토서_트러블슈팅.md`](internal/검토서_트러블슈팅.md)에만 적는다 — 이 Phase는 T-096~T-098
- 명령과 출력 원문은 이 서버의 `.local/tmp/p20-rehearsal/`(첫 리허설)·`.local/tmp/p20-rehearsal2/`(둘째)에 있다(커밋하지 않는다 — 12.2절)
- 여기 적은 묶음의 지문은 **리허설 묶음**의 것이다. 들고 갈 묶음은 병합 뒤 `main`의 병합 커밋으로 다시 만든다(FR-2106 — PR 설명)

## 1. 요구사항과 확인

| # | 확인 | 어디서 |
|---|---|---|
| FR-2100 | 들고 갈 것의 목록 — 반입 묶음 tar와 지문 파일(늘), Docker 묶음 tar와 지문 파일(Docker가 없을 때만), 인증서는 현장에서, 지문 값은 따로 가는 기록에도 | 반입 가이드 0.1절 · 리허설 둘(3절 — 매체 자리에 두 파일만 두고 끝까지) |
| FR-2101 | Docker 묶음 — `pnpm release:docker`를 적힌 그대로 쳐서 만들었다 | A등급 시험(5절) · 2.1절 |
| FR-2102 | RHEL 9에 Docker를 들이는 순서 — 지문·풀기·서명 판정·충돌·설치 | 2.2~2.5절(UBI 9.6에서 설치까지, 이 서버에서 설치 모의). 데몬을 켜는 것은 현장(7절 — 보류 38) |
| FR-2103 | 출력은 영어로·방화벽·SELinux·망 대역·시각·디스크 세 자리 | 3절(SELinux Enforcing으로 설치 · firewalld가 없는 서버 · 시각 동기화 · `C.UTF-8`) |
| FR-2104 | 장애 유형 7.41절 | `pnpm verify:docs` · 2절(Red Hat 키가 없으면 다섯이 `NOT OK`, 서명 없는 RPM, 키를 들이지 않은 dnf의 거절, dnf의 모자람 문장을 실제로 봤다) |
| FR-2105 | 리허설 — 두 파일만 가지고 반입 가이드 0~8절, 검토를 반영한 뒤 한 번 더 | 3절 |
| FR-2106 | 마지막 반입 묶음 — `main`의 병합 커밋으로 | 병합 뒤(PR 설명) |
| NFR-200 | 앱의 동작·이미지 구성·설정 키·의존성 변경 없음 — 더한 코드는 묶음을 만드는 쪽뿐 | `git diff --name-only main...impl-phase20`에 `apps/`·`deploy/`·`.env.example`·lockfile이 없다. 코드는 `packages/shared/src/release.ts`(+시험)·`scripts/docker-bundle.ts`·`package.json`의 스크립트 한 줄 |

## 2. Docker 묶음

### 2.1 만든다 — `pnpm release:docker` (리눅스빌드 가이드 12-1절, 적힌 그대로)

2026-09-30 07:31 UTC, 개발 서버(RHEL 9.6), HEAD `a14f7c6`.

```
[docker] 이 서버: Red Hat Enterprise Linux release 9.6 (Plow)
[docker] 판 — docker-ce-29.6.1-1.el9.x86_64 · docker-ce-cli-29.6.1-1.el9.x86_64 · containerd.io-2.2.6-1.el9.x86_64 · docker-compose-plugin-5.3.1-1.el9.x86_64 · container-selinux-2.232.1-1.el9.noarch
[docker] deps/ — iptables-nft-1.8.10-11.el9_5.x86_64 · nftables-1.0.9-3.el9.x86_64 · libnftnl-1.2.6-4.el9_4.x86_64 · jansson-2.14-1.el9.x86_64
[docker] 키 — 하나, 지문 060A 61C5 1B55 8A7F 742B  77AA C52F EB6B 621E 9F35
[docker] 서명 — 9/9 digests signatures OK (임시 RPM DB)
[docker] 완료 — .local/release/docker-rhel9-2026-09-30.tar · 78MB · RPM 5 + deps/ 4
[docker] 지문 — bc09d393…c29672  docker-rhel9-2026-09-30.tar (…)
```

- 종료 코드 0. `PACKAGES.txt` — 첫 줄 `Red Hat Enterprise Linux release 9.6 (Plow)`, RPM 아홉의 라이선스: Docker 넷 `Apache-2.0`, `container-selinux` `GPLv2`,
  `iptables-nft` `GPLv2 and Artistic 2.0 and ISC`, `nftables` `GPLv2`, `libnftnl` `GPLv2+`, `jansson` `MIT`(Red Hat 다섯은 `Red Hat, Inc.`). `SHA256SUMS` 11줄 모두 `OK`.
  tar의 첫 줄 `docker-rhel9-2026-09-30/`, 파일 주인 `0/0`.
- 처음 판(가이드의 셸 명령)으로 받을 때 아키텍처를 적지 않아 `deps/`에 i686 셋이 섞였다(T-096) — 스크립트는 받은 파일이 기대와 다르면 멈춘다.

### 2.2 무엇이 모자라는가 — 이 서버의 RPM DB 사본에서 Docker 거래를 되돌려 (자체 점검 1의 방법 — T-098)

`/var/lib/rpm`을 복사해 Docker와 함께 들어온 것(docker-ce·docker-ce-rootless-extras·docker-ce-cli·containerd.io·docker-compose-plugin·docker-buildx-plugin·
container-selinux·nftables·libnftnl·iptables-nft)을 `rpm -e --justdb`로 지우고 `rpm -i --test`로 넣어 봤다 — **firewalld가 없는 RHEL 9.6**에 가깝다. 이 서버의 DB는 건드리지 않았다.

| 넣은 것 | 결과 |
|---|---|
| 맨 위 다섯 | `Failed dependencies:` — `(iptables-nft or iptables) is needed by docker-ce-3:29.6.1-1.el9.x86_64` · `nftables is needed by docker-ce-3:29.6.1-1.el9.x86_64` |
| 다섯 + `deps/` 넷 | `package jansson-2.14-1.el9.x86_64 is already installed`뿐(같은 판이 이미 있다 — dnf는 건너뛴다) |
| 다섯 + `deps/`의 셋(`jansson` 빼고) | **종료 0** |

처음 판의 `deps/`(`iptables-libs`·`libnetfilter_conntrack`·`libnfnetlink`)는 이 서버의 기본 설치(2025-04-24)부터 있었고, 모자란 `nftables`·`libnftnl`·`iptables-nft`는
docker-ce와 같은 거래(2026-07-16)로 들어왔다(`rpm -q --qf '%{INSTALLTIME:date}'`).

### 2.3 저장소가 없을 때 dnf가 내는 문장 — UBI 9.6 컨테이너 (`--disablerepo='*'`)

UBI는 RHEL 서버보다 훨씬 작아(SELinux 정책·nftables·iptables가 없다) 모자람의 모양은 다르다 — 문장의 글자를 받으려고 봤다. 다섯만 넣으면:

```
- nothing provides libselinux-utils needed by container-selinux-3:2.232.1-1.el9.noarch from @commandline
- nothing provides selinux-policy >= 38.1.2-1.el9 needed by container-selinux-3:2.232.1-1.el9.noarch from @commandline
- nothing provides xz needed by docker-ce-3:29.6.1-1.el9.x86_64 from @commandline
- nothing provides nftables needed by docker-ce-3:29.6.1-1.el9.x86_64 from @commandline
- nothing provides (iptables-nft or iptables) needed by docker-ce-3:29.6.1-1.el9.x86_64 from @commandline
```

(그 밖에 `policycoreutils`·`selinux-policy-base`·`selinux-policy-targeted`.) 장애대응 7.41절과 반입 가이드 0.3절 ④의 문장은 이것을 옮겼다.

### 2.4 서명의 관문 — UBI 9.6 컨테이너 (쓰고 버리는 것이라 설치를 실제로 했다)

| 무엇 | 결과 |
|---|---|
| 반입 가이드 0.3절 ①을 적힌 그대로(`sudo`만 뺐다) | 매체 tar `OK` · `SHA256SUMS`에서 `OK`가 아닌 줄 0 · `PACKAGES.txt`의 첫 줄 |
| ② 키 판정 | `1:060A61C51B558A7F742B77AAC52FEB6B621E9F35`(처음 쓰는 계정이라 그 앞에 gpg의 `… created` 세 줄) |
| ② 서명 판정(임시 DB) | 아무것도 나오지 않았다(`grep` 종료 1) |
| ②의 끝을 **하지 않고** ④(`--setopt=localpkg_gpgcheck=1`) | `Public key for containerd.io-2.2.6-1.el9.x86_64.rpm is not installed` 외 Docker 셋 — **깔리지 않았다**(`package docker-ce is not installed`) |
| ②의 끝(`rpm --import` 둘) 뒤 ③·④ | ③ 아무것도 없다. ④ 종료 0 — 다섯이 `Installing:`(`@commandline`), 모자란 것은 UBI 저장소에서. `docker` 그룹이 그 시스템의 그룹으로 생겼다(`docker:x:998:`) |
| **서명 없는 RPM**(`rpmbuild`로 만들었다) | `rpm -K` → `…: digests OK`, 종료 0. 옛 판정(`NOT OK`·`NOKEY`를 찾는다)은 **못 찾는다.** 새 판정(`grep -v ': digests signatures OK$'`)은 그 줄을 낸다. dnf `--setopt=localpkg_gpgcheck=1` → `Package wf-unsigned-1-1.noarch.rpm is not signed` · `Error: GPG check FAILED`. dnf 기본 → `Installed:` · `Complete!`(서명을 보지 않는다 — T-097) |
| `gpasswd -a` | `docker:x:998:tester` 한 줄. 그 시스템의 그룹이 아니면 `gpasswd: group 'nosuchgroup' does not exist in /etc/group`(종료 3) |

Red Hat 키를 넣지 않은 RPM DB(임시 DB에 Docker 키만)로 보면 Docker 넷만 `digests signatures OK`이고 Red Hat이 서명한 다섯은 `digests SIGNATURES NOT OK`다(종료 5) —
장애대응 7.41절의 그 줄. 데몬을 켜는 것(`systemctl enable --now docker`)은 컨테이너에서 할 수 없다.

### 2.5 이 서버에서 0.3절 ①~④ — 설치 모의 (둘째 리허설, 07:32 UTC)

Docker가 이미 있는 서버라 가이드는 0.3절을 건너뛰게 한다. 명령만 적힌 그대로 쳐 봤다 — ②의 끝(`sudo rpm --import …`, 공유 서버의 RPM DB)과 ⑤(`daemon.json`, 공유 서버의 Docker)·⑥은
치지 않았다. ① 매체 tar `OK` · `SHA256SUMS`에서 `OK`가 아닌 줄 0 · `PACKAGES.txt` ② `1:060A…9F35` · 서명 판정은 아무것도 내지 않았다 ③ 아무것도 없다
④ `--assumeno --setopt=localpkg_gpgcheck=1 --disablerepo='*'` → `Nothing to do.` ⑥의 확인 `grep -c '^docker:' /etc/group` → `1`(구성원 이름은 적지 않는다).
`dockerd --validate --config-file`(0.3절 ⑤의 예)은 스크래치의 사본으로 `configuration OK`, 틀린 모양은 `unable to configure the Docker daemon with file …`로 거절했다.

## 3. 설치 리허설 — 반입 가이드를 적힌 그대로, 두 번

개발 서버 — **RHEL 9.6 · SELinux Enforcing · Docker CE 29.6.1(기본 설정) · firewalld 없음**. 빌드 가이드로 이미지와 묶음을 만들고, **반입 매체 자리에 두 파일
(`workfluence-2026-09-30.tar`·`.tar.sha256`)만** 두고 반입 가이드대로 **빈 볼륨**에 설치했다.

**가이드와 다르게 한 것** — 이것뿐이다.

| 무엇 | 왜 |
|---|---|
| 셸에 `COMPOSE_PROJECT_NAME=p20rh` | 이 서버에 같은 이름(`deploy`)의 개발 스택이 있다. 가이드대로 `deploy`로 풀면 그 볼륨을 그대로 쓴다. 개발 스택은 **볼륨을 남기고** 내렸다가(`down`, `-v` 없이) 끝나고 다시 띄웠다 — 고정된 컨테이너 이름과 8443 포트가 겹친다(P13 리허설과 같다) |
| 매체의 자리 | `/media/반입` 대신 `.local/tmp/매체/`(두 파일만) — `/media`에 만들려면 공유 서버의 시스템 디렉토리를 건드린다 |
| 3절 인증서 | 리허설용 자체 서명(SAN `DNS:localhost, IP:127.0.0.1`, 7일) — 현장에서는 사내에서 받는다 |
| 7절 `curl -sk` → `curl --cacert certs/cert.pem` | 같은 확인을 인증서 검증을 켠 채 해 봤다 — 리허설 인증서의 이름에 `localhost`를 넣었다. 가이드의 `-k`는 현장 인증서의 이름이 `localhost`가 아니어서다 |
| 7절 브라우저 확인 → 같은 API를 Node로 + **같이 고치기와 오래 열어 두기는 실제 브라우저**(Playwright Chromium) | API는 TLS 검증을 켠 채(`NODE_EXTRA_CA_CERTS`). 브라우저는 자체 서명 인증서라 인증서 검사를 넘겼다 — 같은 서버를 API로 이미 검증했다 |
| 7.1절 재부팅 | 하지 않았다 — 공유 서버다. 재시작 정책과 도커의 부팅 기동만 봤다 |
| 0.3절 | Docker가 이미 있다 — 2.5절(명령만 쳐 봤다) |

### 3.1 첫 리허설 (2026-09-30 06:04~06:08 UTC, HEAD `4d876c3`) — 찾은 것 셋

0.2·0.4·1~8절이 모두 통과했다(점검 10/10 — 오래 열어 두기는 이때 하지 않았다). 가이드가 틀린 곳 셋을 찾아 고쳤다(`4753625`): ① `sudo: firewall-cmd: command not found`
— firewalld가 없는 서버를 가이드가 말하지 않았다 ② `/var/lib/docker`가 따로 붙은 디스크(`/dev/vdb`)인데 가이드는 `df -h /var/lib`(OS 디스크)를 보게 했다 ③ 묶음 크기
어림 400MB → 약 270MB(실측 264MB). 그 뒤 병합 전 검토 셋이 더 찾았다(6절).

### 3.2 둘째 리허설 (2026-09-30 07:30~07:40 UTC, HEAD `a14f7c6` — 검토를 반영한 뒤)

| 절 | 결과 |
|---|---|
| 0절 머리 | `export LC_ALL=C.UTF-8` — 이 서버는 이미 `LANG=C.UTF-8`이다 |
| 0.2 | `Red Hat Enterprise Linux release 9.6 (Plow)` · 도커 `enabled` · Compose v5.3.1 · `~` 여유 8.8GB, `/var/lib/docker`·`/var/lib/containerd` 여유 18GB(같은 디스크 `/dev/vdb`) · tar 1.34 · sha256sum 8.32 · OpenSSL 3.2.2 |
| 0.3 | 2.5절 |
| 0.4 | `sudo: firewall-cmd: command not found`(firewalld가 없다 — 가이드대로 바꿀 것이 없다) · `Enforcing` · Docker의 망 대역 `172.17.0.0/16 docker0` 등(기본 풀) · `Asia/Seoul`, `System clock synchronized: yes` · 디스크 세 자리 위와 같다 |
| 1 | `cat`의 앞 64자 `14bda2fe…d0b322` · 매체 tar `OK` · `SHA256SUMS` **14줄 모두 `OK`** · `MANIFEST` `version=0.1.0 gitSha=a14f7c6` 이미지 셋 |
| 2 | `Loaded image` 셋(postgres:17 · workfluence-app:latest · nginx:1.27-alpine) — 앱 381MB |
| 3 | 필수 키 줄 수 `4` · `.env` `-rw-------` · `certs/key.pem` `-rw-------`(3절의 `chmod 600` — nginx가 그대로 읽었다), `cert.pem` `-rw-r--r--` · SAN `DNS:localhost, IP Address:127.0.0.1` |
| 4 | `workfluence-postgres … Up 10 seconds (healthy)` |
| 5 | `14개 마이그레이션 적용 상태` · `앱 계정 workfluence_app: 권한 적용` — 두 번째도 같다 |
| 5-1 | `root 계정 생성: root (첫 로그인에서 비밀번호 변경 강제)` → 두 번째 `root 계정 이미 정상: root` |
| 6 | 헬스까지 **2초** · 셋 다 healthy, `tools`는 목록에 없다 · nginx `0.0.0.0:8443->443/tcp, [::]:8443->443/tcp` · 볼륨 `p20rh_attachments`·`p20rh_postgres_data` |
| 7 | 헬스 `{"status":"ok","db":"ok"}` · 점검 **11/11** — 앱이 산다 · 요청 번호 하나 · 첫 화면과 스크립트 200 · root 로그인 201(비밀번호 변경 강제) → 바꾼 비밀번호로 로그인 201 · 문서 저장 → 버전 2 · 한글 이름 첨부 올리고 내려받기(같은 내용·같은 이름 `리허설 첨부.txt`) · **브라우저 둘 — 한쪽 글자가 다른 쪽에 곧바로** · 저장하고 보기로 → 버전 3 · **혼자 편집 화면을 390초 열어 둠 — `연결이 끊겼다` 0개, 그 뒤 친 글자가 저장됐다(버전 4)** · 감사 8종(`auth.login.success`·`auth.password.change`·`space.create`·`page.create`·`page.update`·`attachment.upload`·`attachment.download`·`page.collab.save`) |
| 7.2 | ① `WF_DATABASE_URL=postgres://workfluence_app` · `WF_ROOT_*` `0` ② `INSERT`·`SELECT` (2 rows) |
| 7 나머지 | `X-Request-Id` 1개(`--cacert`) · nginx 로그 JSON 한 줄 · 셋 다 `max-file:5 max-size:20m` · `WF_ROOT_PASSWORD` 비움(빈 값 1줄) |
| 7.1 대신 | 셋 다 `unless-stopped` · 도커 `enabled` |
| 8 | `db.dump` 62KB · 첨부 백업 `tar -tzf … \| wc -l` → `3` |
| SELinux | `Enforcing` 그대로 · 붙인 파일(`nginx.conf`·`certs/key.pem`)은 `user_home_t`(홈 디렉토리) · 컨테이너(nginx·postgres)는 `spc_t` · 리허설 동안의 SELinux 거부(`ausearch -m avc -ts <시작 시각>`) **0건** |

**정리** — `p20rh` 프로젝트를 볼륨까지 지우고(`down -v`), 홈의 `workfluence`·`docker-rhel9`와 매체 자리를 지웠다. 개발 스택을 원래 볼륨(`deploy_*` — 지우지 않았다)으로 다시 띄웠다 — 헬스 `ok`, 사용자 7명(내리기 전 7명), `p20rh` 볼륨 0.

## 4. 빌드 (리눅스빌드 가이드 3·5·12·12-1절) — 둘째 리허설

| 절 | 결과 |
|---|---|
| 3 | `git status --short` 빈 줄 · `a14f7c6` · Docker 29.6.1 · Compose v5.3.1 · `df -h /var/lib/docker` 여유 19GB(이 서버의 도커 디스크 — 1절이 `/`에서 이리로 바뀌었다) |
| 5 | 라벨 `a14f7c6f433a…` = `git rev-parse HEAD` · **381MB**(예산 400MB) |
| 12 | `release:bundle` — 앱 이미지 = 커밋 `a14f7c6`, **15개 파일 · 264MB**. `release:verify` — `통과 — 필수 15개 · 체크섬 14개 일치` · `git a14f7c6 · 이미지 3개`. tar **264MB**, 첫 줄 `workfluence-2026-09-30/` |
| 12-1 | 2.1절 |

## 5. 자동 검사

CI(`36683932413`, HEAD `a14f7c6` — 그 뒤는 문서만 바뀌었다):

| 검사 | 결과 |
|---|---|
| 시험 | shared **479**(Phase 19의 459 + 20 — `release.spec.ts`의 Docker 묶음 판정) · api **1,221** · web **430**, skip 0 |
| 커버리지 | shared 줄 99.88 · 가지 96.74 — `release.ts` 줄 100 · 가지 94.8(A등급 90 이상) / api 줄 96.33 · 가지 91.70 / web 줄 94.11(측정만) |
| 그 밖 | lint·typecheck(`scripts/**` 포함) 통과 · `verify:docs` 문서 95개 위반 없음 · 빌드 산출물의 외부 URL 없음 · gitleaks `no leaks found` |

A등급은 테스트를 먼저 썼다 — Red `966c68d`(CI 실패 — 없는 함수를 부른다) → Green `2141cee`.

## 6. 병합 전 검토

[`docs/internal/P20_검토서_Review.md`](internal/P20_검토서_Review.md) — 셋 다 Opus 5.5.

| 검토 | 결과 | 처리 |
|---|---|---|
| `doc-consistency` | 22건(중간 5 · 낮음 17), 오탐 0 | 21건 반영 · 1건 그대로(규칙서의 흐름 — 절차는 반입 가이드가 단일 출처) · 라이선스는 사용자 승인 |
| `self-reviewer` | 15건(보통 5 · 낮음 10), 오탐 0 | 모두 반영 — 범위 밖 하나(`entrypoint.sh`의 읽기 검사)는 문서로 |
| 명령·보안 검토 | 보안 문턱 이상 2(S1·S2) · 문턱 아래 4 · 정확성 12, 오탐 0 | 모두 반영 — fapolicyd(확신 낮음)만 그대로 |

가장 값있던 것 — 서명 확인이 서명 없는 RPM을 통과시켰다(T-097), `deps/`를 거꾸로 골랐다(T-098), firewalld는 Docker가 연 포트를 거르지 않는다, 빌드 쪽 셸 명령은 실패해도
멈추지 않았다. 라이선스 — Red Hat의 부품(GPL 계열)을 싣는 것을 사용자에게 물어 **"승인 — 싣는다 (추천)"**을 받았다(설계서 A.2).

## 7. 확인하지 못한 것

| 무엇 | 왜 | 언제·어디서 닫나 |
|---|---|---|
| **빈 RHEL 9 서버에 Docker 묶음을 까는 것** | 개발 서버에는 Docker가 이미 있다. 설치는 UBI 9.6 컨테이너에서(2.4절), 의존은 이 서버의 RPM DB 사본에서(2.2절) 봤다 — **데몬 켜기·`docker` 그룹으로 다시 로그인·firewalld가 켜진 서버는 해 보지 못했다** | 반입 당일 반입 가이드 0.3절대로 하고 적는다 — **보류 38** |
| **firewalld가 켜진 서버에서 Docker가 연 포트가 다른 PC에서 닿는지** | 개발 서버에는 firewalld가 없다. firewalld 1.3.4의 소스(주소를 바꾼 연결을 영역 판정 전에 받는다)와 dockerd 29.6.1의 문자열(`docker` 영역·전달 정책)로 판단했다 | 보류 38 |
| **`daemon.json`으로 망 대역을 바꾼 Docker** | 공유 서버의 Docker 설정이다 — 모양은 `dockerd --validate`로만 봤다. 켠 뒤에 바꾸는 순서(다시 켜고 compose 망을 다시 만든다 — 7.41절)도 해 보지 못했다 | 현장에서 대역이 겹칠 때 |
| **서버의 RPM DB에 두 키를 들이기**(`sudo rpm --import …`) | 공유 서버의 시스템 설정이다 — UBI에서 했다(2.4절) | 반입 당일 0.3절 ② |
| **사내 디렉토리(SSSD 등)의 계정·그룹** | 이 서버의 계정은 로컬이다 — `gpasswd -a`와 `/etc/group` 확인은 로컬만 봤다(2.4절) | 반입 당일 |
| **재부팅 뒤 자동 기동** | 공유 서버다 — 재시작 정책과 도커의 부팅 기동만 봤다(P5·P13과 같다) | 반입 당일 7.1절 |
| **RHEL 9의 다른 부 버전** | 9.6에서만 했다. `container-selinux`는 `selinux-policy >= 38.1.2-1.el9`을 요구하고(`rpm -qpR` — 9.0·9.1에는 없다), `deps/`는 9.6의 판이다 | 반입 당일 `cat /etc/redhat-release`를 적는다 |
| **RHEL 설치 매체에서 부품을 넣는 길** | 이 서버에 설치 매체가 없다 | 현장에서 필요할 때 |
| **사내 인증서와 실제 반입 매체** | 인증서는 리허설용 자체 서명, 매체는 디렉토리로 흉내 냈다 | 반입 당일 |
| **사람이 화면 전체를 둘러보기** | 화면이 부르는 API를 Node로, 같이 고치기와 오래 열어 두기를 실제 브라우저로 봤다 — 메뉴를 하나씩 눌러 보지는 않았다(그 화면들은 P17~P19의 E2E가 본다) | 반입 당일 7절 |
| **fapolicyd가 켜진 서버** | 보안 검토의 확신이 낮은 지적이고 이 서버에 없다 | 현장에서 컨테이너가 뜨지 않으면 |

## 8. CI

브랜치의 커밋마다 CI가 돌았다 — Red `966c68d`만 실패(예상 — 없는 함수를 부르는 시험), 그 밖은 통과(`4d876c3` `36676078520` · `4753625` `36677251407` · `2141cee`
`36682297731` · `8527686` `36683470381` · `a14f7c6` `36683932413`). PR의 마지막 검사와 병합 뒤 `main`의 CI·Windows 묶음은 PR 설명에 적는다.
