# CATCHME Backend (회원가입 / 로그인)

## 1. 설치

```bash
cd catchme-backend
npm install
cp .env.example .env
```

`.env` 파일을 열어서 `DATABASE_URL`을 본인 PostgreSQL 접속 정보로 바꿔주세요.
`JWT_SECRET`은 아무 문자열이나 길게 넣어주면 됩니다 (실서비스에선 랜덤 문자열 필수).

## 2. DB 마이그레이션

```bash
npx prisma migrate dev --name init
```

`users`, `events`, `matching_rooms`, `room_participants` 테이블이 생성됩니다.

## 3. 서버 실행

```bash
npm run dev
```

`http://localhost:4000` 에서 실행됩니다.

## 4. API 테스트

### 회원가입

```bash
curl -X POST http://localhost:4000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "me@catchme.com",
    "username": "me_catchme",
    "name": "나",
    "password": "abcd1234",
    "phone": "010-1234-5678"
  }'
```

성공하면 아래처럼 JWT 토큰과 유저 정보를 돌려줍니다 (비밀번호 해시는 응답에 절대 포함되지 않아요):

```json
{
  "message": "회원가입이 완료됐어요.",
  "token": "eyJhbGciOi...",
  "user": {
    "id": "...",
    "email": "me@catchme.com",
    "username": "me_catchme",
    "name": "나",
    "diamondBalance": 10,
    ...
  }
}
```

### 아이디 중복 확인 (프론트엔드 실시간 체크용)

```bash
curl "http://localhost:4000/api/auth/check-username?username=me_catchme"
# { "available": false }
```

### 로그인

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "emailOrUsername": "me_catchme", "password": "abcd1234" }'
```

## 검증 규칙

- **이메일**: 표준 이메일 형식
- **아이디**: 영문 소문자로 시작, 3~20자 (영문 소문자/숫자/`.`/`_`)
- **비밀번호**: 8자 이상, 영문+숫자 포함
- **전화번호** (선택): `010-1234-5678` 형식
- 이메일/아이디 중복 시 409 응답
- 로그인 실패 시 "아이디가 없는지 비밀번호가 틀렸는지" 구분되지 않도록 동일한 에러 메시지 반환 (계정 존재 여부 추측 방지)

## 5. 친구 API (검색 / 요청 / 수락·거절 / 목록)

> `FriendRequest` 모델이 새로 추가됐어요. 아래 명령으로 마이그레이션을 한 번 더 실행해주세요.
> ```bash
> npx prisma migrate dev --name add_friend_requests
> ```

이 라우터는 전부 로그인이 필요해요. 로그인 응답으로 받은 `token`을
`Authorization: Bearer <token>` 헤더에 담아 보내야 합니다.

### 아이디로 유저 검색

```bash
curl "http://localhost:4000/api/friends/search?query=min" \
  -H "Authorization: Bearer <TOKEN>"
```

### 친구 요청 보내기

```bash
curl -X POST http://localhost:4000/api/friends/requests \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "username": "minji" }'
```

### 받은/보낸 요청 목록

```bash
curl http://localhost:4000/api/friends/requests -H "Authorization: Bearer <TOKEN>"
```

### 요청 수락 / 거절

```bash
curl -X POST http://localhost:4000/api/friends/requests/<requestId>/accept -H "Authorization: Bearer <TOKEN>"
curl -X POST http://localhost:4000/api/friends/requests/<requestId>/decline -H "Authorization: Bearer <TOKEN>"
```

### 내 친구 목록

```bash
curl http://localhost:4000/api/friends -H "Authorization: Bearer <TOKEN>"
```

### 친구 삭제

```bash
curl -X DELETE http://localhost:4000/api/friends/<friendId> -H "Authorization: Bearer <TOKEN>"
```

**프라이버시 처리**: 검색/목록/요청 응답에서 상대방의 전화번호·이메일은
`phonePublic`/`emailPublic`이 꺼져 있으면 `null`로 내려가요. 본인 데이터를
직접 조회하는 게 아니라, 항상 "상대방이 공개로 설정했는지"를 기준으로 필터링합니다.

## 6. 채팅 API (1:1 채팅방 / 메시지 / 예약 요청)

> `ChatRoom`, `ChatRoomMember`, `Message` 모델이 새로 추가됐어요.
> ```bash
> npx prisma migrate dev --name add_chat
> ```

이 라우터도 전부 로그인이 필요해요.

### 1:1 채팅방 가져오기(없으면 생성)

```bash
curl -X POST http://localhost:4000/api/chats/direct \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "username": "minji" }'
# => { "roomId": "...", "created": true }
```

### 내 채팅방 목록 (최근 활동순)

```bash
curl http://localhost:4000/api/chats -H "Authorization: Bearer <TOKEN>"
```

### 메시지 내역 조회

```bash
curl "http://localhost:4000/api/chats/<roomId>/messages?limit=50" \
  -H "Authorization: Bearer <TOKEN>"
```

### 텍스트 메시지 보내기

```bash
curl -X POST http://localhost:4000/api/chats/<roomId>/messages \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "text": "이번 주 토요일 어때요?" }'
```

### 예약 요청 보내기

```bash
curl -X POST http://localhost:4000/api/chats/<roomId>/reservations \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "start": "2026-07-16T19:00:00+09:00",
    "end": "2026-07-16T20:00:00+09:00",
    "note": "저녁 같이 먹어요!"
  }'
```

### 예약 요청 수락 / 거절

```bash
curl -X POST http://localhost:4000/api/chats/messages/<messageId>/accept -H "Authorization: Bearer <TOKEN>"
curl -X POST http://localhost:4000/api/chats/messages/<messageId>/decline -H "Authorization: Bearer <TOKEN>"
```

**중요한 규칙 2가지**
- 예약 요청은 **받은 사람만** 수락/거절할 수 있어요 (보낸 사람이 직접 수락하면 403 에러).
- 수락하면 그 채팅방에 있는 **모든 멤버의 캘린더(Event)** 에 동일한 시간으로 `BUSY` 일정이 자동 등록돼요 — 프론트엔드 데모에서 하던 "예약 확정 시 캘린더에도 등록" 동작을 그대로 서버에 옮긴 거예요.

실시간으로 상대방 화면에 메시지가 바로 뜨게 하려면 Socket.io나 서버센트이벤트(SSE) 같은 게 추가로 필요해요. 지금은 REST로 조회할 때만 최신 상태를 받아오는 구조예요.

## 7. 캘린더(내 일정) API

`Event` 모델은 처음부터 스키마에 있었어요 (마이그레이션 추가 불필요).
이 라우터도 로그인이 필요해요.

### 이번 달 일정 조회

```bash
curl "http://localhost:4000/api/events?year=2026&month=7" \
  -H "Authorization: Bearer <TOKEN>"
```

특정 기간으로 조회하려면 `?start=2026-07-01T00:00:00&end=2026-07-08T00:00:00` 형식도 가능해요.

### 일정 만들기

```bash
curl -X POST http://localhost:4000/api/events \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "팀 스터디",
    "startTime": "2026-07-14T13:00:00+09:00",
    "endTime": "2026-07-14T14:00:00+09:00"
  }'
```

`status`를 안 주면 기본값은 `BUSY`예요. 특정 시간대를 일부러 "가능"으로
표시해두고 싶으면 `"status": "AVAILABLE"`로 명시하면 돼요.

### 일정 수정 / 삭제

```bash
curl -X PATCH http://localhost:4000/api/events/<eventId> \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "title": "팀 스터디 (장소 변경)" }'

curl -X DELETE http://localhost:4000/api/events/<eventId> -H "Authorization: Bearer <TOKEN>"
```

일정은 전부 **본인 것만** 조회·수정·삭제할 수 있어요 (다른 사람 id로 시도하면 404).
채팅에서 예약을 수락했을 때 자동으로 생기는 일정도 전부 이 `Event` 테이블에 저장되니까,
프론트엔드의 월간 캘린더 / 시간표 화면은 이 API 하나로 다 그려낼 수 있어요.

## 다음 단계

- [x] JWT 인증 미들웨어 (`Authorization: Bearer <token>` 검증) — 기본 버전 추가됨
- [x] 친구 검색 / 요청 / 수락·거절 / 목록 API
- [x] 채팅방 / 메시지 / 예약 요청(수락 시 캘린더 자동 등록) API
- [x] 개인 캘린더(일정) CRUD API
- [ ] 실시간 메시지 전송 (Socket.io / SSE)
- [ ] 캘린더 매칭(기간 내 겹치는 시간 계산) API
- [ ] 다이아 결제 연동 (실제 PG사 연동은 별도 검토 필요)
- [ ] 이메일 인증 / 비밀번호 재설정
- [ ] 인증 미들웨어에 토큰 만료/재발급(refresh token) 흐름 보강
