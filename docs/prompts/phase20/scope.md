# Phase 20 — 요청 원문

> 사용자가 한 말만 그대로 둔다(`CLAUDE.md` 11절). 정리·판정은 `docs/기능백로그.md` F-014와 이 Phase의 설계서(`docs/P20_설계서_Install.md`)에 있다.

## 2026-09-30 — Phase 19 병합 뒤, 착수

> Windows에서 써봤더니 괜찮은 것 같아.
> 이대로 진행하자.
> 이거 리눅스 서버(RHEL 9)에서 반입해서 실행하는 방법 잘 정리해줘. 필요한 파일만 반입할 수 있게.
> 최종 완료까지 이어서 진행해.

## 2026-09-30 — 병합 전 검토 뒤, 라이선스 결정

Claude가 물은 것(선택지 둘): "Docker 묶음에 Red Hat의 RHEL 부품(GPL 계열 넷 — container-selinux·iptables-nft·nftables·libnftnl, MIT 하나 — jansson)을
실어도 될까요? 규칙(CLAUDE.md 7절)은 GPL을 승인 없이 금지합니다."

사용자가 고른 것:

> 승인 — 싣는다 (추천)

## 2026-09-30 — 병합 뒤, 안내 문서

> 반입 및 설치 절차와 방법, 새 windows 버전 설치 방법까지 작성해서 github에 올려줘.
> 여기에는 새 windows 버전 확인하는 방법 쉽고 자세히 써줘고.
