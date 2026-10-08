#!/usr/bin/env bash
# 앱 이미지를 빌드한다 — compose와 분리했다. compose(`deploy/compose.yml`)는 만들어 둔 이미지를 띄우기만 한다.
# 사용: 저장소 맨 위에서 `deploy/build.sh`. 결과: workfluence-app:latest 와 확인용 태그 workfluence-app:<짧은 sha>
#
# 사내망 빌드 서버는 프록시 뒤에 있다. 도커 데몬에만 프록시가 설정돼 있으면 RUN 단계는 밖으로 못 나가 `npm install`이 ETIMEDOUT으로 죽는다.
# 값은 셸 환경에서 받으므로 저장소에 사내 주소가 남지 않고, 프록시가 없으면 빈 값이라 무해하다.
set -euo pipefail
cd "$(dirname "$0")/.."
GIT_SHA="$(git rev-parse HEAD)"
args=(--build-arg "GIT_SHA=${GIT_SHA}")
for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
  args+=(--build-arg "${v}=${!v:-}")
done
docker build -f deploy/Dockerfile "${args[@]}" -t workfluence-app:latest -t "workfluence-app:${GIT_SHA:0:7}" .
