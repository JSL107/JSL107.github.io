---
title: "MCP Stateless Core에서 상태를 드러내는 방법"
description: "MCP의 세션 없는 요청 구조가 원격 에이전트 서버의 라우팅, 실행 상태, 멱등성 설계에 어떤 질문을 던지는지 살펴본다."
pubDatetime: 2026-11-12T19:47:00+09:00
category: backend
---

Slack에 “오늘 할 일을 정리해줘”라고 보내면 내부 봇은 누가 불렀는지, 어떤 에이전트를 골랐는지, 이전에 무엇을 실행했는지를 한 애플리케이션 안에서 이어서 다룰 수 있어요. 하지만 로드밸런서 뒤에 서버가 여러 대 있고 긴 작업은 큐로 보내는 원격 에이전트 툴 서버라면 다음 요청도 같은 연결의 상태를 볼 수 있다는 전제가 흔들려요.

이 글은 MCP 2026-07-28 명세와 공식 릴리스 후보 글을 읽고 TypeScript·NestJS 기반 Slack 멀티 에이전트 시스템에 대입해 본 개념 글이에요. 원격 MCP 서버를 직접 붙여 부하 테스트한 결과는 아니에요.

## 세션에 넣던 것을 요청 위로 끌어올린다

MCP 2026-07-28에서 바뀐 것은 “상태를 없앤다”기보다 “프로토콜 레벨 세션에 상태를 숨기지 않는다”에 가까워요. 이전 세대에는 클라이언트가 먼저 `initialize`로 서버와 합의하고 서버가 세션 식별자를 주면, 이후 요청마다 그 식별자를 실어 보냈어요. 연결 뒤에 생긴 맥락은 서버가 기억하는 방식이었죠.

공식 릴리스 후보 글의 2025-11-25 방식 예시에서는 먼저 초기화 요청을 보내요.

```plain text
POST /mcp HTTP/1.1
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"protocolVersion":"2025-11-25","capabilities":{},
           "clientInfo":{"name":"my-app","version":"1.0"}}}
```

그다음 서버가 돌려준 `Mcp-Session-Id`를 다음 요청에 실어요.

```plain text
POST /mcp HTTP/1.1
Mcp-Session-Id: 1868a90c-3a3f-4f5b
Content-Type: application/json

{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"search","arguments":{"q":"otters"}}}
```

로컬 프로세스나 단일 서버에서는 자연스러운 구조예요. 하지만 원격 서버를 여러 인스턴스로 늘리면 세션을 발급한 인스턴스가 다음 요청도 받거나, 모든 인스턴스가 세션 저장소를 공유해야 해요. sticky session이나 공유 저장소를 붙일 수는 있지만 그만큼 운영 장치에 의존하게 돼요. 게이트웨이도 JSON body를 열어 보기 전에는 어떤 도구를 호출했는지 알 수 없고요.

2026-07-28 방식에서는 요청 하나만으로 처리할 수 있도록 버전, 메서드, 이름, 클라이언트 정보를 매 요청에 담아요.

```plain text
POST /mcp HTTP/1.1
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: search
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"search","arguments":{"q":"otters"},
           "_meta":{"io.modelcontextprotocol/clientInfo":{"name":"my-app","version":"1.0"}}}}
```

이제 어느 서버 인스턴스든 요청을 받을 수 있어요. 게이트웨이는 body를 파싱하지 않아도 `Mcp-Method`와 `Mcp-Name`을 보고 라우팅·차단·관측을 시작할 수 있어요. 서버는 그 대신 매 요청을 독립적으로 검증해야 해요.

## 버전 협상과 발견도 요청 단위로 이뤄진다

2026-07-28의 버전 모델에서는 별도 핸드셰이크로 협상하지 않아요. 모든 요청이 `_meta`에 프로토콜 버전을 선언하고 HTTP 요청이라면 같은 값을 `MCP-Protocol-Version` 헤더에도 담아요. 서버는 요청마다 지원 여부를 판단해 값이 서로 다르면 `HeaderMismatch`로 거절하고 지원하지 않는 버전이면 `UnsupportedProtocolVersionError`를 돌려줘요.

명세에도 이때 반환하는 오류 예시가 나와 있어요.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32022,
    "message": "Unsupported protocol version",
    "data": {
      "supported": ["2026-07-28", "2025-11-25"],
      "requested": "1900-01-01"
    }
  }
}
```

클라이언트는 공통으로 지원하는 버전을 골라 다시 시도할 수 있어요. 서버가 클라이언트별 “협상 결과”를 기억할 필요는 없어요. 같은 클라이언트가 다음 요청에 다른 버전을 보내도 그 요청만 보고 다시 판단하면 돼요. 매번 같은 정보를 보내는 중복은 있지만 재시도와 장애 분석을 요청 단위로 다룰 수 있죠. 작업이 어느 워커에 배정되든 처리할 수 있도록 필요한 입력과 식별자를 payload에 담는 큐 작업과 닮았어요.

`server/discover`는 서버가 지원하는 버전과 capability, identity를 알려줘요. 서버는 반드시 구현해야 하지만 클라이언트가 첫 요청으로 꼭 호출해야 하는 것은 아니에요. 임의의 RPC를 먼저 보낸 뒤 버전 오류가 나면 지원 목록을 보고 재시도할 수도 있어요.

명세의 요청 예시는 body parameter 없이 표준 `_meta`만 보내요.

```json
{
  "jsonrpc": "2.0",
  "id": "discover-1",
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "ExampleClient",
        "version": "1.0.0"
      },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

응답에는 `supportedVersions`, `capabilities`, 서버 정보, 선택적인 `instructions`, 캐시 관련 값이 들어갈 수 있어요.

```json
{
  "jsonrpc": "2.0",
  "id": "discover-1",
  "result": {
    "resultType": "complete",
    "supportedVersions": ["2026-07-28"],
    "capabilities": {
      "tools": {},
      "resources": {}
    },
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "ExampleServer",
        "version": "1.0.0"
      }
    },
    "instructions": "This server provides weather and resource utilities.",
    "ttlMs": 3600000,
    "cacheScope": "public"
  }
}
```

에이전트 시스템에는 에이전트 목록을 관리하는 레지스트리, 자연어 요청을 기능으로 연결하는 라우터, 실행할 수 있는 작업의 설명이 따로 흩어져 있어요. 원격 MCP 표면을 만들려면 이것들을 클라이언트가 먼저 확인할 수 있는 capability로 정리해야 해요.

## HTTP 헤더와 스트리밍의 역할

Streamable HTTP의 request metadata는 선택된 JSON-RPC body 필드를 HTTP 헤더에도 복사해요. 로드밸런서·게이트웨이·관측 도구가 body를 파싱하지 않고 요청을 다룰 수 있게 하려는 거예요. `Mcp-Method`는 모든 요청에 필요하고, `Mcp-Name`은 `tools/call`, `resources/read`, `prompts/get`에서 `params.name` 또는 `params.uri`를 담아요.

명세에 나온 `tools/call` 예시는 다음과 같아요.

```plain text
POST /mcp HTTP/1.1
Content-Type: application/json
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: get_weather

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": {
      "location": "Seattle, WA"
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "ExampleClient",
        "version": "1.0.0"
      },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

`get_weather` 자리에는 특정 일을 수행하는 도구 이름이 들어가요. 내 시스템이라면 PR 리뷰 생성, 그날 할 일 정리, 업무 로그 요약이 후보예요. 기능 이름이 body 안에만 있지 않으니 게이트웨이에서 PR 리뷰 생성 요청에 별도 rate limit을 적용하거나 특정 도구 호출을 별도 로그 파이프라인으로 보낼 수 있어요.

Streamable HTTP는 요청마다 단일 JSON 객체로 답할 수도 있고 그 요청에 묶인 SSE 스트림으로 진행 알림과 최종 응답을 보낼 수도 있어요. 2026-07-28에서는 예전처럼 별도 GET 스트림을 열어 세션으로 이어 붙이기보다, 요청 하나의 응답 스트림 안에서 진행 상황을 보내는 방식이 중심이에요.

긴 작업이라면 HTTP 연결의 타임아웃과 재시작, 클라이언트 이탈을 고려해야 해요. 공식 릴리스 후보 글에 따르면 Tasks extension에서는 서버가 `tools/call`에 task handle로 답하고 클라이언트가 `tasks/get`, `tasks/update`, `tasks/cancel`로 작업을 이어가요. 다만 Tasks는 core가 아닌 extension이라 모든 MCP 서버가 이 생명주기를 제공한다고 가정할 수는 없어요.

## 상태에는 다음 요청이 가져올 이름이 필요하다

stateless core를 “애플리케이션은 무상태여야 한다”는 뜻으로 읽으면 오해예요. 브라우저 자동화, 장기 분석, 큐 작업, 사용자 승인 대기에는 상태가 필요해요. 그 상태를 서버 내부 세션에 묻어 두지 않고 결과로 핸들을 돌려준 다음, 다음 호출에서 핸들을 다시 받는 방식이에요.

에이전트 시스템에 원격 MCP endpoint를 붙인다면 다음 상태는 세션에 숨기지 않아야 해요.

| 숨기면 안 되는 상태 | 왜 요청 밖으로 드러나야 하는가 | 가능한 핸들 |
| --- | --- | --- |
| 장기 실행 작업 | 워커 재시작·재시도·취소가 요청 연결보다 오래 산다 | `task_id` |
| 에이전트 실행 기록 | 실패 재실행과 감사 로그가 특정 실행 단위에 묶인다 | `run_id` |
| 외부 이벤트 처리 결과 | 웹훅은 중복 전달될 수 있어 멱등성이 필요하다 | `event_id` 또는 `delivery_id` |

이 이름은 예시일 뿐 명세가 강제하는 필드는 아니에요. “이 클라이언트의 세션 안에 진행 중인 작업 하나가 있다”가 아니라 “이 요청이 `task_id`에 해당하는 작업을 조회하거나 취소한다”는 계약이 필요해요. 여러 호출에 걸쳐 쓸 원격 브라우저 기능이 실제로 없다면 `browser_id`를 만들 필요도 없어요. 내부 개발을 편하게 하려고 쓰는 로컬 CLI 세션을 공개 MCP 도구로 노출할 이유도 약하고요.

명시적 핸들을 정했다면 멱등성과 취소가 실제로 어떻게 동작할지도 설계해야 해요. 네트워크 재시도로 같은 `tools/call`이 두 번 들어왔을 때 `task_id`를 두 개 만들면 비용이 두 배로 들고, 외부 부작용이 있는 작업이라면 사고로 이어질 수 있어요. `notifications/cancelled`나 Tasks extension의 cancel 흐름을 쓰더라도 내부 워커가 일을 취소 가능한 단위로 쪼개지 않았다면 겉으로만 취소되는 셈이에요.

trace context도 요청마다 이어 줘야 해요. 공식 릴리스 후보 글은 W3C Trace Context의 `traceparent`, `tracestate`, `baggage` key 이름이 `_meta`에서 문서화되었다고 설명해요. Slack 요청에서 시작한 작업이 에이전트 라우터와 큐, 모델 호출, 저장소 기록으로 이어진다면 trace도 한 줄로 따라갈 수 있어야 해요. 실제 span을 연결하는 일은 구현자가 해야 하고요.

## 내 시스템에서 공개할 기능의 경계

가장 먼저 닿는 곳은 에이전트 목록과 라우팅이에요. 지금 Slack 멘션과 slash command가 주된 입구라면 MCP endpoint는 외부 클라이언트가 호출하는 또 하나의 입구가 돼요. 내부 이름을 그대로 tool name으로 내보내기보다 사용자가 이해할 수 있는 기능 단위로 묶고, 입력 스키마와 실패 조건도 정리해야 해요.

실행 기록은 `run_id`나 `task_id`로 드러내는 편이 맞아요. 에이전트 실행은 시작해서 모델을 호출하고 결과를 저장하며 실패하면 다시 실행하는 흐름으로 이어져요. 명시적 핸들이 있으면 “아까 그 작업 어떻게 됐어?”라는 요청이 같은 서버 인스턴스에 도착하지 않아도 처리할 수 있고 실패 후 재시도에 쓴 입력과 결과도 감사 가능한 단위로 남길 수 있어요.

웹훅에는 멱등성이 필요해요. 외부 저장소나 협업 도구의 이벤트는 중복 전달되거나 순서가 바뀔 수 있거든요. MCP가 stateless라서 새로 생긴 문제는 아니지만 요청 단위 계약을 만들 때 `event_id`나 provider delivery id를 어디에 둘지 정해야 해요.

모든 모듈을 MCP 도구로 공개할 필요는 없어요. 저녁 회고에서 발행 후보를 만들거나, 운영 품질의 이상 신호를 월 단위로 살피거나, 내부 지식의 충돌을 판정하는 작업은 외부 클라이언트가 임의로 호출하는 도구보다 내부 배치·검증 흐름에 가까워요. capability로 노출하기 전에 권한, 입력 범위, 실행 비용, 결과 공개 범위를 정해야 해요. 사용자 장비의 인증 상태나 로컬 CLI 세션에 기대는 기능도 원격 MCP 서버 뒤에 놓으면 보안 모델이 바뀌어요.

1차 후보는 요청 하나로 입력과 출력을 정하고 실행 상태를 명시적 핸들로 관리할 수 있는 기능이에요. 그날 할 일 정리, PR 리뷰 생성, 업무 로그 요약이 여기에 가까워요. 내부 proactive 판단, 개인 이력 합성, 장기 운영 분석에는 권한 설계가 더 필요해요.

## 다음에 확인할 계약

먼저 `tools/call`로 공개할 기능의 capability 목록을 적어 봐야 해요. 각 기능의 이름과 입력 스키마, 권한, 예상 실행 시간, 실패했을 때 재시도할 수 있는지를 함께 정리해요. 이어서 `task_id`, `run_id`, `event_id` 가운데 무엇을 세션에 숨기지 않을 핸들로 쓸지 정해야 해요.

작게 실험한다면 PR 리뷰 생성 기능 하나를 `tools/call`로 감싸고, `Mcp-Method`, `Mcp-Name`, `MCP-Protocol-Version`을 실은 요청이 게이트웨이 로그에서 구분되는지 볼 수 있어요. 그다음 실행 기록을 `run_id`로 돌려주고 재조회·취소·재시도 중 하나를 붙여요. 그러면 요청과 핸들이 실제 운영에서 어떤 계약이 되는지 확인할 수 있어요.

:::toggle 출처

- https://modelcontextprotocol.io/specification/2026-07-28
- https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate

:::
