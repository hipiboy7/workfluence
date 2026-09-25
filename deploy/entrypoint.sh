#!/bin/sh
# 앱 컨테이너의 시작 (P11_설계서_Ops D.7, FR-1221).
#
# compose 옆의 `ca` 디렉토리(컨테이너의 /etc/workfluence/ca)에 **사내 CA 인증서(ca.pem)가 있으면** 앱이 그것을 믿게 하고 띄운다 —
# 사내 LLM(https)과 사내 IdP(OIDC)가 사내 인증 기관이 서명한 인증서를 쓸 때다. 없으면 그대로 띄운다(빈 값을 넘기면 Node가 기동할 때마다
# 경고를 남긴다). **TLS 검증은 그대로다** — 믿을 기관을 하나 더할 뿐이다 (CLAUDE.md 7절).
set -eu
CA_FILE=/etc/workfluence/ca/ca.pem
if [ -s "$CA_FILE" ]; then
  export NODE_EXTRA_CA_CERTS="$CA_FILE"
fi
exec "$@"
