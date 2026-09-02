---
title: "CLI 래핑의 운영 문제와 ACP의 경계"
description: "ACP가 Coding Agent의 실행 경계를 어떻게 구조화하며, Slack 멀티 에이전트 시스템에 도입할 때 무엇을 검토해야 하는지 살펴본다."
pubDatetime: 2026-09-01T19:07:00+09:00
category: backend
---

Slack에서 Coding Agent CLI를 감싸는 구조는 쉽게 만들 수 있어요. 하지만 운영에 들어가면 실행 상태와 도구 호출, 권한 요청, 취소를 stdout만으로 구분하기 어렵죠. ACP는 이를 Client와 Agent 사이의 구조화된 사건으로 다뤄요. 다만 적용 범위와 protocol version을 따져 도입해야 해요.

## CLI를 감싸는 순간 생기는 운영 문제

Slack에서 코딩 에이전트를 호출하는 구조는 처음엔 단순해 보여요. 사용자가 명령을 보내면 백엔드가 작업 유형을 고르고, codex나 claude 같은 CLI를 child process로 실행해요. stdout의 텍스트를 모아 Slack에 돌려주면 끝이죠. 여기까지만 보면 “CLI provider를 하나 만들면 되는 일” 같아요.

운영이 붙는 순간 이야기가 달라져요. 에이전트가 프롬프트를 받았는지, 모델이 생각 중인지, 파일을 읽거나 명령 실행 권한을 기다리는지 알기 어려워요. 사용자가 취소한 작업이 어디까지 멈췄는지도 불분명하고요.

stdout 텍스트에는 “최종 답변”과 “중간 로그”, “도구 실행 상태”가 한데 섞여요. 에러도 모델 호출 실패, CLI 인증 문제, 도구 권한 거절, 사용자 취소로 나뉘지 않죠.

Agent Client Protocol, 줄여서 ACP가 필요한 곳이 바로 이 경계예요. ACP는 모델 API를 대체하는 규격이 아니에요. IDE, Slack 봇, 웹 UI 같은 user-facing Client가 Codex·Claude·Gemini류 Coding Agent를 구동할 때 쓰는 프로토콜이에요.

세션과 프롬프트, 도구 호출, 권한 요청, 취소를 JSON-RPC 메시지로 나눠요. 기존 CLI 래핑이 “프로세스를 실행하고 텍스트를 읽는 방식”이라면, ACP는 “Client와 Agent 사이의 사건을 구조화해 주고받는 방식”에 가까워요.

## ACP가 표준화하려는 경계

ACP는 code editor 또는 IDE와 coding agent 사이의 통신 표준이에요. 특정 에디터가 특정 에이전트에 묶이지 않게 하는 게 목표예요. 에디터와 에이전트가 상대별 API를 일일이 구현하지 않도록 공통 계약을 두자는 발상이죠. Language Server Protocol이 언어 서버 통합을 표준화한 것과 비슷한 역할이죠.

아키텍처에서 Client는 사용자 인터페이스와 작업 디렉터리, MCP 서버 설정, 권한 UX를 맡아요. Agent는 세션 안에서 계획을 세우고 도구를 호출하며 결과를 스트리밍해요. 로컬 에이전트는 보통 Client의 subprocess로 실행돼요. stdin/stdout 위에서 JSON-RPC로 통신하죠. 원격 에이전트에는 HTTP나 WebSocket도 상정하지만 remote agent 지원은 아직 진행 중이에요.

이 차이는 꽤 커요. 기존 CLI provider에서는 spawn()의 lifecycle이 에이전트 실행 lifecycle과 같아요. 프로세스가 살아 있으면 실행 중이고, 종료되면 끝난 것으로 봐요. ACP에서는 프로세스 생존 여부와 세션 상태가 나뉘어요.

하나의 연결에서 여러 concurrent session을 지원할 수 있어요. Agent는 session/update notification으로 UI가 이해할 사건을 계속 보내요. 중심이 “프로세스 출력”에서 “세션 이벤트”로 옮겨가는 셈이죠.

| 구분 | CLI 래핑 | ACP |
| --- | --- | --- |
| 통신 단위 | stdout/stderr 텍스트 | JSON-RPC request/notification |
| 실행 상태 | 프로세스 상태로 추정 | state_update로 명시 |
| 도구 호출 | 로그 파싱 또는 벤더별 포맷 | toolCallId 기반 update |
| 권한 UX | 별도 임시 규약 필요 | session/request_permission |
| 취소 | 프로세스 kill 중심 | session/cancel과 idle stop reason |

## 프롬프트 응답은 최종 답변이 아니다

ACP v2에서 먼저 살펴볼 변화는 session/prompt의 의미예요. prompt lifecycle은 접수와 완료를 명확히 나눠요. Client가 session/prompt를 보내면 Agent는 프롬프트를 “받아들였을 때” 빈 result를 돌려줘요. 이 응답은 작업 완료가 아니에요. 실제 진행과 출력, 완료는 이후 session/update notification으로 오거든요.

요청은 이렇게 시작해요.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123def456",
    "prompt": [
      {
        "type": "text",
        "text": "Can you analyze this code for potential issues?"
      },
      {
        "type": "resource",
        "resource": {
          "uri": "file:///home/user/project/main.py",
          "mimeType": "text/x-python",
          "text": "def process_data(items):\n    for item in items:\n        print(item)"
        }
      }
    ]
  }
}
```

Agent가 이 프롬프트를 접수하면 다음과 같이 빈 result를 보내요.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {}
}
```

이 응답만 보고 작업이 끝났다고 판단하면 안 돼요. Agent는 이후 session/update로 사용자 메시지가 세션 기록에 들어간 위치를 알려요. foreground work가 시작되면 state_update의 running을 보내죠. 작업이 끝나면 idle을 보내고, foreground work가 끝나는 전환이라면 stopReason도 포함해요.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "state_update",
      "state": "running"
    }
  }
}
```

완료 시점은 다음과 같이 표현해요.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "state_update",
      "state": "idle",
      "stopReason": "end_turn"
    }
  }
}
```

이 구조는 Slack 기반 시스템에서도 중요해요. Slack slash command는 빠르게 ack해야 하지만 실제 작업은 뒤에서 오래 걸릴 수 있어요. session/prompt 접수와 state_update: running/idle을 나누면 상태를 안정적으로 표시할 수 있죠. 운영 대시보드나 메시지에 “요청은 접수됐지만 아직 실행 중”이라고 반영할 수 있어요.

## 도구 호출은 로그가 아니라 upsert 이벤트다

코딩 에이전트에서 가장 애매한 부분은 도구 호출이에요. 파일 읽기와 검색, 명령 실행, 수정, 삭제, 외부 fetch가 stdout 로그로만 남으면 UI와 audit log가 취약해져요. ACP v2는 이를 tool_call_update와 tool_call_content_chunk로 나눠요.

LLM이 도구 호출을 요청하면 Agent는 session/update notification으로 tool_call_update를 보내요. 이 이벤트는 toolCallId를 기준으로 upsert돼요. 같은 toolCallId에서 빠진 필드는 이전 값을 유지하고, null은 값을 지워요. 구체 값은 기존 값을 대체하고 chunk는 이어 붙여요.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call_001",
      "title": "Reading configuration file",
      "kind": "read",
      "status": "pending"
    }
  }
}
```

도구가 진행되면 바뀐 필드만 다시 보내요.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call_001",
      "status": "in_progress",
      "content": [
        {
          "type": "content",
          "content": {
            "type": "text",
            "text": "Found 3 configuration files..."
          }
        }
      ]
    }
  }
}
```

tool kind에는 read, edit, delete, move, search, execute, think, fetch, other가 있어요. 이 정보만으로도 Client는 벤더별 로그 파서 없이 도구 상태 UI를 만들 수 있어요. “파일을 읽는 중”, “명령 실행 승인 대기”, “수정 결과 확인”처럼 보여줄 수 있죠.

audit log에서도 toolCallId, kind, status, locations, rawInput, rawOutput 같은 필드는 stdout보다 훨씬 다루기 쉬워요.

중요한 점은 tool call update가 세션 상태를 바꾸지 않는다는 거예요. Agent가 idle을 보고한 동안에도 tool call update가 올 수 있어요. 이 이벤트 자체는 상태를 바꾸지 않고요. foreground 상태는 state_update가, 도구 표시와 진행 로그는 tool call 이벤트가 맡아요. 운영 화면에서 꽤 실용적인 구분이에요.

## 권한 요청과 사용자 입력도 프로토콜 안에 있다

코딩 에이전트가 파일을 수정하거나 명령을 실행하려 하면 Client는 사용자에게 허용 여부를 물어야 해요. 기존 구조에서는 Slack 버튼과 임시 DB row, CLI stdin 응답을 제각각 붙이기 쉬워요. ACP는 이 과정을 session/request_permission으로 프로토콜 안에 넣었어요.

파일 수정 승인 요청은 이렇게 생겼어요.

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess_abc123def456",
    "title": "Approve file edit?",
    "description": "Allow the agent to edit src/main.rs?",
    "subject": {
      "type": "tool_call",
      "toolCall": {
        "toolCallId": "call_001"
      }
    },
    "options": [
      {
        "optionId": "allow-once",
        "name": "Allow once",
        "kind": "allow_once"
      },
      {
        "optionId": "reject-once",
        "name": "Reject",
        "kind": "reject_once"
      }
    ]
  }
}
```

Client는 사용자가 고른 값을 result로 돌려줘요.

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "outcome": {
      "outcome": "selected",
      "optionId": "allow-once"
    }
  }
}
```

취소에도 별도의 의미가 있어요. 현재 active work가 취소되면 Client는 permission request에 cancelled outcome으로 응답해야 해요. Agent가 이해하지 못하는 outcome을 approval로 취급해서도 안 돼요. 알 수 없는 응답을 허용으로 해석하면 권한 UX가 보안 장치가 아니라 장식이 되니까요.

ACP v2에는 elicitation/create도 있어요. Agent가 Client를 통해 사용자에게 구조화된 정보를 요청하는 기능이에요. form mode는 민감하지 않은 정보를 제한된 JSON Schema로 수집해요. URL mode는 OAuth처럼 민감하거나 외부 hosted workflow가 필요한 작업을 out-of-band로 처리해요.

form mode로 password, API key, access token, refresh token, private key 같은 credential을 요청하면 안 돼요. URL mode에서도 Agent가 URL로 얻은 token을 ACP나 모델 context로 되돌려 보내면 안 돼요.

## v2는 매력적이지만 아직 조심해야 한다

ACP를 바로 표준 경계로 삼고 싶어도 v2는 조심해서 봐야 해요. v2 protocol surface는 전체가 draft로 표시돼 있어요. version negotiation과 feature flag 뒤에 두라고 설명하죠.

안정 baseline은 schema/v2/schema.json이에요. 불안정한 draft feature는 schema/v2/schema.unstable.json에 layered돼요. protocolVersion: 2를 협상해도 unstable feature가 자동으로 켜지지는 않아요.

현재 stable ACP protocol version은 1이에요. v2 기능을 전제로 Client를 만들면 기존 Agent와 연결되지 않을 수 있어요. v1만 보는 Client는 v2의 prompt lifecycle과 upsert update를 제대로 활용하지 못해요. state_update와 새 tool call streaming도 마찬가지예요.

현실적으로는 v1/v2를 side-by-side로 두는 편이 맞아요. initialize에서 협상한 protocolVersion과 capabilities를 기준으로 분기해야 해요.

### 코드 편집기 밖에서는 이점이 작아진다

적용 범위에도 한계가 있어요. ACP는 “모델 호출 API”도, 일반 목적의 모든 에이전트 orchestration 표준도 아니에요. ACP의 중심은 code editor와 coding agent예요. Slack 봇이나 웹 UI도 Client가 될 수 있지만, 예시와 설계 철학은 코딩 작업의 UX에 맞춰져 있어요.

파일 위치와 display terminal, MCP 서버, 권한 요청, 코드 diff 표시가 핵심 요소예요. 단순 Q&A 봇이나 데이터 요약 파이프라인에 억지로 붙이면 구현 부담만 커질 수 있어요.

벤더 CLI 하나를 내부 배치에서 실행하고 최종 텍스트만 저장한다면 ACP는 과해요. 권한 UX가 없고 도구 호출을 사용자에게 보여줄 필요가 없다면 이점이 작아요. session replay나 cancel도 운영하지 않는다면 JSON-RPC Client 구축 비용이 더 클 수 있죠.

여러 coding agent를 같은 UX에서 돌리고 실행 상태와 audit log를 제대로 남겨야 한다면 검토할 가치가 있어요.

## 내 시스템에 대입하면 닿는 모듈들

TypeScript·NestJS 기반 Slack 멀티 에이전트 시스템에 ACP를 대입하면 model-router와 ai-cli-env가 먼저 맞닿아요. 지금 model-router는 AgentType에 따라 provider를 골라요. ai-cli-env는 CLI 실행 환경을 안전하게 구성하는 역할에 가까워요.

ACP를 도입하면 provider의 추상화 단위를 “벤더별 CLI spawn”에서 “ACP Agent connection”으로 올릴 수 있어요. CodexCliProvider나 ClaudeCliProvider는 stdout parser 대신 initialize/session/prompt/update/cancel을 다루는 adapter가 돼요.

### 실행 기록을 lifecycle 단위로 채운다

agent-run도 직접 영향을 받아요. 현재 agent-run이 begin → run → finish와 EvidenceRecord를 기록한다면, ACP 이벤트로 그 사이를 더 촘촘히 채울 수 있어요. prompt accepted, state_update: running, tool_call_update를 실행 lifecycle에 매핑해요. session/request_permission, state_update: idle, stopReason: cancelled도 포함하고요.

그러면 “실패했다”에서 끝나지 않아요. “권한 대기 중 취소됨”, “도구 실행 중 실패”, “프롬프트 접수 전 실패”처럼 나눌 수 있어 장애 추적이 쉬워져요.

### 세션과 권한은 저장소가 아니라 UX 문제다

local-sessions도 중요해요. ACP는 session/new, session/resume, session/list, session/close 같은 session lifecycle을 전제로 해요. Slack thread와 ACP session을 연결하는 방식부터 정해야 해요. 한 Slack 사용자에게 여러 concurrent session을 허용할지, session replay를 어디까지 저장할지도 결정해야 하고요.

이는 단순한 저장소 문제가 아니라 UX 문제예요. 사용자가 /review-pr을 다시 눌렀을 때 이전 맥락을 이을지 새 세션으로 격리할지에 따라 결과가 달라지거든요.

slack 모듈에는 권한 UX가 연결돼요. session/request_permission은 Slack approve/reject 버튼으로 자연스럽게 옮길 수 있어요. 다만 버튼 클릭을 ACP Client 응답으로 돌려줘야 해요. permission request id와 Slack interaction payload를 안정적으로 묶어야 하죠. 사용자 취소나 Slack 메시지 만료 시 cancelled 또는 reject 계열 outcome을 어떻게 보낼지도 정해야 해요.

### 코딩 에이전트부터 옮기는 편이 맞다

실제 에이전트 중에는 agent/code-reviewer, agent/be, agent/be-fix, agent/be-test, agent/be-schema, agent/be-sre의 우선순위가 높아요. 코드 diff와 파일 읽기, 테스트 실행, 스키마 변경 제안, 스택트레이스 분석을 다루기 때문이에요. 이런 작업은 tool call과 audit log의 가치가 커요.

agent/vacation처럼 자연어 파라미터 추출만 필요한 에이전트는 ACP의 장점이 작아요. 한 번에 모두 옮기기보다 도구 호출과 권한 요청이 많은 코딩 에이전트부터 실험하는 편이 맞아요.

## 도입 전에 확인할 것

먼저 실제 지원 현황부터 확인해야 해요. 공식 문서와 레포는 프로토콜의 형태를 보여줄 뿐이에요. 사용하는 Agent CLI가 지원하는 protocol version과 capability는 별개거든요. initialize에서 v1/v2를 어떻게 협상하는지 직접 캡처해야 해요. session/prompt 뒤에 state_update가 규격대로 오는지, tool call update가 얼마나 상세한지도 봐야 해요.

Slack Client의 최소 구현 범위도 정해야 해요. 처음부터 완전한 ACP Client를 만들 필요는 없어요. initialize, session/new, session/prompt, session/update만 먼저 다뤄도 돼요. session/request_permission과 session/cancel까지 좁게 잡아 agent-run에 이벤트를 적재하는 spike가 적당해요.

이 실험에서 stdout parser보다 관측성이 좋아진다는 증거가 나오면, 그때 model-router의 provider 경계를 ACP 중심으로 다시 설계할 수 있어요.

ACP의 가치는 프로토콜 자체보다 경계를 명확히 만드는 데 있어요. 여러 Coding Agent를 같은 UX에서 운영하며 실행 상태와 권한, 취소, audit log를 일관되게 다룰 때 유용해요. 다만 v2의 draft 상태와 Agent별 지원 차이는 고려해야 해요. 전면 전환보다는 도구 호출과 권한 요청이 많은 에이전트에서 작은 spike로 검증하는 편이 맞아요.

## 참고한 공식 출처

- https://agentclientprotocol.com/get-started/introduction
- https://agentclientprotocol.com/get-started/architecture.md
- https://agentclientprotocol.com/protocol/v2/overview.md
- https://agentclientprotocol.com/protocol/v2/prompt-lifecycle.md
- https://agentclientprotocol.com/protocol/v2/migration.md
- https://agentclientprotocol.com/protocol/v2/tool-calls.md
- https://agentclientprotocol.com/protocol/v2/elicitation.md
- https://github.com/agentclientprotocol/agent-client-protocol
