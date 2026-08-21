---
title: "HTTP 캐시는 만료 뒤에도 다시 쓸 수 있다"
description: "Cache-Control로 신선도를 정하고 ETag와 If-None-Match, 304로 만료된 응답을 재검증하는 흐름을 정리한다."
pubDatetime: 2026-08-21T19:07:00+09:00
category: web
---

배포 후 프론트엔드 화면을 열어 보면 요청마다 속도가 다릅니다. 어떤 요청은 금세 끝나고, 어떤 요청은 서버까지 다시 다녀와요.

네트워크 탭에 304 Not Modified가 떠도 요청은 나갑니다. 다만 응답 본문이 없어요. 이 차이를 이해하려면 HTTP 캐시를 바로 재사용하는 구간과 서버에 변경 여부만 확인하는 구간을 나눠 봐야 합니다.

## 만료는 캐시를 버리는 시간이 아니다

HTTP 캐시에서 저장된 응답을 아직 재사용할 수 있는 상태를 fresh라고 합니다. 신선도 수명이 지나면 stale이 돼요.

stale은 삭제됐다는 뜻이 아닙니다. 바로 쓸 수 없을 뿐, 재검증을 거치면 다시 사용할 수 있거든요.

응답 헤더 중 신선도 수명을 가장 직접적으로 나타내는 건 Cache-Control입니다.

```plain text
Cache-Control: max-age=604800
```

max-age는 응답이 원 서버에서 생성된 뒤 몇 초 동안 fresh로 간주되는지를 나타냅니다. 기준 시점이 중요해요. 브라우저가 받은 때가 아니라 원 서버가 생성한 때이며, 공유 캐시를 거쳤다면 Age 헤더에 담긴 시간도 고려해야 합니다.

```plain text
Cache-Control: max-age=604800
Age: 100
```

수명 전체가 604800초여도 이 응답은 이미 100초가 지난 것으로 계산됩니다. 100초를 쓴 셈이죠. HTTP 캐시는 파일이 로컬에 있는지만 보지 않고, 저장한 응답 메타데이터를 바탕으로 지금 다시 써도 되는지 판단합니다.

Cache-Control의 no-cache는 이름과 달리 저장을 막지 않아요. 저장은 허용하되 재사용 전에 원 서버 검증을 요구합니다. 정말 저장하지 말라는 지시자는 no-store입니다.

```plain text
Cache-Control: no-cache
```

이 응답은 저장할 수 있습니다. 다만 다음에 사용할 때는 서버에 다시 확인해야 해요. 저장 자체를 막으려면 다음처럼 써야 합니다.

```plain text
Cache-Control: no-store
```

캐시를 켤지부터 묻는 건 아닙니다. 응답을 저장해도 되는지, 서버 확인 없이 얼마 동안 재사용할지, 공유 캐시에 저장해도 될지를 먼저 정해야 하니까요.

## 재검증은 다시 받기가 아니라 다시 묻기다

캐시 수명이 끝나도 브라우저는 저장된 본문부터 버리지 않습니다. 자신이 가진 버전이 아직 유효한지 서버에 물어요. 이때 대표적으로 쓰는 식별자가 ETag입니다.

ETag는 특정 버전의 리소스를 식별하는 응답 헤더입니다. 값은 큰따옴표로 감싼 문자열이며 콘텐츠 해시, 수정 시각 해시, 리비전 번호 등으로 만들 수 있어요.

```plain text
ETag: "675af34563dc-tr34"
ETag: W/"0815"
```

앞에 W/가 붙으면 weak validator입니다. 바이트 단위의 완전한 일치보다 의미상 같은 표현으로 볼 수 있는지를 나타내는 데 가까워요. weak ETag는 만들기 쉽지만 정확한 비교에는 덜 유용하고, strong ETag는 비교에 더 좋지만 효율적으로 만들기 어려울 수 있죠.

캐시를 재검증할 때 브라우저는 저장해 둔 ETag를 If-None-Match 요청 헤더에 넣습니다.

```plain text
If-None-Match: "bfc13a64729c4290ef5b2c2730249c88ca92d82d"
If-None-Match: W/"67ab43", "54ed21", "7892dd"
If-None-Match: *
```

GET이나 HEAD 요청에서 서버의 현재 ETag가 If-None-Match 값과 다르면 200 OK와 본문을 보낼 수 있습니다. 같으면 304 Not Modified를 보내요. 조건이 “이 값과 일치하지 않는다면 보내 달라”는 뜻이라서, 일치할 때는 보낼 필요가 없습니다.

If-None-Match와 If-Modified-Since가 함께 있고 서버가 If-None-Match를 지원한다면 If-None-Match가 우선합니다. ETag 기반 검증자가 있다면 수정 시각 기반 검증보다 먼저 봐야 해요.

## 304는 본문 없는 메타데이터 갱신이다

304 Not Modified는 조건부 GET 또는 HEAD 요청에서 리소스를 다시 전송할 필요가 없으며, 클라이언트가 캐시된 버전을 계속 써도 된다는 뜻입니다.

먼저 클라이언트가 If-None-Match를 보냅니다.

```bash
curl --http1.1 -I --header 'If-None-Match: "b20a0973b226eeea30362acb81f9e0b3"' \
  https://developer.mozilla.org/en-US/
```

HTTP 메시지로 나타내면 다음과 같은 조건부 요청이 됩니다.

```plain text
GET /en-US/ HTTP/1.1
Host: developer.mozilla.org
User-Agent: curl/8.7.1
Accept: */*
If-None-Match: "b20a0973b226eeea30362acb81f9e0b3"
```

서버의 현재 ETag가 이 값과 일치하면 본문을 다시 보내지 않고 다음처럼 응답할 수 있어요.

```plain text
HTTP/1.1 304 Not Modified
Date: Wed, 28 Aug 2024 10:36:35 GMT
Expires: Wed, 28 Aug 2024 11:02:17 GMT
Age: 662
ETag: "b20a0973b226eeea30362acb81f9e0b3"
Cache-Control: public, max-age=3600
Vary: Accept-Encoding
X-cache: hit
Alt-Svc: clear
```

304에는 본문이 없어야 합니다. 대신 같은 요청의 200 OK 응답에 들어갔을 Cache-Control, Content-Location, Date, ETag, Expires, Vary 같은 헤더를 포함해야 해요.

클라이언트 캐시는 이 헤더로 저장된 응답의 메타데이터를 갱신합니다. 본문은 기존 것을 계속 씁니다.

304는 서버 요청을 없애지 않습니다. 서버에 확인하되 리소스가 바뀌지 않았다면 본문 전송만 생략해요.

캐시 실패가 아닙니다. 네트워크 탭에 304가 보인다면 만료 뒤 재검증 경로가 제대로 동작했다는 신호일 수 있거든요.

브라우저 개발자 도구의 네트워크 패널은 로컬 캐시 접근을 보여주려고 추가 요청을 만들고 304 응답을 일으킬 수 있습니다. 개발자 도구에 표시된 요청 수만 보고 실제 사용자 환경의 캐시 동작을 단정하면 안 돼요.

## 응답 성격에 따라 정책이 달라진다

사용자별 응답을 공유 캐시에 저장하면 안 됩니다. 쿠키가 있다고 응답이 저절로 private이 되는 것도 아니니, 서버가 의도를 명시해야 해요.

```plain text
Cache-Control: private
```

브라우저 같은 개인 캐시에만 저장할 수 있다면 private을 고려할 수 있습니다. 민감해서 저장 자체가 부적절한 응답에는 no-store를 써야 해요. 인증 토큰, 사용자별 상태, 일회성 결과라면 짧게 캐시하기보다 저장하지 않는 정책이 더 맞을 수 있습니다.

ETag 생성 비용도 따져야 합니다. 정적 파일처럼 빌드 결과물이나 파일 해시가 이미 있다면 자연스럽게 쓸 수 있어요.

매 요청마다 큰 응답 본문을 만들고 해시까지 계산한다면 304를 얻기도 전에 비싼 작업을 끝낸 셈입니다. 이럴 때는 리비전 번호, 갱신 시각, 데이터 버전처럼 더 저렴한 검증자를 쓸 수 있는지 먼저 봐야 하죠.

같은 URL이라도 요청 헤더에 따라 표현이 달라진다면 Vary가 필요합니다. 압축 방식, 언어, 인증 관련 헤더처럼 응답을 바꾸는 입력이 있는데 Vary를 제대로 처리하지 않으면 잘못된 응답을 재사용할 수 있어요.

## 백엔드 시스템에 적용하기

TypeScript와 NestJS로 Slack 기반 LLM 멀티 에이전트 시스템을 운영해도 모든 모듈에 같은 캐시 정책을 적용할 수는 없습니다.

slack, webhook처럼 외부 플랫폼 이벤트나 인터랙션을 받는 경로에서는 요청 처리 자체가 이벤트 소비이고, 응답도 플랫폼 프로토콜의 일부입니다. 긴 max-age를 붙일 이유가 없으며 Cache-Control: no-store에 가까운 정책이 안전해요.

agent-run, agent/pm, agent/work-reviewer, agent/code-reviewer처럼 사용자 입력, GitHub 상태, 모델 응답에 따라 결과가 달라지는 모듈은 특히 조심해야 합니다.

결과 조회 API에는 사용자별 private 캐시를 검토할 수 있어요. 다만 공유 캐시에 저장하면 안 되는 데이터가 섞일 가능성이 큽니다. private, no-store, 짧은 재검증 정책 가운데 무엇이 맞는지는 응답마다 정해야 합니다.

반대로 crawler의 공개 크롤링 결과 조회나 agent/blog의 공개 가능한 초안 미리보기처럼 같은 URL의 표현이 일정 시간 안정적이라면 ETag가 잘 맞습니다. 결과 행의 updatedAt이나 버전 필드로 ETag를 만들고, 만료 뒤 If-None-Match로 재검증하게 할 수 있어요.

NestJS에서는 컨트롤러나 공통 응답 계층인 common에서 캐시 정책을 일관되게 붙이는 구조를 고려할 수 있습니다.

```plain text
Cache-Control: private, max-age=60
ETag: "result-version-123"
```

이런 헤더를 붙이기 전에 사용자별로 저장해도 되는지, 60초 동안 바뀌지 않는다고 봐도 되는지 확인해야 합니다. 버전 123이 같은 본문을 대표한다고 말할 수 있는지도 살펴야 해요. 하나라도 애매하면 더 보수적인 정책을 택해야 합니다.

HTTP 캐시가 Slack 이벤트 처리나 LLM 실행 자체를 줄여 주는 마법은 아닙니다. 같은 응답을 서버 확인 없이 재사용할 시간과, 만료 뒤 서버에 묻되 본문은 다시 보내지 않을 경로를 구분하는 도구예요.

응답마다 저장 가능성, 신선도 수명, 검증자, 공유 범위를 명시해야 합니다. 이게 캐시 정책의 핵심입니다.

## 참고 문서

- MDN Web Docs, Cache-Control header: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control
- MDN Web Docs, ETag header: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag
- MDN Web Docs, If-None-Match header: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-None-Match
- MDN Web Docs, 304 Not Modified: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/304
- MDN Web Docs, HTTP caching: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching
- RFC 9111, HTTP Caching: https://www.rfc-editor.org/rfc/rfc9111.html
