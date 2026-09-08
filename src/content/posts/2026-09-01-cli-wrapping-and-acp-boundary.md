---
title: "stdout만으로는 실행 상태도 권한도 취소도 구분되지 않는다"
description: "Coding Agent CLI를 stdout으로 감싸면 실행 상태와 도구 호출, 권한 요청, 취소가 한 덩어리로 섞인다. ACP가 그 경계를 어떤 사건으로 갈라놓는지 읽고, Slack 멀티 에이전트 시스템에 붙이기 전에 무엇부터 캡처할지 정리한다."
pubDatetime: 2026-09-01T19:07:00+09:00
category: backend
---

Slack에서 Coding Agent CLI를 감싸는 구조는 쉽게 만들 수 있어요. 하지만 운영에 들어가면 실행 상태와 도구 호출, 권한 요청, 취소를 stdout만으로 구분하기 어렵죠. Agent Client Protocol, 줄여서 ACP는 이를 Client와 Agent 사이의 구조화된 사건으로 다뤄요. 그렇다고 곧바로 표준 경계로 삼을 수 있는 건 아니어서, 적용 범위와 protocol version을 먼저 따져야 해요. 다만 아래 글은 공식 문서와 스키마를 읽고 제 시스템에 비춰 본 정리이지 ACP Client를 붙여 돌려본 기록은 아니에요.

## CLI를 감싸는 순간 생기는 운영 문제

Slack에서 코딩 에이전트를 호출하는 구조는 처음엔 단순해 보여요. 사용자가 명령을 보내면 백엔드가 작업 유형을 고르고, codex나 claude 같은 CLI를 child process로 실행해요. stdout의 텍스트를 모아 Slack에 돌려주면 끝이죠. 여기까지만 보면 “CLI provider를 하나 만들면 되는 일” 같아요.

운영이 붙는 순간 이야기가 달라져요. 에이전트가 프롬프트를 받았는지, 모델이 생각 중인지, 파일을 읽거나 명령 실행 권한을 기다리는지 알기 어려워요. 사용자가 취소한 작업이 어디까지 멈췄는지도 불분명하고요.

stdout 텍스트에는 “최종 답변”과 “중간 로그”, “도구 실행 상태”가 한데 섞여요. 에러도 모델 호출 실패, CLI 인증 문제, 도구 권한 거절, 사용자 취소로 나뉘지 않죠.

ACP가 필요한 곳이 바로 이 경계예요. ACP는 모델 API를 대체하는 규격이 아니에요. IDE, Slack 봇, 웹 UI 같은 user-facing Client가 Codex·Claude·Gemini류 Coding Agent를 구동할 때 쓰는 프로토콜이에요.

세션과 프롬프트, 도구 호출, 권한 요청, 취소를 JSON-RPC 메시지로 나눠요. JSON-RPC는 method와 params를 담은 JSON 한 덩어리로 요청과 응답, 그리고 응답이 따라오지 않는 알림(notification)을 주고받는 규격이고, ACP는 그 위에 얹혀 있어요. 기존 CLI 래핑이 “프로세스를 실행하고 텍스트를 읽는 방식”이라면, ACP는 “Client와 Agent 사이의 사건을 구조화해 주고받는 방식”에 가까워요.

## ACP가 그은 선은 에디터와 에이전트 사이다

ACP는 code editor 또는 IDE와 coding agent 사이의 통신 표준이에요. 에디터와 에이전트가 상대별 API를 일일이 구현하는 대신 공통 계약을 두어, 특정 에디터가 특정 에이전트에 묶이지 않게 하는 게 목표예요. Language Server Protocol이 언어 서버 통합을 표준화한 것과 비슷한 역할이죠.

이 구조에서 눈여겨볼 건 역할이 완전히 갈라진다는 점이에요. Client는 사용자 인터페이스와 작업 디렉터리, MCP 서버 설정, 권한 UX를 맡아요. Agent는 세션 안에서 계획을 세우고 도구를 호출하며 결과를 스트리밍해요. 로컬 에이전트는 보통 Client의 subprocess로 실행돼 stdin/stdout 위에서 JSON-RPC로 통신하죠. 원격 에이전트에는 HTTP나 WebSocket도 상정하지만 remote agent 지원은 아직 진행 중이에요.

Client가 맡는다는 MCP 서버 설정의 MCP는 Model Context Protocol을 줄인 말인데, ACP와는 잇는 양쪽이 달라요. ACP가 에디터나 Slack 봇 같은 Client와 Agent를 잇는다면, MCP는 그 Agent를 바깥 도구 서버에 잇죠. [Architecture](https://agentclientprotocol.com/get-started/architecture.md) 문서도 Client가 사용자에게 설정된 MCP 서버 정보를 프롬프트와 함께 넘겨 Agent가 그 서버에 직접 연결하게 한다고 설명하는 선까지만 다루고, 두 프로토콜의 관계를 그 이상으로 규정하지는 않아요.

Client와 Agent로 역할이 갈린다는 이 설계가 생각보다 큰 이유는, 기존 CLI provider에서 spawn()의 lifecycle이 곧 에이전트 실행 lifecycle이라 프로세스가 살아 있으면 실행 중, 종료되면 끝난 것으로 봐야 했기 때문이에요. ACP에서는 프로세스 생존 여부와 세션 상태가 갈라지니, 프로세스가 떠 있어도 세션은 idle일 수 있고 그 반대도 성립하죠.

ACP에서는 연결 하나가 여러 concurrent session을 동시에 지원할 수 있어요. Agent는 session/update notification으로 UI가 이해할 사건을 계속 보내요. 중심이 “프로세스 출력”에서 “세션 이벤트”로 옮겨가는 셈이죠.

아래 표는 CLI를 감쌀 때 부딪히는 운영 관심사를 왼쪽에 두고, 같은 관심사를 ACP가 무엇으로 받아내는지 오른쪽에 나란히 놓은 거예요. 오른쪽 칸의 이름들은 지금 낯설어도 괜찮아요. 프롬프트 응답과 도구 호출, 권한 요청을 다루는 다음 세 절에서 하나씩 풀어요.

| 구분 | CLI 래핑 | ACP |
| --- | --- | --- |
| 통신 단위 | stdout/stderr 텍스트 | JSON-RPC request/notification |
| 실행 상태 | 프로세스 상태로 추정 | state_update로 명시 |
| 도구 호출 | 로그 파싱 또는 벤더별 포맷 | toolCallId 기반 update |
| 권한 UX | 별도 임시 규약 필요 | session/request_permission |
| 취소 | 프로세스 kill 중심 | session/cancel과 idle stop reason |

## 프롬프트 응답은 최종 답변이 아니다

session/prompt의 응답을 작업 완료로 읽으면 상태 표시가 통째로 어긋나요. ACP v2의 prompt lifecycle이 접수와 완료를 아예 다른 사건으로 갈라놓기 때문이에요. Client가 session/prompt를 보내면 Agent는 프롬프트를 “받아들였을 때” 빈 result를 돌려줘요. 이 응답은 작업 완료가 아니에요. 실제 진행과 출력, 완료는 이후 session/update notification으로 오거든요.

그 전에 예시마다 붙어 다니는 sessionId부터 짚고 갈게요. 이 값은 프롬프트를 보내기 전 두 단계에서 만들어져요. 먼저 initialize로 서로 지원하는 protocol version과 capability를 맞추고, 그다음 session/new로 세션을 열면 응답에 sessionId가 담겨 와요. 공식 문서의 [Initialization](https://agentclientprotocol.com/protocol/v2/initialization.md)과 [Session Setup](https://agentclientprotocol.com/protocol/v2/session-setup.md)에 실린 예시를 순서대로 이어 붙이면 이런 모양이에요. 위에서부터 initialize 요청, 그 응답, session/new 요청, 그 응답이에요.

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": 2,
    "capabilities": {},
    "info": {
      "name": "my-client",
      "title": "My Client",
      "version": "1.0.0"
    }
  }
}

{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": 2,
    "capabilities": {
      "session": {
        "prompt": {
          "image": {},
          "audio": {},
          "embeddedContext": {}
        },
        "mcp": {
          "stdio": {},
          "http": {}
        }
      }
    },
    "info": {
      "name": "my-agent",
      "title": "My Agent",
      "version": "1.0.0"
    },
    "authMethods": []
  }
}

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/new",
  "params": {
    "cwd": "/home/user/project",
    "mcpServers": [
      {
        "type": "stdio",
        "name": "workspace-tools",
        "command": "/path/to/mcp-server",
        "args": ["--stdio"],
        "env": []
      }
    ]
  }
}

{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "sess_abc123def456"
  }
}
```

initialize 응답의 protocolVersion이 Client가 보낸 값과 같으면 그 버전으로 진행하고, Agent가 자기 최신 버전을 대신 돌려주면 Client가 그 버전으로 내려갈지 연결을 끊을지 정해요. session/new의 cwd는 Agent의 작업 디렉터리이자 상대 경로의 기준점이고, mcpServers는 Agent가 붙을 MCP 서버 설정이에요. 아래 예시들에 나오는 sessionId는 모두 이 session/new 응답에서 받은 값이라고 보면 돼요.

이제 프롬프트 요청은 이렇게 시작해요.

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

prompt 배열의 두 번째 항목인 resource는 Client가 파일 내용을 프롬프트에 통째로 실어 보내는 자리예요. uri는 그 자료를 가리키는 주소, mimeType은 어떤 종류의 내용인지, text는 실제 본문이고요. 공식 문서는 이 embedded resource를 “@-멘션으로 파일을 참조할 때처럼 프롬프트에 맥락을 넣는 선호되는 방법”으로 설명하는데, Agent가 직접 접근하지 못하는 곳의 내용도 Client가 대신 실어 보낼 수 있기 때문이에요([Content Blocks](https://agentclientprotocol.com/protocol/v2/content.md)).

Agent가 이 프롬프트를 접수하면 다음과 같이 빈 result를 보내요.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {}
}
```

이 응답만 보고 작업이 끝났다고 판단하면 안 돼요. Agent는 이후 session/update로 사용자 메시지가 세션 기록에 들어간 위치를 알려요. 프롬프트 하나가 시작하거나 이어받는 그 세션의 주 작업, 그러니까 foreground work가 시작되면 state_update의 running을 보내죠. 작업이 끝나면 idle을 보내고, foreground work가 끝나는 전환이라면 stopReason도 포함해요.

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

코딩 에이전트에서 가장 애매한 부분은 도구 호출이에요. 파일 읽기와 검색, 명령 실행, 수정, 삭제, 외부 fetch가 stdout 로그로만 남으면 UI와 audit log가 취약해져요. ACP v2는 이를 tool_call_update와 tool_call_content_chunk로 나눠요. tool_call_content_chunk는 도구가 뱉어내는 출력 한 조각을 그 도구 호출의 content 뒤에 이어 붙이는 이벤트라, 긴 출력을 다 모을 때까지 기다리지 않고 도착하는 대로 흘려보낼 수 있어요.

LLM이 도구 호출을 요청하면 Agent는 session/update notification으로 tool_call_update를 보내요. 이 이벤트는 toolCallId를 기준으로 upsert돼요. 같은 toolCallId에서 빠진 필드는 이전 값을 유지하고, null은 값을 지워요. 구체 값은 기존 값을 대체하고 chunk는 이어 붙여요([Tool Calls](https://agentclientprotocol.com/protocol/v2/tool-calls.md)).

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

content 안에 content가 또 들어 있는 건 층이 둘이라서예요. 바깥의 `"type": "content"`는 이 항목이 도구가 만들어 낸 표시용 내용이라는 표시이고, 그 안의 객체가 실제로 화면에 보여줄 text 블록이에요.

tool kind에는 read, edit, delete, move, search, execute, think, fetch, other가 있어요([Tool Calls](https://agentclientprotocol.com/protocol/v2/tool-calls.md)). 이 정보만으로도 Client는 벤더별 로그 파서 없이 도구 상태 UI를 만들 수 있어요. “파일을 읽는 중”, “명령 실행 승인 대기”, “수정 결과 확인”처럼 보여줄 수 있죠.

audit log에서도 toolCallId, kind, status, locations, rawInput, rawOutput 같은 필드는 stdout보다 훨씬 다루기 쉬워요.

중요한 점은 tool call update가 세션 상태를 바꾸지 않는다는 거예요. Agent가 idle을 보고한 동안에도 tool call update는 올 수 있어요. foreground 상태는 state_update가, 도구 표시와 진행 로그는 tool call 이벤트가 맡아요. 운영 화면에서 꽤 실용적인 구분이에요.

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

취소에도 별도의 의미가 있어서, 현재 active work가 취소되면 Client는 permission request에 cancelled outcome으로 응답해야 해요. Agent가 이해하지 못하는 outcome을 approval로 취급해서도 안 돼요([Tool Calls](https://agentclientprotocol.com/protocol/v2/tool-calls.md)의 Requesting Permission 절). 알 수 없는 응답을 허용으로 해석하면 권한 UX가 보안 장치가 아니라 장식이 되니까요.

ACP v2에는 elicitation/create도 있어요. Agent가 Client를 통해 사용자에게 구조화된 정보를 요청하는 기능이에요. form mode는 민감하지 않은 정보를 제한된 JSON Schema로 수집해요. 제 시스템의 slack 모듈에서 지금 버튼과 모달로 흩어져 있는 되묻기가 form mode에 대응하죠. URL mode는 OAuth처럼 민감하거나 외부 hosted workflow가 필요한 작업을 out-of-band로, 그러니까 ACP 메시지 바깥의 브라우저 같은 별도 통로로 처리하니, CLI 인증 갱신처럼 토큰이 오가는 흐름은 이쪽으로 밀어야 해요.

form mode로 password, API key, access token, refresh token, private key 같은 credential을 요청하면 안 돼요. URL mode에서도 Agent가 URL로 얻은 token을 ACP나 모델 context로 되돌려 보내면 안 돼요([Elicitation](https://agentclientprotocol.com/protocol/v2/elicitation.md)).

## v2는 매력적이지만 아직 조심해야 한다

ACP를 바로 표준 경계로 삼고 싶어도 v2는 조심해서 봐야 해요. v2 protocol surface는 전체가 draft로 표시돼 있어요. version negotiation과 feature flag 뒤에 두라고 설명하죠([Migrating from v1](https://agentclientprotocol.com/protocol/v2/migration.md)).

방금 말한 draft 표시와 아래 두 문단이 말할 baseline, 그리고 stable version은 서로 어긋나 보이지만 층위가 달라요. draft라는 딱지는 v2라는 표면 전체에 붙고, 안정 baseline과 불안정한 feature는 그 표면 안에서 별개 스키마 파일로 갈리며, stable version 1은 initialize에서 협상하는 wire protocol의 번호라 셋이 동시에 참일 수 있어요.

안정 baseline은 [schema/v2/schema.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v2/schema.json)이고, 불안정한 draft feature는 그 위에 [schema/v2/schema.unstable.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v2/schema.unstable.json)으로 layered되는 구조예요. protocolVersion: 2를 협상해도 unstable feature가 자동으로 켜지지는 않아요.

현재 stable ACP protocol version은 1이에요([레포 README](https://github.com/agentclientprotocol/agent-client-protocol)). v2 기능을 전제로 Client를 만들면 기존 Agent와 연결되지 않을 수 있어요. v1만 보는 Client는 v2의 prompt lifecycle과 upsert update를 제대로 활용하지 못해요. state_update와 새 tool call streaming도 마찬가지예요.

현실적으로는 v1/v2를 side-by-side로 두는 편이 맞아요. initialize에서 협상한 protocolVersion과 capabilities를 기준으로 분기해야 해요.

### 코드 편집기 밖에서는 이점이 작아진다

적용 범위에도 한계가 있어요. ACP는 “모델 호출 API”도, 일반 목적의 모든 에이전트 orchestration 표준도 아니에요. ACP의 중심은 code editor와 coding agent예요. Slack 봇이나 웹 UI도 Client가 될 수 있지만, 예시와 설계 철학은 코딩 작업의 UX에 맞춰져 있어요.

파일 위치와 display terminal, MCP 서버, 권한 요청, 코드 diff 표시가 핵심 요소예요. 단순 Q&A 봇이나 데이터 요약 파이프라인에 억지로 붙이면 구현 부담만 커질 수 있어요.

벤더 CLI 하나를 내부 배치에서 실행하고 최종 텍스트만 저장한다면 ACP는 과해요. 권한 UX가 없고 도구 호출을 사용자에게 보여줄 필요가 없다면 이점이 작아요. session replay나 cancel도 운영하지 않는다면 JSON-RPC Client 구축 비용이 더 클 수 있죠.

여러 coding agent를 같은 UX에서 돌리고 실행 상태와 audit log를 제대로 남겨야 한다면 검토할 가치가 있어요.

## 내 시스템에 대입하면 닿는 모듈들

TypeScript·NestJS 기반 Slack 멀티 에이전트 시스템에 ACP를 대입하면 model-router와 ai-cli-env가 먼저 맞닿아요. 지금 model-router는 AgentType에 따라 provider를 골라요. ai-cli-env는 CLI 실행 환경을 안전하게 구성하는 역할에 가까워요.

문서 기준으로는 ACP를 도입하면 provider의 추상화 단위를 “벤더별 CLI spawn”에서 “ACP Agent connection”으로 올릴 수 있어요. 다만 아직 붙여본 적이 없어 실제로 얼마나 얇아지는지는 확인하지 못했어요. CodexCliProvider나 ClaudeCliProvider는 stdout parser 대신 initialize/session/prompt/update/cancel을 다루는 adapter가 돼요.

### 실행 기록을 lifecycle 단위로 채운다

agent-run도 직접 영향을 받아요. 현재 agent-run이 begin → run → finish 단계와 그 실행의 근거를 함께 남기는 EvidenceRecord를 기록한다면, ACP 이벤트로 그 사이를 더 촘촘히 채울 수 있어요. prompt accepted, state_update: running, tool_call_update, session/request_permission, state_update: idle, stopReason: cancelled를 실행 lifecycle에 매핑하는 거죠.

그러면 “실패했다”에서 끝나지 않아요. “권한 대기 중 취소됨”, “도구 실행 중 실패”, “프롬프트 접수 전 실패”처럼 나눌 수 있어 장애 추적이 쉬워져요.

### 세션과 권한은 저장소가 아니라 UX 문제다

local-sessions는 로컬에서 돌아가고 있는 claude·codex CLI 세션을 목록으로 붙들어 두는 제 시스템의 모듈이에요. 이 모듈이 중요해지는 지점은, ACP가 session/new, session/resume, session/list, session/close 같은 session lifecycle을 아예 전제로 깔고 들어간다는 데 있어요. 그래서 붙이기 전에 결정할 항목이 먼저 쌓여요.

- Slack thread와 ACP session을 어떤 규칙으로 연결할지
- 한 Slack 사용자에게 여러 concurrent session을 허용할지
- session replay를 어디까지 저장할지

이는 단순한 저장소 문제가 아니라 UX 문제예요. 사용자가 /review-pr을 다시 눌렀을 때 이전 맥락을 이을지 새 세션으로 격리할지에 따라 결과가 달라지거든요.

제 시스템의 slack 모듈에는 권한 UX가 연결돼요. session/request_permission은 Slack approve/reject 버튼으로 자연스럽게 옮길 수 있어요. 다만 버튼 클릭을 ACP Client 응답으로 돌려주려면 permission request id와 Slack interaction payload를 안정적으로 묶어야 하죠. 사용자 취소나 Slack 메시지 만료 시 cancelled 또는 reject 계열 outcome을 어떻게 보낼지도 정해야 해요.

### 코딩 에이전트부터 옮기는 편이 맞다

실제 에이전트 중에는 agent/code-reviewer, agent/be, agent/be-fix, agent/be-test, agent/be-schema, agent/be-sre의 우선순위가 높아요. 코드 diff와 파일 읽기, 테스트 실행, 스키마 변경 제안, 스택트레이스 분석을 다루기 때문이에요. 이런 작업은 tool call과 audit log의 가치가 커요.

agent/vacation처럼 자연어 파라미터 추출만 필요한 에이전트는 ACP의 장점이 작아요. 한 번에 모두 옮기기보다 도구 호출과 권한 요청이 많은 코딩 에이전트부터 실험하는 편이 맞아요.

## 붙이기 전에 initialize부터 캡처해야 한다

먼저 실제 지원 현황부터 확인해야 해요. 공식 문서와 레포는 프로토콜의 형태를 보여줄 뿐이고, 제가 실제로 돌리는 Agent CLI가 지원하는 protocol version과 capability는 그와 별개거든요.

그래서 실험 대상부터 특정했어요. 2026년 9월 8일 기준으로 제 맥에 설치된 CLI 세 개의 `--help`를 훑어보니 ACP 모드를 노출하는 건 gemini 하나였어요. `gemini --version`은 0.46.0이고, 도움말에 `--acp`가 “Starts the agent in ACP mode”로 적혀 있어요. `--experimental-acp`는 같은 뜻의 deprecated 별칭이고요. 반면 codex-cli 0.153.4와 Claude Code 2.1.263은 `--help` 출력 어디에도 ACP 관련 플래그가 없었어요. 세 버전 모두 `--version`으로 확인한 값이에요. 도움말에 없다는 게 지원이 없다는 증명은 아니지만, 지금 당장 캡처를 걸 수 있는 명령은 `gemini --acp` 하나라는 뜻이에요. 정작 제 시스템이 운영에서 돌리는 provider는 codex 쪽이라, 첫 캡처는 운영 경로가 아니라 gemini를 대상으로 한 별도 실험이 돼요. 이 조건에서 볼 것은 세 가지예요.

- initialize에서 v1/v2를 어떻게 협상하는지
- session/prompt 뒤에 state_update가 규격대로 오는지
- tool call update가 얼마나 상세한지

Slack Client의 최소 구현 범위도 정해야 해요. 처음부터 완전한 ACP Client를 만들 필요는 없어요. initialize, session/new, session/prompt, session/update만 먼저 다뤄도 돼요. session/request_permission과 session/cancel까지 좁게 잡아 agent-run에 이벤트를 적재하는 spike, 그러니까 결론을 내는 데 필요한 만큼만 만들고 버리는 시험 구현이 적당해요.

이 spike에서 정상 경로만 보면 앞에서 짚은 경계가 그대로 남아요. 그래서 확인 항목을 네 가지 더 붙였어요.

- 실행 중 취소했을 때, 열려 있던 permission request에 cancelled outcome이 실제로 돌아가는가
- 연결이 끊긴 뒤 session/resume으로 다시 붙였을 때 세션이 이어지는가, 그리고 replay를 어디까지 받는가
- 권한 요청이 만료됐을 때, 즉 Slack 메시지가 만료돼 버튼을 누를 수 없게 됐을 때 어떤 outcome으로 닫히는가
- 같은 프롬프트를 다시 보내거나 같은 명령을 다시 눌렀을 때 세션이 중복으로 열리는가, 같은 toolCallId의 update가 두 번 도착하면 upsert가 어떤 값을 남기는가

“stdout parser보다 관측성이 좋아졌다”도 느낌으로 판정하면 안 되니 지표를 미리 못 박아 뒀어요. 같은 작업을 stdout parser로 돌렸을 때와 비교해 agent-run에 적재되는 lifecycle 이벤트 종류 수가 늘어야 하고, 실패한 실행을 프롬프트 접수 전·도구 실행 중·권한 대기 중·사용자 취소로 분류할 수 있었던 비율이 올라가야 해요. 두 지표가 함께 올라가면 그때 model-router의 provider 경계를 ACP 중심으로 다시 설계할 수 있어요. 여기까지는 무엇을 재기로 했는지를 정한 것이고, 실제로 잰 값은 아직 없어요.

ACP의 가치는 프로토콜 자체보다 경계를 명확히 만드는 데 있어요. stable version은 1인데 제가 탐내는 lifecycle은 전부 draft인 v2 쪽에 있고, 정작 운영에서 돌리는 두 CLI에는 ACP 모드가 보이지 않았어요. 그래서 저는 ACP를 “도입할지 말지”의 문제로 두지 않기로 했어요. stdout parser를 그대로 두더라도 실행 상태와 권한, 취소를 별도 사건으로 기록하는 일은 지금 당장 할 수 있고, 그 기록이 쌓이면 ACP로 갈아탈지는 저절로 판가름 나거든요. 프로토콜을 먼저 고르는 대신 경계를 먼저 그어두는 쪽이 되돌리기도 쉽고요.

## 참고한 공식 출처

아래 문서는 글을 올린 뒤 출처를 다시 짚으며 2026년 9월 8일에 모두 직접 열어 제목과 인용한 문장을 확인했어요. ACP는 v2 표면 전체가 draft라 내용이 바뀔 수 있으니, 읽는 시점에 다시 확인하는 편이 안전해요. `.md`로 끝나는 주소는 문서 사이트가 제공하는 평문 판이고, 열리지 않으면 `.md`를 뗀 같은 주소의 일반 페이지로 대신 볼 수 있어요.

- Introduction — ACP의 정의와 목적, LSP 비유, local/remote 지원 범위. 리드와 「ACP가 그은 선은 에디터와 에이전트 사이다」 — https://agentclientprotocol.com/get-started/introduction
- Architecture — Client와 Agent의 역할 분담, subprocess와 stdio 위의 JSON-RPC, 연결당 concurrent session, MCP와의 관계. 「ACP가 그은 선은 에디터와 에이전트 사이다」 — https://agentclientprotocol.com/get-started/architecture.md
- Overview — Agent와 Client의 baseline method 목록과 초기화 → 세션 설정 → 프롬프트로 이어지는 메시지 흐름. 「붙이기 전에 initialize부터 캡처해야 한다」의 최소 구현 범위 — https://agentclientprotocol.com/protocol/v2/overview.md
- Initialization — initialize 요청·응답 예시와 protocol version 협상 규칙. 「프롬프트 응답은 최종 답변이 아니다」의 첫 코드블록 — https://agentclientprotocol.com/protocol/v2/initialization.md
- Session Setup — session/new 요청·응답 예시, cwd와 mcpServers, session/resume과 session/close. 같은 절의 첫 코드블록과 「세션과 권한은 저장소가 아니라 UX 문제다」 — https://agentclientprotocol.com/protocol/v2/session-setup.md
- Content Blocks — embedded resource의 uri·mimeType·text와 그 용도. 「프롬프트 응답은 최종 답변이 아니다」의 resource 해설 — https://agentclientprotocol.com/protocol/v2/content.md
- Prompt Lifecycle — session/prompt의 빈 result, foreground work, state_update의 running/idle과 stopReason 목록. 「프롬프트 응답은 최종 답변이 아니다」 — https://agentclientprotocol.com/protocol/v2/prompt-lifecycle.md
- Migrating from v1 — v2 표면 전체의 draft 표시, schema/v2/schema.json과 schema.unstable.json의 층위, v1/v2 side-by-side 운영. 「v2는 매력적이지만 아직 조심해야 한다」 — https://agentclientprotocol.com/protocol/v2/migration.md
- Tool Calls — toolCallId 기준 upsert 규칙, tool kind 아홉 가지, tool_call_content_chunk, 도구 업데이트가 세션 상태를 바꾸지 않는다는 규정. 「도구 호출은 로그가 아니라 upsert 이벤트다」 — https://agentclientprotocol.com/protocol/v2/tool-calls.md
- Tool Calls의 Requesting Permission 절 — session/request_permission 요청·응답 예시, 취소된 작업의 permission request에 cancelled outcome으로 응답할 의무, 이해하지 못한 outcome을 승인으로 취급하지 말라는 규정. 「권한 요청과 사용자 입력도 프로토콜 안에 있다」 — https://agentclientprotocol.com/protocol/v2/tool-calls.md
- Elicitation — form mode와 URL mode의 구분, credential 요청 금지와 token 반환 금지. 「권한 요청과 사용자 입력도 프로토콜 안에 있다」 — https://agentclientprotocol.com/protocol/v2/elicitation.md
- agentclientprotocol/agent-client-protocol (README) — “The current stable ACP protocol version is `1`.”과 스키마 산출물의 위치. 「v2는 매력적이지만 아직 조심해야 한다」 — https://github.com/agentclientprotocol/agent-client-protocol
- schema/v2/schema.json — v2의 안정 baseline 스키마 파일. GitHub 웹 화면이 막히면 `https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v2/schema.json`로 받을 수 있어요 — https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v2/schema.json
- schema/v2/schema.unstable.json — baseline 위에 얹히는 draft feature 스키마 파일. 같은 방식으로 `https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v2/schema.unstable.json`이 대체 경로예요 — https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v2/schema.unstable.json

두 스키마 파일은 본문이 “안정 baseline과 unstable layer가 별개 파일로 갈린다”고 말할 때 그 파일이 실재함을 보이려고 단 링크예요. 파일 내용을 직접 읽어 인용한 대목은 없어서, 링크가 열리지 않아도 본문의 다른 주장은 영향을 받지 않아요. 반대로 위 문서 목록의 Migrating from v1과 레포 README는 본문의 버전·층위 서술이 직접 기대고 있는 자료예요.
