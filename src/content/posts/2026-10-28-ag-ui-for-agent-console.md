---
title: "Slack 에이전트에 웹 콘솔을 붙일 때 AG-UI가 맡는 일"
description: "기존 에이전트의 실행 기록을 AG-UI 이벤트로 변환해 Slack과 웹 콘솔에서 함께 보여 주는 방안을 살펴본다."
pubDatetime: 2026-10-28T19:46:00+09:00
category: web
---

Slack에서 에이전트를 운영할 때는 요청을 받고 결과를 메시지로 보내는 것만으로 충분해 보여요. 그런데 웹 콘솔을 붙이면 사정이 달라져요. 실행이 시작됐는지, 도구를 호출하는 중인지, 승인을 기다리는지 같은 중간 상태까지 사용자에게 보여 줘야 해요.

이 글은 그 중간 상태를 전달하는 표준으로 AG-UI를 살펴본 기록이에요. AG-UI 공식 문서와 1.0 draft specification, 공식 GitHub 저장소를 읽고, TypeScript·NestJS 기반 Slack 멀티 에이전트 시스템에 어떻게 적용할 수 있을지 정리했어요.

직접 운영 시스템에 붙여 돌린 경험담은 아니에요.

## 같은 실행을 세 가지 이름으로 부르는 문제

에이전트에 화면을 하나 더 붙이면 Slack 메시지 포맷, 웹 콘솔의 WebSocket 이벤트, DB의 실행 상태 enum을 따로 만들기 쉬워요. 셋 다 같은 실행을 가리키는데도 시작됨·도구 호출 중·승인 대기·완료 같은 상태를 서로 다른 이름과 구조로 정의하게 돼요.

## 실행을 보여 주는 이벤트 계약, AG-UI

AG-UI는 이 문제를 이벤트 계약 하나로 풀어요. AG-UI(Agent User Interaction Protocol)는 사용자가 보는 애플리케이션과 에이전트 백엔드 사이를 어떤 이벤트로 연결할지 정한 프로토콜이에요. 공식 문서는 AG-UI를 개방적이고 가벼운 이벤트 기반 프로토콜로 소개해요.

요청 하나를 보내면 순서가 보장되는 이벤트 스트림 하나가 돌아오고, 이벤트마다 타입이 정해져 있어요. 여기에는 텍스트, 도구 호출, 상태 변경, 진행 상황, reasoning 표시, 서브에이전트 귀속, interrupt가 실려요. 그래서 UI는 백엔드 내부 구현을 몰라도 이벤트만 읽고 화면을 갱신할 수 있어요.

### MCP, A2A와 다른 층

비슷한 이름의 프로토콜이 많아서 위치부터 짚어 둘게요.

| 프로토콜 | 연결하는 대상 | 예시 |
|---|---|---|
| MCP | 에이전트와 도구·데이터 | PR 정보 읽기, 크롤러 실행 |
| A2A | 에이전트와 에이전트 | 여러 워커에게 일 나누기 |
| AG-UI | 에이전트와 사용자 UI | 지금 무엇이 진행 중인지 화면에 보여 주기 |

AG-UI를 도입한다고 기존 실행 엔진을 바꿀 필요는 없어요. 내부 실행 기록을 UI 이벤트로 바꾸는 어댑터 하나를 바깥에 두면 돼요. NestJS라면 HTTP SSE controller나 WebSocket gateway가 그 경계가 될 수 있어요.

## 이벤트 종류와 실행 수명주기

이벤트는 역할에 따라 몇 묶음으로 나뉘어요.

- 실행 수명주기: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STEP_STARTED`, `STEP_FINISHED`
- 텍스트: `TEXT_MESSAGE_*`
- 도구 호출: `TOOL_CALL_*`
- 상태: `STATE_SNAPSHOT`, `STATE_DELTA`
- 그 밖에 reasoning, activity, subagent, raw/custom event

하나의 run은 `RUN_STARTED`로 시작해서 정상적으로 끝나면 `RUN_FINISHED`로 닫혀요. 복구할 수 없는 오류로 끝났다면 `RUN_ERROR`가 마지막 이벤트예요. 중간 단계는 `STEP_STARTED`와 `STEP_FINISHED`로 표시해요.

내부적으로 "begin → run → finish/fail"을 기록하는 시스템이라면 AG-UI 변환 계층을 그 바깥에 그대로 얹을 수 있어요.

## 승인 대기와 interrupt

사용자 승인이 필요해 멈춘 실행은 성공도 실패도 아니라서 다루기 까다로워요. AG-UI는 이때 연결을 붙잡아 두지 않아요. 에이전트가 승인을 요청하거나, 누락된 값을 묻거나, 외부 정책 판단을 기다려야 하면 run을 `RUN_FINISHED`의 interrupt outcome으로 끝내요.

```typescript
type RunFinishedOutcome =
  | { type: "success" }
  | { type: "interrupt"; interrupts: Interrupt[] }

type RunFinishedEvent = {
  type: "RUN_FINISHED"
  threadId: string
  runId: string
  result?: unknown
  outcome?: RunFinishedOutcome
}
```

사용자의 답변은 같은 thread에서 시작하는 다음 run으로 들어오고, 이때 `RunAgentInput`에 `resume` 배열이 실려요.

```typescript
type RunAgentInput = {
  // ... existing fields
  resume?: Array<{
    interruptId: string
    status: "resolved" | "cancelled"
    payload?: any
    metadata?: Record<string, any>
  }>
}
```

`status`가 승인과 거절을 뜻하지는 않아요. 사용자가 응답했다면 `resolved`이고, 거절 같은 의미는 `payload`에 담아요. 예를 들어 승인 UI에서 사용자가 거절했다면 payload를 이렇게 표현할 수 있어요.

```json
{ "approved": false }
```

이 모델을 따르면 Slack 승인 버튼도 클릭을 기다리는 동안 같은 실행을 살려 두는 대신, 승인 대기 interrupt로 닫힌 run과 승인 답변을 들고 시작하는 다음 run으로 나누면 돼요. 대시보드에서 승인하더라도 같은 방식을 쓰면 되니, 승인 경로를 하나로 통일할 수 있고요.

열려 있는 interrupt가 여러 개라면 `resume` 배열에서 모든 open interrupt를 다뤄야 해요. pending interrupt가 있는 thread에 새 입력만 보내면 비정상 입력으로 취급돼요.

승인 질문, 사람의 응답, 이어진 실행이 run 단위로 나뉘어 남으니 감사 로그에도 유리해요. Slack 기반 운영 도구라면 누가 어떤 실행을 승인했는지 기록이 남아야 하니까요.

## 스냅샷과 패치로 보내는 상태

화면마다 보여 줄 상태도 달라요. 오늘 할 일을 정리하는 화면에는 할 일 목록과 근거가 필요하고, PR 리뷰 화면에는 파일별 진행 상태가 필요해요. 크롤러 같은 장기 작업이라면 단계별 상태를 보여 줘야 하고요. 이런 데이터가 바뀔 때마다 전체를 다시 보내면 UI와 백엔드 양쪽에서 다루기 번거로워요.

AG-UI는 공유 상태를 `STATE_SNAPSHOT`과 `STATE_DELTA`로 나눠요. 스냅샷은 현재 상태 전체를 갈아 끼우고, 델타는 RFC 6902 JSON Patch로 바뀐 부분만 전달해요.

```typescript
interface StateSnapshotEvent {
  type: EventType.STATE_SNAPSHOT
  snapshot: any // Complete state object
}

interface StateDeltaEvent {
  type: EventType.STATE_DELTA
  delta: JsonPatchOperation[] // Array of JSON Patch operations
}
```

패치 하나는 이렇게 생겨요.

```json
{ "op": "replace", "path": "/conversation_state", "value": "paused" }
```

운영 도구의 웹 콘솔에서는 이 패치가 곧 실행 상태가 승인 대기로 바뀌었다는 화면 갱신이에요. 할 일 정리 화면의 `/items/2/status`나 PR 리뷰 화면의 `/files/0/state`도 같은 방식으로 "reviewing"에서 "done"으로 바꿀 수 있어요. 다만 이런 경로 이름은 AG-UI가 정하지 않으니, 상태 객체의 도메인 모델은 직접 설계해야 해요.

## 도구 호출과 실행 시점

AG-UI에서 도구 호출은 에이전트가 작업을 요청하는 이벤트이고, 특히 frontend tool은 애플리케이션이 실행해요. 문서 표현을 빌리면 "agent proposes, application disposes", 즉 에이전트가 제안하고 애플리케이션이 처리하는 구조에 가까워요.

모델이 만든 인자 문자열은 완성되기 전까지 앞부분일 뿐이라 `TOOL_CALL_END` 이전에 실행하면 안 돼요. 인자가 완성된 뒤에도 유효한지 검증하고 부수 효과를 실행할지는 애플리케이션이 정해요. 공개 글 초안 생성, PR 리뷰 생성, 지원 기록 갱신처럼 저장이나 외부 호출이 얽힌 작업이라면 이 구분이 꼭 필요해요. AG-UI는 도구 호출을 UI에서 볼 수 있는 공통 사건으로 만들 뿐, 안전한 실행까지 책임지지는 않아요.

## 어디에 붙이고 어디에 붙이지 않을까

입력과 진행 단계, 중단 이유가 사용자에게 의미 있는 작업이라면 잘 맞아요. PR 리뷰, 그날 할 일 정리, 업무 로그 초안 같은 작업이에요. Slack의 승인과 재실행 흐름도 interrupt/resume 모델과 맞닿아 있어요. 웹 콘솔에서는 같은 interrupt를 카드로 보여 주고, 사용자의 선택을 다음 run의 `resume`으로 넘기면 돼요.

단순 계산형 기능이나 내부 cron 분석처럼 사람이 실시간으로 볼 일이 없는 작업은 사정이 달라요. 이런 것까지 이벤트 스트림으로 만들면 복잡도만 늘고, 이벤트를 소비할 화면이 없다면 도입 효과도 크지 않아요. 내부 실행 이벤트는 그대로 보존하고, 바깥으로 내보낼 때만 AG-UI 모양으로 바꾸는 얇은 변환 계층이 적절해요.

## 아직 draft인 스펙

AG-UI 1.0 specification은 아직 draft예요. 문서에도 비준 전이라 호환성을 약속하지 않는다고 명시돼 있어요.

구조의 기준은 schema, 동작의 기준은 specification이라는 규칙이 있긴 해요. 그래도 장기 내부 계약으로 고정하기 전에는 변화를 흡수할 여지를 두는 편이 안전해요. 앞서 말한 변환 계층을 두면 draft가 바뀌어도 내부 실행 모델에 미치는 영향을 줄일 수 있어요.

AG-UI는 UI를 향한 이벤트 프로토콜이고, 에이전트 오케스트레이션 프레임워크는 아니에요. 큐 재시도, 실행 기록 저장, 권한 검사, Slack의 응답 제한 처리는 여전히 애플리케이션이 맡아요. 인증과 인가도 마찬가지로, HTTP+SSE나 HTTP+Protobuf 같은 표준 binding이 있어도 프로토콜이 아니라 binding과 애플리케이션이 책임져요.

## 다음에 확인할 것

먼저 현재 실행 상태를 AG-UI lifecycle event에 매핑하는 표를 만들어, 빠진 상태가 없는지 확인할 생각이에요.

| 내부 실행 상태 | AG-UI 이벤트 |
|---|---|
| 시작 기록 | `RUN_STARTED` |
| 내부 단계 | `STEP_STARTED` / `STEP_FINISHED` |
| 텍스트 출력 | `TEXT_MESSAGE_*` |
| 상태 변경 | `STATE_DELTA` |
| 정상 종료 | `RUN_FINISHED` (success outcome) |
| 실패 | `RUN_ERROR` |
| 승인 대기 | `RUN_FINISHED` (interrupt outcome) |

웹 콘솔이 먼저라면 HTTP POST로 `RunAgentInput`을 받고 SSE로 이벤트를 흘려보내는 작은 endpoint부터 만들어 볼 수 있어요. WebSocket을 쓴다면 AG-UI 관점에서는 custom transport라서, 순서 보장과 종료 이벤트, 잘림 처리를 따로 문서로 정해 둬야 해요.

## 출처

- https://docs.ag-ui.com/introduction
- https://docs.ag-ui.com/spec/draft
- https://docs.ag-ui.com/concepts/events
- https://docs.ag-ui.com/concepts/interrupts
- https://docs.ag-ui.com/concepts/state
- https://docs.ag-ui.com/spec/draft/basic/run-input
- https://docs.ag-ui.com/spec/draft/basic/patterns
- https://docs.ag-ui.com/spec/draft/basic/transports
- https://docs.ag-ui.com/spec/draft/events
- https://docs.ag-ui.com/spec/draft/events/tool-calls
- https://docs.ag-ui.com/spec/draft/schema
- https://github.com/ag-ui-protocol/ag-ui
