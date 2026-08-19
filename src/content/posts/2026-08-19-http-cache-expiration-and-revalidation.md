---
title: "HTTP 캐시의 만료와 재검증: ETag와 304의 흐름"
description: "Cache-Control로 정한 재사용 시간이 지난 뒤 ETag와 If-None-Match, 304 Not Modified가 불필요한 본문 전송을 줄이는 흐름을 정리한다."
pubDatetime: 2026-08-19T19:04:00+09:00
---

HTTP 캐시는 같은 응답을 매번 다시 내려받지 않으려고 씁니다. 핵심은 **"이 응답을 얼마나 믿고 재사용할 수 있는가"**를 두고 브라우저와 서버가 약속하는 일이죠. 이때 자주 쓰는 도구가 `Cache-Control`, `ETag`, `If-None-Match`입니다.

## 캐시가 만료된 뒤의 문제

서버는 응답을 보내면서 `Cache-Control` 헤더에 재사용 규칙을 담습니다. `max-age=60`이라면 브라우저는 같은 자원을 60초 동안 그대로 써도 된다고 판단합니다.

문제는 그 시간이 지난 뒤입니다. 이때 `ETag`가 등장합니다. 서버는 응답 본문의 버전처럼 쓰이는 식별자를 `ETag: "resource-version-1"` 형태로 보냅니다. 캐시가 만료되면 브라우저는 저장해둔 값을 `If-None-Match: "resource-version-1"`로 다시 전달합니다.

서버의 선택지는 두 가지입니다.

1. 리소스가 바뀌지 않았다면 `304 Not Modified`
1. 리소스가 바뀌었다면 `200 OK`와 새 본문, 새 `ETag`

`304`는 본문 없이 상태만 알려주므로 네트워크 비용이 줄어듭니다. 캐시는 "응답을 안 받는 기술"이라기보다 **불필요한 본문 전송을 피하는 기술**에 가깝습니다.

## ETag를 이용한 재검증 흐름

```plain text
GET /resources/example HTTP/1.1

HTTP/1.1 200 OK
Cache-Control: max-age=60
ETag: "resource-version-1"
```

60초가 지나면 브라우저는 이렇게 재검증합니다.

```plain text
GET /resources/example HTTP/1.1
If-None-Match: "resource-version-1"

HTTP/1.1 304 Not Modified
```

헤더와 상태코드는 각각 이런 역할을 합니다.

- `Cache-Control`: 언제까지 그냥 써도 되는지 결정
- `ETag`: 현재 응답 버전을 식별
- `If-None-Match`: 브라우저가 가진 버전을 서버에 전달
- `304 Not Modified`: 본문은 그대로니 다시 안 보내도 된다는 신호

## 만료와 재검증을 분리해서 보기

캐시를 이해하려면 **만료와 재검증을 나눠서 보는 시각**이 중요합니다.

`Cache-Control`은 재사용 시간을 정합니다. `ETag/If-None-Match`는 만료된 뒤 실제로 바뀌었는지 확인합니다. 이 조합을 이해하면 브라우저가 어떤 요청은 빠르게 끝내고, 어떤 요청은 본문을 다시 받는지 훨씬 선명하게 보입니다.
