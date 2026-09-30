# P20 설계서 — Install (RHEL 9 서버에 반입해 실행한다 — 필요한 파일만, F-014)

폐쇄망의 설치 절차는 Phase 5·13이 만들었다 — 반입 가이드([`docs/운영가이드_반입.md`](운영가이드_반입.md))만 보고 빈 서버에 설치하면 root로 로그인된다(P13).
그 가이드는 **대상 서버에 Docker가 이미 있다고** 가정하고(0절), 무엇을 들고 가는지는 리눅스빌드 가이드의 끝(12절)에만 있다. 사용자가 반입할 서버를 **RHEL 9**로
알려 주고 "필요한 파일만 반입할 수 있게" 정리해 달라고 했다. 이 Phase는 **앱을 바꾸지 않는다** — 들고 갈 것의 목록, RHEL 9에서 Docker를 들이는 순서(Docker가 없을 때),
RHEL 9에서만 걸리는 것(podman과의 충돌·방화벽·SELinux·계정)을 반입 가이드에 넣고, 개발 서버(RHEL 9.6)에서 **들고 갈 파일만 가지고** 적힌 그대로 설치해 본다.

> **개정 2026-09-30 (병합 전 검토 반영)** — 검토 셋(문서 정합성 22건 · 자체 점검 15건 · 명령·보안 S1~S6·C1~C12, `docs/internal/P20_검토서_Review.md`)이 착수 때의
> 판단 넷을 뒤집었다: `deps/`를 거꾸로 골랐다(A.1-5), 서명 확인이 서명 없는 RPM을 통과시켰다(A.1-6), firewalld는 Docker가 연 포트를 거르지 않는다(A.1-10), 빌드 쪽
> 셸 명령은 실패해도 멈추지 않았다(A.1-13). 판정하는 순수 함수 넷과 묶는 스크립트 하나(`pnpm release:docker`)가 더해졌다 — **앱의 동작은 그대로다.** 라이선스는 사용자에게
> 물었다(A.2). 고친 뒤 설치 리허설을 처음부터 다시 했다(검증기록 3절).

- 요청 원문: `docs/prompts/phase20/scope.md` (2026-09-30 — "이거 리눅스 서버(RHEL 9)에서 반입해서 실행하는 방법 잘 정리해줘. 필요한 파일만 반입할 수 있게. 최종 완료까지 이어서 진행해.")
- 요구사항 번호: **FR-2100**, 비기능 **NFR-200**부터
- 선행: [`docs/P5_설계서_Release.md`](P5_설계서_Release.md)(반입 묶음) · [`docs/P13_설계서_Readiness.md`](P13_설계서_Readiness.md)(설치 가이드대로 빈 서버에 설치, `tools`) ·
  [`docs/운영가이드_리눅스빌드.md`](운영가이드_리눅스빌드.md) 12절(묶음 만들기)
- 구조: [`docs/설계서_Architecture.md`](설계서_Architecture.md) 9절(배포 경로) — 이미지 셋을 `docker save`/`load`로 옮기는 길은 그대로다

## A. 착수 쟁점

착수 때는 사용자에게 물을 것이 없었다 — 사용자는 "최종 완료까지 이어서 진행해"라고 했고, 아래는 모두 관례적인 기본값이 있거나 이 서버에서 사실을 확인할 수 있는
것이다. 따로 묻지 않고 정한 것과 그 근거는 A.1이다. 병합 전 검토가 규칙상 사용자의 승인이 필요한 것 하나를 드러냈다 — A.2.

## A.1 묻지 않고 정한 것 — 근거와 되돌릴 조건

| # | 정한 것 | 근거 | 되돌릴 조건 |
|---|---|---|---|
| 1 | **들고 갈 것은 반입 묶음 하나(tar와 지문 파일)**, 서버에 Docker가 없으면 **Docker 묶음 하나(tar와 지문 파일)**를 더한다. TLS 인증서와 개인키는 매체에 담지 않고 현장에서 받는다. 저장소·Node·pnpm·`node_modules`·`.local`은 들고 가지 않는다 | 반입 묶음이 이미 필요한 것 전부다 — 이미지 셋(`images.tar`), 띄우는 설정, 설정의 틀, 운영 문서, 지문·부품 목록(`RELEASE_REQUIRED_FILES`, P5·P13). 폐쇄망 서버에서 앱의 코드가 하는 일은 앱 이미지 안에서 돈다(`tools`, P13) — 저장소는 필요 없다. 인증서의 개인키는 반입 매체(여럿이 만지는 USB 등)에 두지 않는 것이 낫다 | 사내 절차가 인증서도 매체로 옮기라고 하면 그 절차를 따른다 |
| 2 | Docker는 **Docker CE**(Docker의 RHEL 저장소 RPM)다 — RHEL의 podman이 아니다 | 이미지를 옮기고 띄우는 길이 `docker load`와 `docker compose`다(0.2절 결정). podman과 `podman compose`로는 이 compose 파일(`profiles`의 `tools`·헬스체크·`restart`)을 돌려 보지 않았다. 개발 서버가 RHEL 9.6 + Docker CE로 그대로 돈다 | 사내 정책이 Docker CE를 막으면 podman으로 돌려 보는 일을 따로 한다(새 Phase) |
| 3 | Docker 묶음의 판은 **빌드 서버에 깔린 판과 같다**(docker-ce 29.6.1 · containerd.io 2.2.6 · docker-compose-plugin 5.3.1 · container-selinux 2.232.1). 판은 묶음의 `PACKAGES.txt`가 적는다 | 반입 묶음의 이미지를 이 판으로 만들고 띄워 봤다. 판을 고르는 스크립트가 `rpm -q`로 지금 판을 읽는다 — 빌드 서버의 Docker를 올리면 묶음도 따라간다. 문서에 판 숫자를 박지 않는다(`PACKAGES.txt`를 가리킨다 — 병합 전 검토) | 없음 |
| 4 | Docker 묶음은 **반입 묶음과 따로** 싼다 | 서버에 Docker가 이미 있으면 그 묶음은 필요 없는 파일이다("필요한 파일만"). 판이 바뀌는 때도 다르다 — 앱은 Phase마다, Docker는 드물게 | 없음 |
| 5 | **맨 위**는 Docker의 넷과 `container-selinux`, **`deps/`**는 firewalld가 없는 RHEL 9에 모자란 넷(`iptables-nft`·`nftables`·`libnftnl`·`jansson`)이다 — `DOCKER_BUNDLE_RPMS`. `deps/`는 **dnf가 모자란다고 할 때, 대상이 묶음을 만든 서버와 같은 부 버전일 때만** 넣는다(`PACKAGES.txt`의 첫 줄과 견준다) | **처음 판은 거꾸로 골랐다** — 빈 RHEL 9 대신 UBI 9.6으로 거래를 계산해 `iptables-libs`·`libnetfilter_conntrack`·`libnfnetlink`를 넣었는데, 그 셋은 모든 RHEL 9에 이미 있고 firewalld가 없는 서버에 정말 모자란 `nftables`·`libnftnl`은 "늘 있다"고 적었다(병합 전 자체 점검 1 — T-098). 고른 법을 바꿨다: 이 서버의 RPM DB 사본에서 Docker 거래를 되돌려(`rpm -e --justdb`) 설치를 모의하면 다섯만으로는 `(iptables-nft or iptables)`·`nftables`가 모자라고, `deps/`를 더하면 모자람이 없다(이미 같은 판인 `jansson`은 건너뛴다 — 검증기록 2절). `jansson`은 `nftables`가 쓰는데 표준 설치에서는 기본 선택 하나(NetworkManager-team)만 끌어온다. 표준 설치(@core의 firewalld)에는 넷 다 이미 있다. `iptables-nft`는 판까지 같은 `iptables-libs`를 요구해 **다른 부 버전에는 맞지 않는다** — 같은 부 버전이라도 업데이트가 다르면 dnf가 `nothing provides iptables-libs(x86-64) = …`로 멈춘다(그때는 `deps/`를 빼고 RHEL 매체에서 — 반영분의 좁은 자체 점검 7) | 그 밖의 부품이 모자라거나 부 버전이 다르면 그 서버의 RHEL 설치 매체(DVD의 BaseOS·AppStream)나 사내 저장소에서 넣는다 — 같은 부 버전의 것이어야 한다. 현장에서 `deps/` 밖의 부품이 모자랐다는 기록이 오면 `DOCKER_BUNDLE_RPMS`에 더할지 정한다(보류 38) |
| 6 | RPM의 **서명을 설치 전에 기계로 판정한다** — 키 파일은 `gpg --show-keys --with-colons`로 **키가 하나이고 그 지문이 Docker의 것**(`060A 61C5 1B55 8A7F 742B  77AA C52F EB6B 621E 9F35`), 서명은 **임시 RPM DB**에 Docker 키와 그 서버의 Red Hat 키를 넣고 `rpm -K`의 줄이 모두 `digests signatures OK`인지(그 밖의 줄이 하나라도 나오면 멈춘다). 통과한 뒤에 두 키를 그 서버에 들이고, 설치는 `--setopt=localpkg_gpgcheck=1`로 dnf도 서명을 보게 한다 | 파일로 설치하면 dnf가 서명을 보지 않는다(`localpkg_gpgcheck`의 기본은 끔 — 서명이 없는 RPM을 그대로 깐다, 검증기록 2절). **처음 판은 사람이 `NOT OK`·`NOKEY`를 찾게 했는데 서명이 없는 RPM은 `digests OK`만 내고 종료 코드 0이라 지나갔고**(T-097), `NOKEY`는 `-v` 없이는 나오지도 않으며, 첫 키의 지문만 보면 키를 더 붙인 파일이 지나갔다(`rpm --import`는 키를 전부 들인다). 또 판정 전에 키를 시스템 DB에 들였다 — 틀렸을 때 남는다(병합 전 보안 검토 S1·S2). 지문(SHA256SUMS)은 옮기는 중에 상했는지만 말한다. Docker의 키는 매체로 오므로 매체째 바뀐 것은 **따로 간 기록**으로 가린다(16) | 없음 |
| 7 | 충돌하는 패키지(`podman`·`podman-docker`·`buildah`·`runc`·`containerd`·`docker`·`docker-io`)는 **설치된 것의 이름**으로 본다(`rpm -qa --qf '%{NAME}\n' \| grep -x…`). **있을 때만, 그 서버에서 쓰는 일이 없는지 본 뒤에**, `-y` 없이 거래표를 보고 지운다 | containerd.io가 `runc`·`containerd`와 부딪히고 그것을 치운다(Obsoletes — dnf가 묻지 않는다), docker-ce(-cli)가 `docker`·`docker-io`·`docker-ee`와 부딪힌다(`rpm -q --conflicts`). `podman-docker`는 같은 `/usr/bin/docker`를 가진다. 처음 판의 `rpm -q … \| grep -v 'not installed'`는 한국어 로캘에서 여섯 줄을 모두 보였다(병합 전 보안 검토 C4). RHEL의 `clean_requirements_on_remove`가 딸린 것까지 지우므로 거래표를 본다(자체 점검 11) | 다른 일이 podman을 쓰면 이 서버에 Docker를 두지 않는다 — 다른 서버를 쓴다 |
| 8 | `docker` 그룹을 쓸지 **먼저** 정한다 — 그룹은 root와 같은 힘이고 그룹으로 친 `docker` 명령은 sudo 기록에 남지 않는다. 쓰면 작업 계정 **하나**를 `gpasswd -a`로 넣고 **`/etc/group`에 한 줄**(그 계정 하나)인지 본다. 쓰지 않으면 가이드의 `docker` 명령을 `sudo`로 친다 | 반입 가이드의 명령은 `docker …`로 적혀 있다. `usermod -aG`는 사내 디렉토리(SSSD 등)의 계정이면 실패하고 `gpasswd -a`는 두 경우 다 된다(자체 점검 12 — 추론. 로컬 계정은 UBI 9.6에서 `docker:x:998:<계정>` 한 줄과, 이 시스템의 그룹이 아니면 `group '…' does not exist in /etc/group`을 봤다). 사내 디렉토리에 `docker` 그룹이 이미 있으면 docker-ce의 설치 스크립트가 로컬 그룹을 만들지 않아(`getent group docker`가 있으면 건너뛴다 — `rpm -q --scripts`) 그 그룹의 모든 사람이 root의 힘을 얻는다(보안 검토 S5) | 사내 보안이 그룹을 막거나 작업 기록을 요구하면 `sudo`로 친다(명령은 같다) |
| 9 | **SELinux는 끄지 않는다**(Enforcing 그대로). Docker의 SELinux 설정도 바꾸지 않는다(기본) | 개발 서버가 RHEL 9.6 · SELinux Enforcing · Docker CE 기본 설정에서 이 스택을 띄운다. `setenforce 0`은 그 서버 전체의 보호를 끈다. Docker CE의 기본 설정에서 컨테이너는 `spc_t`로 돈다(`ps -eZ`) — SELinux는 호스트를 지키고 컨테이너를 가두지 않으므로 홈 디렉토리의 파일을 붙이는 데 라벨을 바꿀 일이 없다(보안 검토 C11) | 현장에서 SELinux가 막는 것이 보이면(그 서버의 Docker가 `selinux-enabled`를 켰을 때 — 장애대응 7.41절) 그 까닭을 보고 정한다 — 끄는 것으로 풀지 않는다 |
| 10 | **firewalld는 바꾸지 않는다** — Docker가 연 포트는 firewalld의 포트 목록을 거치지 않는다. 밖으로 열리는 것은 compose가 연 접속 포트 하나다. 접속할 PC를 좁히려면 사내 망 방화벽에서 한다 | **처음 판은 "켜져 있으면 8443을 연다"였다.** RHEL 9의 firewalld(1.3.4)는 주소를 바꾼(DNAT) 연결을 영역 판정 전에 받아들이고, Docker(29.6.1)는 firewalld에 제 영역(`docker`)과 전달 정책(`docker-forwarding`)을 만든다 — 그래서 여는 명령은 아무것도 바꾸지 않고, "firewalld가 막는다"는 진단은 진짜 원인(사이의 망·주소 겹침)을 가렸으며, "firewalld가 노출을 정한다"는 거짓 안심을 줬다(병합 전 보안 검토 C1 · 자체 점검 2 — firewalld의 소스와 dockerd의 문자열로 판단). 개발 서버에는 firewalld가 없어 실측하지 못했다 | 현장에서 firewalld가 켜진 서버의 다른 PC에서 접속되지 않고 사이의 망·주소가 아니면(보류 38) 다시 본다 |
| 11 | 리허설은 **개발 서버(RHEL 9.6)**에서, 반입 매체 자리에 **두 파일만** 두고 반입 가이드를 적힌 그대로 따른다. 공유 서버라 개발용 스택을 잠시 내리고(볼륨은 둔다) compose 프로젝트 이름만 바꿔(`COMPOSE_PROJECT_NAME`) 빈 볼륨으로 한다. **검토를 반영한 뒤 처음부터 한 번 더** 한다. Docker 묶음을 까는 것은 RHEL 9.6과 같은 **UBI 9.6 컨테이너**에서 설치까지(서명 관문 포함) 한다 | 반입 가이드의 디렉토리 이름 규칙(`deploy`)을 지키면 개발용 스택과 같은 볼륨을 붙인다 — 빈 설치가 되지 않는다. 명령은 그대로 두고 셸의 값 하나만 바꾼다. 반영으로 명령이 바뀌었다 — 적힌 그대로 다시 쳐야 한다(`CLAUDE.md` 4.1절). Docker가 없는 RHEL 9 서버는 이 서버에서 만들 수 없다 — 컨테이너는 쓰고 버리는 것이라 설치를 실제로 할 수 있다(데몬은 켜지 못한다) | 빈 RHEL 9 서버를 얻으면 Docker 묶음부터 적힌 그대로 한 번 더 한다(보류 38) |
| 12 | 마지막 반입 묶음은 **`main`의 병합 커밋으로** 만든다 | 반입 묶음은 이미지 라벨이 저장소의 지금 커밋과 같아야 만든다(리눅스빌드 12절). 사용자에게 건넬 것은 `main`이 가리키는 것이다 | 없음 |
| 13 | Docker 묶음은 **`pnpm release:docker`**가 만든다(`scripts/docker-bundle.ts`). 판정(키·서명·부품 목록)은 공유 `release.ts`의 순수 함수(A등급 — 테스트 먼저)가 하고, 스크립트는 받고 쓰기만 한다. 어느 단계든 틀리면 까닭을 말하고 종료 코드 1로 멈춘다 | 처음 판(가이드의 셸 명령)은 깔리지 않은 패키지의 `package … is not installed`를 `dnf download`에 넘기고, 파일이 빠져도 부분 지문 목록으로 쌌다 — 현장의 `sha256sum -c`는 그것을 `OK`라고 한다(자체 점검 8). 셸 한 덩어리로 막기는 까다롭다(`!`는 `set -e`를 끄고, 파이프의 종료 코드는 판정을 뒤집는다). 저장소가 있는 곳의 명령은 `pnpm <script>`로 적는다(`CLAUDE.md` 4.1절). 반입 묶음의 판정이 `release.ts`에 있는 것과 같은 구조다. 자식 명령은 `LC_ALL=C.UTF-8`로 돌린다(빌드 서버가 한국어 로캘이어도 출력을 글자 그대로 판정한다) | 없음 |
| 14 | 반입 가이드의 **출력은 영어로 본다** — 0절 머리에 `export LC_ALL=C.UTF-8`을 두고, 창을 열 때마다(다시 로그인했을 때도) 친다 | 한국어 로캘에서는 `rpm -q`·`sha256sum -c`·`rpm -K`·dnf의 문장이 바뀌어 가이드와 견줄 수 없다(보안 검토 C4 — 메시지 카탈로그로 확인). `C.UTF-8`은 문장을 영어로 하면서 한글 파일 이름은 그대로 보인다(RHEL 9의 glibc에 들어 있다). RHEL의 sudoers는 `LC_ALL`을 sudo 아래로 넘긴다 | 없음 |
| 15 | Docker를 **켜기 전에** 망 대역을 본다 — 사내 PC·게이트웨이의 주소가 Docker의 기본 풀(`172.17.0.0/16`~`172.31.0.0/16`, 그다음 `192.168.0.0/16`)에 걸리면 `/etc/docker/daemon.json`의 `bip`·`default-address-pools`에 쓰지 않는 대역을 적고 `dockerd --validate`로 본다 | 걸리면 그 PC로 가는 답이 Docker의 망으로 가서 **서버 안에서는 되는데 다른 PC에서는 안 된다** — 처음 판의 7.41이 방화벽으로 잘못 가리킨 증상과 같다(보안 검토 C2). 금융 사내망은 `172.16.0.0/12`를 흔히 쓴다. 켠 뒤에 바꾸면 compose의 망을 다시 만들어야 한다. `dockerd --validate`는 root 없이 **모양(JSON의 문법과 키 이름)만** 본다 — `/33`·`size: 40`처럼 값이 틀려도 `configuration OK`다(반영분의 좁은 자체 점검 5). 값이 틀리면 켤 때 실패한다(장애대응 7.41절 — `journalctl -u docker`) | 없음 |
| 16 | 두 묶음의 **`.tar.sha256` 값을 매체와 따로 가는 기록**(반입 신청서 등)에도 적고, 현장에서 견준다 | 지문 파일·가이드·키가 모두 같은 매체로 간다 — 매체를 바꿀 수 있는 사람은 그 모두를 함께 바꾼다. 따로 간 기록은 두 묶음·가이드·compose를 한 번에 덮는 유일한 출처 확인이다(보안 검토 S3) | 없음 |
| 17 | 디스크는 **세 자리**를 본다 — 묶음을 풀 자리(`~`), 데이터베이스·첨부(`/var/lib/docker`), 이미지(`/var/lib/containerd`) | Docker 29의 새 설치는 containerd의 이미지 저장소를 쓴다(`docker info`의 `driver-type: io.containerd.snapshotter.v1`) — `docker load`는 `/var/lib/containerd`를 채운다. 처음 판은 `/var/lib/docker`만 봤다(보안 검토 C3 · 자체 점검 6) | 없음 |
| 18 | 묶음 tar의 파일 주인은 **숫자 0**으로 싼다(`--owner=0 --group=0 --numeric-owner`) | 만든 계정의 이름이 묶음에 남지 않게 한다(보안 검토 S6). 일반 계정이 풀면 풀린 파일은 그 계정의 것이다 | 없음 |

## A.2 병합 전 검토 뒤에 물은 것

| # | 물은 것 | 답 |
|---|---|---|
| 1 | Docker 묶음에 Red Hat의 RHEL 부품(GPL 계열 넷 — `container-selinux`·`iptables-nft`·`nftables`·`libnftnl`, MIT 하나 — `jansson`)을 실어도 되는가 — `CLAUDE.md` 7절은 GPL을 승인 없이 금지한다(Windows 체험 묶음의 LGPL도 승인을 받았다) | **"승인 — 싣는다 (추천)"** (2026-09-30, `docs/prompts/phase20/scope.md`). 고치지 않고 싣는다 — 대상 서버의 RHEL과 같은 배포판의 부품이고, 현장은 그 서버 자신의 Red Hat 키로 서명을 본다. 앱 이미지·반입 묶음과 섞이지 않는다. 판·라이선스 목록은 묶음의 `PACKAGES.txt`, `CLAUDE.md` 7절에 적었다. 고르지 않은 쪽 — Docker의 넷(Apache-2.0)만 싣고 RHEL 부품은 현장의 RHEL 매체·사내 저장소에서(둘 다 없으면 그날 들이지 못한다) |

## B. 요구사항

| # | 요구사항 | 확인 |
|---|---|---|
| FR-2100 | **들고 갈 것** — 반입 가이드의 맨 앞에 목록을 둔다: 반드시(반입 묶음 tar · `.sha256`), 서버에 Docker가 없을 때만(Docker 묶음 tar · `.sha256`), 현장에서 받는 것(TLS 인증서·개인키), 들고 가지 않는 것. 두 지문 값은 매체와 따로 가는 기록에도 적는다. 매체의 형식(NTFS는 붙지 않는다) | 문서 · 리허설(두 파일만으로 끝까지) |
| FR-2101 | **Docker 묶음을 만든다** — `pnpm release:docker`(리눅스빌드 가이드 12-1절). 빌드 서버에 깔린 판의 RPM 다섯 + `deps/` 넷 + `PACKAGES.txt`(RHEL 판·판·라이선스) + Docker 공개키 + `SHA256SUMS`, 맨 위 디렉토리 하나로 싼 tar와 그 지문. 키는 하나와 그 지문, 서명은 RPM마다 `digests signatures OK`. **아무것도 설치하지 않는다** | A등급 시험(`release.spec.ts`) · 적힌 그대로 쳐서 만든다 |
| FR-2102 | **RHEL 9에 Docker를 들인다**(없을 때만) — 반입 가이드 0.3절: ① 지문(따로 간 기록과 견준다)·풀기(전에 푼 것을 치우고) ② 키와 서명을 임시 자리에서 기계로 판정 → 통과하면 키를 들인다 ③ 부딪히는 패키지(이름으로) ④ `dnf install --setopt=localpkg_gpgcheck=1`(거래표를 보고 답한다 — 저장소가 없으면 `--disablerepo='*'`, `deps/`는 같은 부 버전일 때만, 그 밖은 RHEL 매체) ⑤ 망 대역(켜기 전) ⑥ 켜기·`docker` 그룹(이 서버의 그룹인지) → 다시 로그인 | 서명·지문·관문(UBI 9.6 — 서명 없는 RPM을 판정이 잡고 dnf가 거절한다) · 의존(RPM DB 사본) · 설치(UBI 9.6) · 데몬을 켜는 것은 현장(보류 38) |
| FR-2103 | **RHEL 9에서 한 번 더 볼 것** — 반입 가이드 0절 머리·0.4절: 출력은 영어로(`LC_ALL=C.UTF-8`), 방화벽(바꿀 것이 없다 — Docker가 연 포트를 거르지 않는다), SELinux(끄지 않는다), Docker의 망 대역, 시각(`timedatectl`), 디스크 세 자리 | 문서 · 개발 서버에서 SELinux Enforcing으로 리허설 |
| FR-2104 | **장애 유형** — 장애대응 7.41절: 지문·키·서명(서명 없음까지)·키를 들이지 않았다·dnf가 모자란 것을 말한다(부 버전)·거래표의 바꾸기·runc/podman과 부딪힌다·SELinux 도구의 경고·`daemon.json`·`docker.sock`·디렉토리의 `docker` 그룹·다른 PC에서 접속이 안 된다(사이의 망·망 대역)·파일 권한·SELinux가 막는다 | `pnpm verify:docs` |
| FR-2105 | **리허설** — 개발 서버(RHEL 9.6, SELinux Enforcing)에서 두 파일만 가지고 반입 가이드 0~8절을 적힌 그대로: 지문 · 이미지 올리기 · 설정 · 표 만들기(두 번) · 첫 root · 전부 띄우기 · 사후 검증(헬스·로그인과 비밀번호 변경·문서·첨부·감사·앱 계정·요청 번호·로그 순환·같이 고치기·오래 열어 두기) · 첫 백업. 검토를 반영한 뒤 한 번 더 | 검증기록 |
| FR-2106 | **마지막 반입 묶음** — `main`의 병합 커밋으로 만들고 `release:verify`와 지문을 건넨다(PR 설명) | 병합 뒤 |
| NFR-200 | **앱의 동작·이미지 구성·설정 키·의존성은 바뀌지 않는다.** 더해지는 코드는 묶음을 만드는 쪽뿐이다 — 판정하는 순수 함수(공유 `release.ts`, A등급)와 스크립트 하나(`scripts/docker-bundle.ts`, `pnpm release:docker`). 새 문서 종류는 없다 — 반입 가이드·리눅스빌드 가이드·장애대응·운영이관·학습가이드·구조 설계서에 절과 행을 더한다(E절, `CLAUDE.md` 10절) | `git diff --name-only` · lockfile |

## C. 반입 가이드에 더하는 것

**0절을 "들고 갈 것과 미리 확인할 것"으로 넓힌다** — 절 번호는 그대로다(다른 문서가 0절·1절…을 가리킨다).

- **0절 머리**: 출력은 영어로 본다(`export LC_ALL=C.UTF-8`).
- **0.1 들고 갈 것 — 필요한 파일만**: 표 하나(파일 · 언제 · 크기의 어림). 반입 매체에는 파일 둘(또는 넷)만. 지문 값은 따로 가는 기록에도.
- **0.2 서버에 있어야 하는 것**: 지금의 0절 표(RHEL 9.2 이상·Docker·compose·디스크·`tar`·`sha256sum`·`openssl`) — `docker`가 없으면 0.3으로.
- **0.3 RHEL 9에 Docker가 없으면 — Docker 묶음으로 들인다**: FR-2102의 ①~⑥. 명령은 bash 그대로(저장소가 없는 곳 — `CLAUDE.md` 4.1절의 예외).
- **0.4 RHEL 9에서 한 번 더 볼 것**: FR-2103.

순서는 **반입 묶음부터 푼다**(1절)가 아니다 — Docker가 없으면 `docker load`를 할 수 없으니 0.3을 먼저 한다. 반입 가이드는 반입 묶음 안에도 있으므로(`반입절차.md`),
현장에서는 반입 묶음을 먼저 풀어 이 문서를 읽고 0.3부터 해도 된다 — 푸는 데는 `tar`·`sha256sum`만 쓴다(`tar`가 없는 최소 설치는 0.2절).

## D. 리눅스빌드 가이드에 더하는 것

**12-1절 — Docker 설치 묶음을 만든다(대상 서버에 Docker가 없을 때만)**: `pnpm release:docker` 한 줄과 그것이 하는 일(A.1-13) — 판을 `rpm -q`로 읽어(없으면 멈춘다)
아키텍처까지 적어 `dnf download`로 받는다(받은 것이 기대와 다르면 멈춘다), Docker 공개키를 받아 키 하나와 그 지문을 본다, 서명을 임시 RPM DB로 본다(빌드 서버의 RPM DB는
건드리지 않는다), `PACKAGES.txt`·`SHA256SUMS`와 tar·지문. 판정의 공유 함수:

| 함수 (`packages/shared/src/release.ts`) | 판정 |
|---|---|
| `DOCKER_BUNDLE_RPMS` | 싣는 RPM의 이름 — `top` 다섯, `deps` 넷 |
| `dockerKeyProblem(colons)` | `gpg --show-keys --with-colons`의 출력 — 주 키가 하나이고 그 바로 뒤 `fpr`이 `DOCKER_KEY_FINGERPRINT`(공백을 뺀 것)인가. 부속 키의 `fpr`은 보지 않는다 |
| `rpmSignatureProblems(output, files)` | `rpm -K`의 출력 — 넘긴 파일마다 `<파일>: digests signatures OK` 한 줄인가. 서명 없음(`digests OK`)·`NOT OK`·결과 없음·목록 밖의 줄은 문제다 |
| `formatPackages(release, rows)` | `PACKAGES.txt` — 첫 줄은 RHEL 판 그대로, 다음 줄부터 파일·라이선스·만든 곳(탭). 판이 여러 줄이거나 비었거나, 칸에 탭·줄바꿈이 있으면 거절한다 |

## E. 모듈과 등급

앱의 동작은 바뀌지 않는다. 더해지는 코드는 묶음을 만드는 쪽이다.

| 무엇 | 등급 | 바뀌는 것 |
|---|---|---|
| `packages/shared/src/release.ts` (+ `release.spec.ts`) | A — 테스트 먼저 | D절의 판정 넷 |
| `scripts/docker-bundle.ts` · `package.json` | 도구(`scripts/`) | `pnpm release:docker` |
| `docs/운영가이드_반입.md` | 문서 | 머리(개정·인터넷 안내), 0절(머리·0.1~0.4), 1절(매체 tar의 지문부터 — 따로 간 기록과), 3절(개인키 `600`), 9절 표, 10절 ②(사내 CA 파일은 `644`). 담당의 이름을 운영이관 8절에 맞췄다 |
| `docs/운영가이드_리눅스빌드.md` | 문서 | 머리, 1절(도커 디스크 · 12-1절의 요건), 2절 표, 3절(도커 디스크), 12절 끝, 12-1절, 13절(정리) |
| `docs/운영가이드_장애대응.md` | 문서 | 7.41절, 1절 증상표, 9절 표. 디스크를 보는 명령(2·5절·7.14·7.17 — `/var/lib/docker`·`/var/lib/containerd`) |
| `docs/운영가이드_운영이관.md` | 문서 | 0절(`sudo docker`), 3.1·8절(디스크 세 자리), 6절(하지 말 것 — SELinux를 끄지 않는다·`docker` 그룹·compose에 `ports:`·Docker 올리기), 8절 표(서버의 OS), 9절 |
| `docs/학습가이드_시스템이해.md` | 문서 | 6.20절 · 7절 표 |
| `docs/설계서_Architecture.md` | 문서 | 9절(배포 경로 — RHEL 9·Docker 묶음) · 10절 표 |
| `CLAUDE.md` · `docs/scope-definition.md` | 문서 | Phase 20 행(1절 표 · 5절 인수 기준), 4.1절 표준 스크립트(`release:docker`), 7절 의존성(Docker 묶음의 승인), 1.2절 보류 38 |
| `docs/기능백로그.md` · `docs/prompts/phase20/scope.md` | 문서 | F-014 · 요청 원문과 A.2의 답 |

## F. 설정 항목

**새 설정 키는 없다.** `.env.example`·compose·Windows 체험 묶음은 바뀌지 않는다.

## G. 보류 결정

- **보류 38 (새로)** — 빈 RHEL 9에 Docker 묶음을 까는 것과 firewalld가 켜진 서버. 이 Phase는 Docker가 이미 있는 개발 서버에서 지문·서명·충돌 검사, 그 서버의 RPM DB
  사본(Docker 거래를 되돌린 것)에서의 의존 계산, RHEL 9.6과 같은 UBI 9.6 컨테이너에서의 설치(서명 관문 포함 — 데몬은 켜지 못했다)까지만 했다. 처음 판은 이것을 "현장에서만
  할 수 있는 확인이라 1.2절 표에 올리지 않는다"고 적었다 — 같은 부류인 보류 11·18·29(현장에서 처음 붙이는 사내 IdP·메일·LLM)와 13이 표에 있다(병합 전 검토 둘이 따로
  짚었다). 트리거·판정 방법은 `CLAUDE.md` 1.2절 표.
