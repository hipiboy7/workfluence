# API 사용가이드 — 공개 API v1

- 읽는 사람: 위키의 기능을 **프로그램으로 쓰려는 개발자**와 **LLM 에이전트(도구를 부르는 서비스)**. 위키 화면을 쓰는 법은 [사용자가이드](../../guide/사용자가이드.md) 28절이다
- 무엇을 답하나: "토큰을 어떻게 받고, 어떤 요청을 어떻게 보내고, 오류가 오면 무엇을 하나"
- 정확한 경로·입력·응답의 모양은 이 문서가 아니라 **명세**(`GET /api/v1/openapi.yaml`)가 정본이다. 이 문서는 명세를 받아 읽는 법과 자주 하는 일의 예다
- 기준: 2026-10-12의 코드(공개 API v1 — 동작 75개, 채팅 9개 포함). 설계 근거는 [설계서_PublicApi](설계서_PublicApi.md)
- 아래 `curl` 예는 개발 서버에서 순서대로 실제로 불러 확인했다 (2026-10-08)

## 1. 시작하기

### 1.1 토큰 받기

토큰은 **화면에서 사람이** 발급한다(토큰으로 토큰을 만들지 못한다).

1. 위키에 로그인해 위 막대의 **API 토큰**을 누른다
2. **이름**(어디에 쓰는지 알아볼 이름)과 **권한**을 고르고 **발급**을 누른다 — 읽기만 하면 **읽기**, 쓰기도 하면 **쓰기**까지. **관리**는 관리자에게만 보이고 사용자·정책·감사 경로에 더 필요하다
3. 나온 값을 **그 자리에서** 복사한다 — 값은 한 번만 보이고 다시 볼 수 없다(서버에도 값이 없다). 잃으면 폐기하고 새로 발급한다

토큰은 **그 사람이 화면에서 할 수 있는 일을 넘지 못한다.** 권한(scope)은 그것을 줄이기만 한다. 토큰마다 만료(기본 90일, 최대 365일)가 있고 한 사람이 살아 있는 토큰을 10개까지 가진다. 사람이 정지되거나 비밀번호를 바꾸거나 관리자가 세션을 끊으면 그 사람의 토큰이 모두 그 자리에서 죽는다.

### 1.2 첫 호출

이 문서의 예는 아래 두 변수를 쓴다. 주소는 지어낸 것이다.

```bash
BASE=https://wiki.example.internal
TOKEN=<발급한 토큰>
```

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/spaces"
```

내가 볼 수 있는 스페이스가 `{"items":[…]}`로 온다. 사내 CA로 서명한 인증서면 `--cacert 사내CA.pem`을 더한다. **쿠키도, CSRF 머리말도 필요 없다** — 머리말 하나(`Authorization`)면 된다.

### 1.3 명세 받기

```bash
curl -s "$BASE/api/v1/openapi.yaml" -o openapi.yaml
curl -s "$BASE/api/v1/openapi.sha256"
```

셋 다 **인증 없이** 받는다.

| 주소 | 무엇 |
|---|---|
| `GET /api/v1/openapi.yaml` | 명세(OpenAPI 3.1) — **키를 정렬한 YAML**. 한 줄에 한 항목이고 같은 코드는 늘 같은 글이라, 앞서 받은 것과 줄 단위로 비교하면 바뀐 곳만 보인다. 에이전트는 이것을 읽는다 |
| `GET /api/v1/openapi.sha256` | 위 YAML 글의 SHA-256(16진수 64자, 줄바꿈 없음). 받은 파일의 해시(`sha256sum openapi.yaml`)와 같다 |
| `GET /api/v1/openapi.json` | 같은 명세의 JSON(한 줄로 압축돼 온다) |

경로마다 요약·설명·입력·응답·필요한 권한이 있고, 칸마다 뜻·단위·범위·기본값이 있다. 머리말(`info.description`)에 토큰·오류 코드·고칠 때의 규칙이 있다. 에이전트가 쓰는 법은 5절이다.

## 2. 약속

| 무엇 | 약속 |
|---|---|
| 인증 | `Authorization: Bearer <토큰>`. 없으면 401 `TOKEN_MISSING` — **세션 쿠키가 있어도 보지 않는다** |
| 권한(scope) | 읽기(GET)는 `read`, 그 밖은 `write`(`write`는 `read`를 포함), 사용자·정책·감사는 `admin`이 **더**. 모자라면 403 `INSUFFICIENT_SCOPE`(필요한 scope를 말한다) |
| 사람의 권한 | scope를 통과해도 그 사람의 권한이 거절하면 403 `FORBIDDEN`. 볼 수 없는 것은 없는 것과 같은 404다 |
| 오류 | 항상 `{"error":{"code","message","requestId"}}` 한 모양. **분기는 문장이 아니라 `code`로** 한다. `requestId`를 운영자에게 알리면 로그에서 그 요청을 찾는다 |
| 목록 | `{"items":[…]}`. `limit`로 자른다(경로마다 기본·상한이 명세에 있다) |
| 본문 형식 | 읽을 때 `format`=`markdown`(기본)·`json`·`text`, 쓸 때 본문과 `format`=`markdown`(기본)·`json`. 마크다운은 원시 HTML·그림·허용 밖 링크를 거절한다(400, 줄 번호와 까닭만 말하고 입력은 되읊지 않는다) |
| 이름으로 고르기 | 스페이스·분류·사용자(Crew)·라벨은 id를 외우지 않고 **이름으로** 부를 수 있다. 없는 이름은 404이고, 분류는 고를 수 있는 이름을 `details.available`로 준다 |
| 기본값 | 만들 때 필수는 대개 **어디·제목·본문**뿐이다. 나머지는 서버가 채우고 **응답이 채운 값을 말한다**(부모·위치·버전) — 다음 호출에 id를 외우지 않아도 된다 |
| 빈도 제한 | 토큰마다 읽기 120번·쓰기 30번 / 분. 넘으면 429 `RATE_LIMITED`와 `Retry-After`(초). **채팅 보내기만 예외** — 사용자마다 분당 60(3.13절) |
| 감사 | 토큰으로 한 일도 감사로그에 화면과 같은 이름으로 남고 **어느 토큰인지**(`jti`)가 함께 남는다 |
| 호환 | v1은 더하기만 한다(필드·경로 추가). 빼거나 뜻을 바꾸면 v2다. 모르는 응답 필드는 무시한다 |

## 3. 자주 하는 일

아래는 한 흐름이다 — 앞 예의 결과를 뒤 예가 쓴다. 쓰기 예는 `write` 권한 토큰이 필요하다.

### 3.1 스페이스 만들기 — 이름만

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"API 시험 공간"}' "$BASE/api/v1/spaces"
```

팀 스페이스가 만들어지고 내가 주인이다. 응답의 `id`를 쓰거나, 이후에는 **이름**으로 부른다.

### 3.2 페이지 만들기 — 스페이스·제목·본문

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"space":"API 시험 공간","title":"첫 글","body":"# 큰 제목\n\n본문 **굵게** 입니다.\n\n- 하나\n- 둘"}' \
  "$BASE/api/v1/pages"
```

응답에 서버가 정한 `parentId`(null — 맨 위)·`position`·`currentVersionNo`(1)와 조상 경로(`ancestors`)가 온다. 응답에서 `id`를 꺼내 둔다:

```bash
PAGE_ID=$(curl -s -G -H "Authorization: Bearer $TOKEN" --data-urlencode "q=첫 글" --data-urlencode "space=API 시험 공간" \
  "$BASE/api/v1/search" | sed -n 's/.*"pageId":"\([^"]*\)".*/\1/p' | head -1)
echo "$PAGE_ID"
```

(`jq`가 있으면 만들기 응답에서 `.id`를 바로 꺼낸다. 위는 방금 만든 글을 **검색으로** 찾아 id를 얻는 길이다. 한글·공백이 든 쿼리는 `curl -G --data-urlencode`로 보낸다 — 주소에 그대로 쓰면 curl이 인코딩하지 않는다.)

### 3.3 읽기

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/pages/$PAGE_ID"
```

본문이 마크다운 글자(`body`)로 온다. 문서 트리가 필요하면 `?format=json`, 글자만이면 `?format=text`. 스페이스의 페이지 목록(본문 없이)은 `GET /api/v1/pages`에 `space`(이름이나 id)를 쿼리로 준다.

### 3.4 고치기 — 고칠 것만

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"# 큰 제목\n\n본문을 고쳤다.","baseVersionNo":1}' "$BASE/api/v1/pages/$PAGE_ID"
```

안 보낸 제목은 그대로다. 기준 버전(`baseVersionNo`)은 **꼭** 보낸다(없으면 400) — 페이지를 읽을 때 받은 `currentVersionNo`를 그대로 보내면 된다. 서버가 지금 버전으로 채우면 그 사이 다른 사람의 저장을 조용히 덮기 때문이다. 어긋나면 409 `VERSION_CONFLICT`(`details.currentVersionNo`가 지금 버전) — 다시 읽고 고쳐서 다시 보낸다. **사람이 그 페이지를 실시간으로 편집 중이면** 409 `PAGE_BEING_EDITED` — 그 사람의 입력을 지우지 않으려고 막는다. 편집이 끝난 뒤 다시 시도한다.

### 3.5 검색

```bash
curl -s -G -H "Authorization: Bearer $TOKEN" --data-urlencode "q=고쳤다" --data-urlencode "space=API 시험 공간" "$BASE/api/v1/search"
```

필수는 검색어(`q`)뿐이다 — 내가 읽을 수 있는 모든 스페이스에서 찾는다(한글 두 글자부터). `space`로 좁힌다. `limit` 기본 20·최대 50. 없는 스페이스 이름은 빈 결과가 아니라 404다.

### 3.6 댓글

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"확인했습니다."}' "$BASE/api/v1/pages/$PAGE_ID/comments"
```

필수는 본문뿐이다. 답글이면 `parentId`. 본문의 `@사용자이름`은 멘션이 되어 알림이 간다.

### 3.7 라벨 — 이름으로

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"api"}' "$BASE/api/v1/pages/$PAGE_ID/labels"
```

떼는 것도 이름으로 한다 — `DELETE /api/v1/pages/{pageId}/labels/api`.

### 3.8 첨부 — JSON으로

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"filename":"회의록.txt","content":"안건 1"}' "$BASE/api/v1/pages/$PAGE_ID/attachments"
```

글은 `utf8`(기본), 바이너리는 `"encoding":"base64"`로 보낸다. 파일 그대로 올리려면 multipart(`file` 칸)도 된다. 형식(mime)은 받지 않고 확장자에서 정한다. 종류·크기 규칙은 화면과 같다. 응답의 `href`를 본문에 마크다운 링크(대괄호 이름 뒤에 괄호 주소)로 넣으면 사람이 눌러 받는다(문서에는 그림 노드가 없어 링크로 건다). 받을 때는 기본이 바이너리이고, `?format=json`이면 글·base64로 JSON에 담긴다.

### 3.9 템플릿으로 시작하기

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/templates"
```

템플릿 본문을 읽어 3.2의 `body`로 보내면 된다(템플릿을 만들고 고치는 것은 관리자만).

### 3.10 지운 것 되살리기

```bash
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/pages/$PAGE_ID"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/trash/pages"
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/trash/pages/$PAGE_ID/restore"
```

지우면 휴지통으로 가고(보존 기간 안), 되살린다. 부모가 없어졌으면 맨 위로 되살리고 응답의 `movedToRoot`가 참이다.

### 3.11 Crew 다루기 — 사용자 이름으로

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"alice"}' "$BASE/api/v1/spaces/<스페이스 id>/members"
```

역할을 안 주면 `editor`다(`owner` 자리는 줄 수 없다). 바뀐 Crew 목록 전체가 온다.

### 3.12 관리 — `admin` 권한이 있는 토큰

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/users?q=alice"
```

사용자 목록·승인·잠금 해제·정지·역할·맡기는 권한, 운영 정책값, 감사로그를 읽는다. 토큰에 `admin`이 없으면 403 `INSUFFICIENT_SCOPE`다. **비밀번호 초기화는 이 API에 없다** — 임시 비밀번호를 돌려주는 경로가 토큰에 있으면 토큰 하나가 남의 계정을 넘겨받는 길이 되기 때문이다.

### 3.13 채팅 — 방과 메시지, 그리고 실시간 연결 (Phase 21)

에이전트가 사람처럼 **한 사용자로** 방에 들어와 메시지를 받고 답한다. 경로 아홉(`chat.*` — 방 목록·만들기·초대·나가기, 메시지 읽기·보내기, 읽음, 사람 찾기)은 명세에 있고, **WebSocket은 OpenAPI가 표현하지 못해 명세의 머리말("채팅 실시간 연결")과 이 절에 있다.**

**연결** — `wss://<서버>/api/v1/chat/ws`에 업그레이드 요청을 보낸다. 머리말에 `Authorization: Bearer <토큰>`(토큰을 주소의 `?token=`으로 주면 401이다 — 주소는 로그에 남는다). `Origin`·쿠키는 필요 없다. 토큰에 `read`가 있어야 연결되고(없으면 403) 보내려면 `write`가 더 있어야 한다. 연결 하나로 내가 든 **모든 방**의 새 메시지가 온다.

```js
// Node — `ws` 패키지
const ws = new WebSocket(`${BASE.replace('https', 'wss')}/api/v1/chat/ws`, { headers: { Authorization: `Bearer ${TOKEN}` } });
ws.on('message', (data) => {
  const f = JSON.parse(data.toString());
  if (f.type === 'message' && f.kind === 'user' && f.senderId !== ME) { // 안내 줄(join·leave)에는 답하지 않는다
    ws.send(JSON.stringify({ type: 'send', roomId: f.roomId, body: '확인했습니다', clientMsgId: crypto.randomUUID() }));
  }
});
```

| 방향 | `type` | 뜻 |
|---|---|---|
| 서버→나 | `hello` | 연결 직후 한 번 — `userId`, 참여한 방 `roomIds` |
| 서버→나 | `message` | 방의 새 메시지(`roomId`·`seq`·`senderId`·`body`·`kind`·`createdAt`) — **내가 보낸 것도 온다.** `kind`는 아래 "메시지의 종류" |
| 서버→나 | `ack` | 내가 보낸 `send`의 결과(`clientMsgId`·`roomId`·`seq`·`createdAt`) |
| 서버→나 | `room` | 내가 방에 들었다·나갔다(`change`=joined·left), 또는 내가 든 방의 참여자가 바뀌었다(`members`) — 방이 새로 생기면 연결을 다시 열지 않아도 온다 |
| 서버→나 | `error` | 보낸 것 하나를 거절(`code`·`roomId`·`clientMsgId`) — 연결은 그대로. `EMPTY`·`TOO_LONG`·`BAD_CHAR`·`ROOM_NOT_FOUND`·`INSUFFICIENT_SCOPE`·`RATE_LIMITED` |
| 나→서버 | `send` | `{"type":"send","roomId":"…","body":"…","clientMsgId":"(선택)"}` — **이것 하나뿐이다** |

**메시지의 종류(`kind`)** — 메시지마다 있다(REST의 메시지·방의 `lastMessage`·WebSocket `message` 프레임 모두).

| `kind` | 뜻 | `senderId` | `body` |
|---|---|---|---|
| `user` | 사람(또는 에이전트)이 보낸 메시지 | 보낸 사용자 | 보낸 글 |
| `join` | 누가 방에 들어왔다 — 시스템이 넣은 **안내 줄** | 초대한 사용자 | `OO님이 채팅방에 들어왔습니다` |
| `leave` | 누가 방에서 나갔다 — 시스템이 넣은 **안내 줄** | 나간 사용자 | `OO님이 채팅방을 나갔습니다` |

- **안내 줄은 사람의 말이 아니다 — 답하지 않는다.** 위의 예처럼 `kind === 'user'`만 골라 답한다. 안내 줄에 답하면 "들어왔습니다"에 "확인했습니다"를 되풀이해 방이 어지러워진다.
- 안내 줄도 **메시지라 `seq`를 먹는다** — 번호가 비지 않으니 `afterSeq`로 메울 때 걸러 내지 말고 받은 뒤 `kind`로 가른다. 안 읽은 수(`unread`)는 올리지 않는다.
- 안내 줄은 **시스템만 만든다.** `POST …/messages`·`send` 프레임으로는 `user`만 보낼 수 있다(`kind` 칸을 받지 않는다).
- 이름은 그 줄을 넣을 때의 표시 이름이다. 나중에 이름이 바뀌어도 줄은 고쳐지지 않는다(메시지는 고치지 않는다).
- 이 필드는 2026-10-15에 더해졌다 — 그 전의 메시지는 모두 `user`다. 옛 클라이언트는 이 칸을 몰라도 동작하지만, **모든 메시지에 답하는 클라이언트는 안내 줄에도 답한다.**

**지킬 것**
- **모르는 `type`·모르는 칸·JSON이 아닌 글·바이너리·너무 큰 프레임**은 서버가 연결을 닫는다(코드 4400, 큰 것은 1009). 같은 것을 다시 보내지 말고 프레임을 고친다.
- 토큰이 폐기·만료되거나 주인이 정지·비밀번호 변경·세션 강제 종료를 당하면 연결이 닫힌다(**4401**) — 다시 붙지 말고 새 토큰을 받는다.
- 같은 사용자의 연결이 상한(기본 5)을 넘으면 **가장 오래된** 연결이 닫힌다(**4409**) — 닫지 않고 다시 열기만 하면 쌓이지 않는다.
- **연결은 새 메시지만 보낸다.** 끊겼다 돌아오면 방마다 마지막으로 받은 `seq` 이후를 `GET /chat/rooms/{id}/messages?afterSeq=<seq>&limit=200`으로 받아 메운다 — **한 번에 `limit`개까지만 오므로 `limit`개가 다 오면 마지막 `seq`로 이어서 받는다**(아니면 가운데 구멍이 남는다). 같은 메시지가 둘 오면 `(roomId, seq)`로 거른다.
- 연달아 보낸 `send`는 보낸 순서대로 번호를 받는다. 끊겼다 다시 보낼 때는 **같은 `clientMsgId`**로 보낸다 — 같은 값은 한 번만 받는다(REST 보내기의 응답은 `duplicate: true`).
- 여럿 방은 **참여자 누구나** 초대할 수 있다(`POST /chat/rooms/{id}/members`) — 만든 사람이 아니어도, 만든 사람이 나가도 된다(2026-10-15 개정, 그 전에는 만든 사람만). 참여자가 아니면 404, 1:1 방은 403 `DIRECT_ROOM`이다.
- 방 정보(`GET /chat/rooms`·`/chat/rooms/{id}`)의 `pastMembers`는 **방을 나간 사람**의 `userId`·`displayName`이다(2026-10-15 더함). 나간 사람이 쓴 메시지의 `senderId`를 이름으로 바꿀 때 `members`에 없으면 여기서 찾는다. "나갔습니다" 안내 줄(`kind=leave`)이 있는 사람만 실리고, 다시 초대돼 들어와 있으면 `members`에 있다.
- 분당 보내기 한도는 **사용자마다** 기본 60이다 — 연결·토큰을 여럿 열어도 한 예산이고 화면의 보내기도 같은 예산이다. 공개 API의 쓰기 한도(30)와 별개다. 넘으면 `RATE_LIMITED`(REST는 429와 `details.retryAfterSec`).
- 서버가 30초마다 ping을 보낸다 — WebSocket 라이브러리의 pong 자동 응답을 끄지 않는다.
- 메시지는 **평문**이다. 방은 참여자만 읽고 쓴다 — 참여하지 않은 방은 있는지도 알려 주지 않는 404다. 메시지의 보존·삭제·감사는 정하지 않았다(보류 39).

연결 없이 **REST만으로**도 쓸 수 있다: `GET /chat/rooms`로 방을 보고, `GET /chat/rooms/{id}/messages?afterSeq=`로 새 것을 가져오고, `POST /chat/rooms/{id}/messages`로 보낸다(폴링은 느리다 — 실시간이 필요하면 연결을 쓴다).

## 4. 오류

| 상태 | `code` | 뜻 → 할 일 |
|---|---|---|
| 401 | `TOKEN_MISSING` | `Authorization` 머리말이 없다 → 붙인다(쿠키는 보지 않는다) |
| 401 | `TOKEN_INVALID` | 토큰의 모양·서명이 틀렸다 → 복사가 잘렸는지, 서버의 비밀 값이 바뀌지 않았는지(바뀌면 발급한 토큰이 모두 죽는다) |
| 401 | `TOKEN_UNKNOWN` | 서명은 맞는데 토큰 기록이 없다 → 새로 발급한다 |
| 401 | `TOKEN_REVOKED` | 폐기됐다(사람이 폐기했거나 정지·비밀번호 변경·세션 종료로) → 새로 발급한다. **되살릴 수 없다** |
| 401 | `TOKEN_EXPIRED` | 만료됐다 → 새로 발급한다 |
| 401 | `ACCOUNT_INACTIVE` | 주인의 계정이 정지·승인 대기다 → 관리자에게 |
| 403 | `PASSWORD_CHANGE_REQUIRED` | 주인이 화면에서 비밀번호를 바꿔야 쓸 수 있다 |
| 403 | `INSUFFICIENT_SCOPE` | 토큰의 권한이 모자란다 → 메시지가 필요한 scope를 말한다. 권한을 올려 새로 발급한다 |
| 403 | `FORBIDDEN` | 사람의 권한이 없다(예: 템플릿 만들기는 관리자만) → 토큰을 바꿔도 안 된다 |
| 503 | `API_DISABLED` | 서버에 공개 API가 꺼져 있다 → 운영자에게 |
| 400 | `INVALID_REQUEST` | 입력이 틀렸다 → 메시지가 칸과 까닭을 말한다(값은 싣지 않는다) |
| 400 | `INVALID_JSON` | 본문이 JSON이 아니다 |
| 400 | `EMPTY`·`TOO_LONG`·`BAD_CHAR`·`DIRECT_ROOM`·`SELF_ROOM`·`NO_MEMBERS`·`BAD_QUERY` | 채팅 — 메시지 본문의 문제·1:1 방에서 나가기·자기 자신과의 1:1·부를 사람이 없다·번호 질의가 틀렸다(3.13절). `DIRECT_ROOM`은 **1:1 방에 사람을 초대할 때는 403**이다(2026-10-15 — 그 전에는 `FORBIDDEN`) |
| 413 | `PAYLOAD_TOO_LARGE` | 본문이 너무 크다 |
| 413 | `TOO_LARGE_FOR_JSON` | 첨부가 JSON으로 받기에 너무 크다 → `format` 없이 바이너리로 받는다 |
| 404 | `NOT_FOUND` | 없거나 볼 수 없다 — 둘을 구별하지 않는다 |
| 404 | `ROOM_NOT_FOUND`·`USER_NOT_FOUND`·`CHAT_DISABLED` | 채팅 — 참여하지 않은 방(있는지도 알려 주지 않는다)·부를 수 없는 사용자(정지·승인 대기·없는 id)·서버가 채팅을 껐다 |
| 404 | `SPACE_NOT_FOUND`·`SPACE_REQUIRED`·`CATEGORY_NOT_FOUND`·`MEMBER_NOT_FOUND`·`LABEL_NOT_FOUND` | 이름으로 부른 것이 없다 → 이름을 다시 본다(스페이스는 `GET /api/v1/spaces`, 분류는 오류의 `details.available`) |
| 409 | `SPACE_AMBIGUOUS` | 같은 이름의 스페이스가 여럿이다 → id로 고른다 |
| 409 | `VERSION_CONFLICT` | 기준 버전이 어긋났다 → `details.currentVersionNo`로 다시 읽고 고쳐 다시 보낸다 |
| 409 | `PAGE_BEING_EDITED` | 사람이 실시간 편집 중이다 → 잠시 뒤 다시 |
| 409 | `CONFLICT` | 그 밖의 충돌(이름이 겹침·그 사이 상태가 바뀜) → 메시지를 읽고 다시 본다 |
| 429 | `RATE_LIMITED` | 빈도 제한 → `Retry-After`(초)만큼 기다린다 |
| 500 | `INTERNAL` | 서버의 결함 → `requestId`를 운영자에게 |

**재시도 규칙** — 429는 기다렸다 같은 요청을, 5xx는 읽기만 다시, 쓰기는 응답을 모르면 **읽어서 확인한 뒤** 다시 보낸다(이름이 겹치면 409다). 401·403·404·400은 같은 요청을 되풀이해도 낫지 않는다.

## 5. 에이전트에 연결하기

사내 LLM 서비스처럼 도구를 부르는 쪽은 **명세에서 도구를 만든다.** 손으로 옮겨 적으면 어긋난다.

### 5.1 명세를 받아 읽는 법 — 처음은 전체, 그 뒤는 변동분

명세는 YAML로 약 8,000줄(동작 75개)이다.

1. **처음** — `openapi.yaml`을 받아 **전체를** 분석해 도구를 만든다. 받은 파일과 `openapi.sha256` 값을 함께 보관한다.
   - 머리말(`info.description`)을 먼저 읽는다 — 토큰, 오류 코드와 각각의 대처, 고칠 때 `baseVersionNo`를 보내는 규칙, 목록은 `limit`까지만 온다는 것이 여기 있다
   - `paths`의 동작마다 `operationId`·`summary`·`description`·`parameters`·`requestBody`·`responses`·`security`로 도구 하나를 만든다(5.2절). 409가 있는 동작은 그 409 설명이 무엇이 겹쳤는지와 다음에 할 일을 말한다
   - `security`의 scope(`read`·`write`·`admin`)로 **토큰에 없는 도구는 처음부터 뺀다**
2. **그 뒤** — 주기로(또는 도구 호출이 400·404로 이상하게 실패할 때) `GET /openapi.sha256`만 부른다.
   - 보관한 값과 **같으면** 명세가 바뀌지 않았다. 아무것도 하지 않는다
   - **다르면** `openapi.yaml`을 다시 받아 보관한 파일과 줄 단위로 비교한다(`diff old.yaml new.yaml`). 키가 정렬돼 있어 바뀐 경로·칸만 차이로 나온다 — 그 경로의 도구만 다시 만들고, 사라진 경로의 도구는 뺀다. 새 파일과 새 해시를 보관한다
3. 이 API는 **더하기만** 한다(머리말) — 같은 v1 안에서는 경로·칸이 늘 뿐, 있던 칸의 뜻이 바뀌거나 사라지지 않는다. 그래서 변동분은 대개 "새 경로·새 칸"이다

### 5.2 도구 정의 예

`operationId`의 `.`은 도구 이름에 쓸 수 없는 곳이 많으니 `_`로 바꾼다(`pages.create` → `pages_create`). 입력 스키마는 경로의 `parameters`(경로·쿼리)와 `requestBody`(본문)를 한 객체로 합친다. 아래는 `pages.create`를 명세에서 옮긴 예다.

```json
{
  "name": "pages_create",
  "description": "페이지 만들기 — 필수는 space(이름이나 id)·title·body뿐이다. 부모를 안 주면 맨 위, 위치는 맨 끝에 만든다. 본문은 마크다운이 기본이다.",
  "input_schema": {
    "type": "object",
    "properties": {
      "space": { "type": "string", "description": "스페이스의 이름이나 id" },
      "title": { "type": "string", "description": "페이지의 제목 — 300자까지" },
      "body": { "description": "본문 — format이 markdown(기본)이면 마크다운 글자, json이면 문서 객체" },
      "format": { "type": "string", "enum": ["markdown", "json"], "default": "markdown" },
      "parentId": { "type": ["string", "null"], "description": "부모 페이지의 id — 안 주면 스페이스의 맨 위" }
    },
    "required": ["space", "title", "body"]
  }
}
```

### 5.3 도구 호출을 HTTP 요청으로

| 명세의 것 | 요청에서의 자리 |
|---|---|
| 메서드·경로 | 그대로. 경로의 `{이름}`은 입력의 같은 이름 값으로 바꾼다(주소에 쓰므로 인코딩한다) |
| `in: query` 매개변수 | 주소의 `?이름=값` |
| `requestBody` | JSON 본문(`Content-Type: application/json`) |
| `security` | `Authorization: Bearer <토큰>` — 토큰은 도구 정의가 아니라 **호출 쪽 설정**에 둔다. 모델의 문맥에 넣지 않는다 |

도구 결과로는 **응답 본문을 그대로** 돌려주고, 오류면 `error.code`·`error.message`를 함께 준다 — 모델이 `code`로 다음을 정한다(4절).

### 5.4 에이전트가 지킬 것

- 쓰기 전에 **읽는다** — 고칠 페이지의 `currentVersionNo`를 `baseVersionNo`로 보내면 남의 저장을 덮지 않는다
- 409 `PAGE_BEING_EDITED`는 사람이 쓰는 중이라는 뜻이다 — 같은 요청을 쏟지 말고 기다린다
- 429면 `Retry-After`를 지킨다. 읽기 120·쓰기 30 / 분은 토큰마다다
- 토큰은 로그·대화·도구 결과에 싣지 않는다. 새어 나갔다고 의심되면 화면에서 **폐기**한다(관리자는 사용자 관리에서 그 사람 것을 폐기한다)

## 6. 이 API에 없는 것

- **비밀번호 초기화** — 위의 3.12절 까닭
- **사내 LLM 질문·연결 관리** — 사내 LLM은 별도의 서비스가 맡고, 그 서비스가 이 API를 부르는 쪽이다. 위키 안의 LLM 질문 화면은 사람이 쓰는 기능이다
- **토큰 발급·폐기** — 화면(세션)에서만 한다
- **실시간 공동 편집** — 사람의 편집기가 쓴다. API로 쓰는 저장은 사람이 편집 중이면 409다. (채팅의 실시간 연결은 있다 — 3.13절)
- **그림 문법(`![]()`)** — 문서에 그림 노드가 없다. 첨부를 링크로 건다(3.8)

## 7. 막히면

- 오류의 `requestId`와 `code`를 운영자에게 알린다 — [장애대응가이드](../../guide/장애대응가이드.md) 7.42절(공개 API)과 7.28절(요청 번호로 로그 잇기)
- 401·403은 토큰의 상태를 화면의 **API 토큰**에서 본다(상태·마지막 사용)
