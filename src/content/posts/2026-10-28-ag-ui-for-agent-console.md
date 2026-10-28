---
title: "Slack 에이전트에 웹 콘솔을 붙일 때 AG-UI가 맡는 일"
description: "기존 에이전트의 실행 기록을 AG-UI 이벤트로 변환해 Slack과 웹 콘솔에서 함께 보여 주는 방안을 살펴본다."
pubDatetime: 2026-10-28T19:46:00+09:00
category: web
---

Slack에서 에이전트를 운영할 때는 요청을 받고 결과를 메시지로 보내는 것만으로도 충분해 보여요. 웹 콘솔을 붙이면 실행이 시작됐는지, 도구를 호출하는 중인지, 승인을 기다리는지 같은 중간 상태도 사용자에게 보여 줘야 해요.

AG-UI 공식 문서와 1.0 draft specification, 공식 GitHub 저장소를 읽고 TypeScript·NestJS 기반 Slack 멀티 에이전트 시스템에 어떻게 적용할 수 있을지 살펴본 글이에요. 직접 운영 시스템에 붙여 돌린 경험담은 아니에요.

## AG-UI는 실행을 보여 주는 이벤트 계약이다

AG-UI는 Agent User Interaction Protocol의 줄임말이에요. 사용자-facing 애플리케이션과 에이전트 백엔드 사이를 어떤 이벤트로 연결할지가 핵심이에요. 공식 문서는 AG-UI를 open, lightweight, event-based protocol로 설명해요.

기존 방식에서는 Slack 메시지 포맷과 웹 콘솔의 WebSocket 이벤트, DB의 실행 상태 enum을 따로 만들기 쉬워요. 셋이 같은 실행을 가리키는데도 “시작됨”, “도구 호출 중”, “승인 대기”, “완료”를 서로 다른 이름과 구조로 정의하게 돼요.

AG-UI는 요청 하나에 대해 순서가 보장되는 typed event stream 하나를 내보내요. 여기에는 텍스트, 도구 호출, 상태 변경, 진행 상황, reasoning 표시, 서브에이전트 귀속, interrupt가 실려요. UI는 백엔드 내부 구현을 몰라도 이벤트를 읽고 화면을 갱신할 수 있어요.

### MCP, A2A와 다루는 층이 다르다

AG-UI가 다루는 곳은 에이전트와 사용자 UI 사이예요. 도구와 데이터 연결을 표준화하는 MCP, 에이전트끼리의 협업을 다루는 A2A와는 층이 달라요. PR 정보를 읽거나 크롤러를 실행하는 능력은 도구 연결에, 여러 워커에게 일을 나누는 것은 에이전트 간 조율에 해당해요. 사용자가 화면에서 지금 무엇이 진행 중인지 볼 수 있게 하는 일은 AG-UI 쪽이에요.

기존 실행 엔진은 그대로 두고 내부 실행 기록을 UI 이벤트로 바꾸는 adapter를 두면 자연스러워요. NestJS라면 HTTP SSE controller나 WebSocket gateway가 그 경계가 될 수 있어요.

## 실행은 RUN_STARTED로 열리고 terminal event로 닫힌다

AG-UI에서는 RUN_STARTED, RUN_FINISHED, RUN_ERROR, STEP_STARTED, STEP_FINISHED가 실행 수명주기를 나타내요. 텍스트는 TEXT_MESSAGE_*, 도구 호출은 TOOL_CALL_*, 상태는 STATE_SNAPSHOT과 STATE_DELTA로 다뤄요. reasoning, activity, subagent, raw/custom event도 각각 별도 가족으로 나뉘어요.

하나의 run은 RUN_STARTED로 시작해 정상적으로 끝나면 RUN_FINISHED, 복구 불가능한 오류로 끝나면 RUN_ERROR로 닫혀요. 중간 단계가 있다면 STEP_STARTED와 STEP_FINISHED를 쓸 수 있어요. 내부적으로 “begin → run → finish/fail”을 기록하는 시스템이라면 그 바깥에 AG-UI 변환 계층을 얹을 수 있어요.

사용자 승인이 필요해 멈춘 실행은 성공도 실패도 아니에요. AG-UI는 연결을 계속 붙잡아 두는 대신 run을 interrupt outcome으로 끝내고, 다음 run에 resume 답변을 실어요.

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

Slack 승인 버튼으로 민감한 작업을 허용받는 시스템이라면 버튼 클릭을 기다리는 동안 같은 실행을 살려 두기보다, “승인 대기 interrupt로 닫힌 run”과 “승인 답변을 들고 시작하는 다음 run”으로 나눌 수 있어요.

## 사용자 답변은 같은 thread의 다음 요청으로 들어온다

에이전트가 승인을 요청하거나 누락된 값을 물어보거나 외부 정책 판단을 기다려야 할 때는 run을 RUN_FINISHED의 interrupt outcome으로 끝내요. 같은 thread에서 시작하는 다음 RunAgentInput에는 resume 배열이 들어가요.

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

여기서 status가 승인과 거절을 직접 뜻하는 건 아니에요. 사용자가 응답했다면 resolved이고, 거절 같은 의미는 payload에 담아요. 승인 UI에서 사용자가 거절했다면 다음처럼 표현할 수 있어요.

```json
{ "approved": false }
```

Slack 버튼이든 대시보드든 어디서 승인하더라도 같은 thread의 다음 run에 resume을 싣는 모델로 통일할 수 있어요. 다만 열려 있는 interrupt가 여러 개라면 resume 배열에서 모든 open interrupt를 다뤄야 해요. pending interrupt가 있는 thread에 새 입력만 보내면 비정상 입력으로 취급돼요.

승인 질문과 사람의 응답, 이어진 실행이 run 단위로 나뉘어 남는다는 점은 감사 로그에도 유리해요. Slack 기반 운영 도구라면 누가 어떤 실행을 승인했는지 기록할 수 있어야 해요.

## 상태는 스냅샷과 패치로 전달한다

오늘 할 일을 정리하는 화면에는 할 일 목록과 근거가 있고, PR 리뷰 화면에는 파일별 진행 상태가 있어요. 크롤러나 장기 작업 화면에는 단계별 상태도 필요해요. 이런 데이터가 바뀔 때마다 전체를 다시 보내면 UI와 백엔드 양쪽에서 다루기 번거로워요.

AG-UI는 공유 상태를 STATE_SNAPSHOT과 STATE_DELTA로 나눠요. 스냅샷은 현재 상태 전체를 갈아 끼우고, 델타는 RFC 6902 JSON Patch로 작은 변경만 전달해요.

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

이 예시를 운영 도구의 웹 콘솔에 대입하면 “실행 상태가 승인 대기로 바뀌었다”는 UI 갱신에 해당해요. Daily plan에서는 /items/2/status를, PR 리뷰에서는 /files/0/state를 “reviewing”에서 “done”으로 바꿀 수 있어요. AG-UI가 이런 경로 이름까지 정해 주지는 않으므로 상태 객체의 도메인 모델은 애플리케이션이 설계해야 해요.

### 도구 호출의 실행은 애플리케이션이 결정한다

AG-UI에서 도구 호출은 에이전트가 작업을 요청하는 이벤트예요. 특히 frontend tool은 애플리케이션이 실행해요. 문서의 표현대로 agent proposes, application disposes에 가까워요.

모델이 만든 인자 문자열은 완성되기 전까지 prefix일 뿐이라 TOOL_CALL_END 이전에 실행하면 안 돼요. 인자가 완성된 뒤에도 유효한지 검증하고 side effect를 실행할지는 애플리케이션이 결정해야 해요. 공개 글 초안 생성, PR 리뷰 생성, 지원 기록 갱신처럼 저장이나 외부 호출이 얽힌 작업에서는 이 구분이 필요해요. AG-UI가 도구의 안전한 실행까지 해결해 주지는 않지만, UI에서 도구 호출을 볼 수 있는 공통 사건으로 만들어 줘요.

## 운영 도구에는 변환 계층부터 붙인다

실행 수명주기를 이미 기록하고 있다면 시작, 내부 단계, 텍스트, 상태 변경, 성공과 실패를 각각 RUN_STARTED, STEP_STARTED, TEXT_MESSAGE_*, STATE_DELTA, RUN_FINISHED, RUN_ERROR로 바꾸는 adapter를 만들 수 있어요.

Slack의 승인과 재실행 흐름도 interrupt/resume 모델과 맞닿아 있어요. 웹 콘솔에서는 같은 interrupt를 카드로 보여 주고 사용자의 선택을 다음 run의 resume으로 넘길 수 있어요. PR 리뷰, 그날 할 일 정리, 업무 로그 초안처럼 입력과 진행 단계, 중단 이유가 사용자에게 의미 있는 작업에도 적용할 수 있어요.

반면 단순 계산형 기능이나 내부 cron 분석처럼 사람이 실시간으로 볼 일이 없는 작업까지 event stream으로 만들면 복잡도부터 늘어나요. 이벤트를 소비할 화면이 없다면 도입 효과도 제한돼요. 내부 실행 이벤트는 보존하고 바깥으로 내보낼 때만 AG-UI 모양으로 바꾸는 얇은 layer가 적절해요.

## draft의 한계와 다음 확인 작업

AG-UI 1.0 specification은 draft이고, 문서에는 ratified 전이라 호환성을 약속하지 않는다고 명시돼 있어요. 구조에서는 schema가, 동작에서는 specification이 권위를 갖는다는 규칙이 있지만 장기 내부 계약으로 고정하기 전에는 변화를 흡수할 여지를 둬야 해요. 변환 layer를 두면 draft가 바뀌어도 내부 실행 모델에 미치는 영향을 줄일 수 있어요.

AG-UI는 UI-facing event protocol이지 에이전트 오케스트레이션 프레임워크는 아니에요. 큐 재시도, 실행 기록 저장, 권한 검사, Slack의 응답 제한 처리는 애플리케이션이 맡아야 해요. HTTP+SSE, HTTP+Protobuf 같은 표준 binding이 있지만 인증과 인가 역시 protocol 자체가 아니라 binding과 애플리케이션의 책임이에요.

먼저 현재 실행 상태를 AG-UI lifecycle event에 매핑하는 표를 만들어 빠진 상태가 있는지 확인해야 해요. 시작 기록은 RUN_STARTED, 내부 단계는 STEP_STARTED와 STEP_FINISHED, 정상 종료는 RUN_FINISHED의 success outcome, 실패는 RUN_ERROR, 승인 대기는 RUN_FINISHED의 interrupt outcome에 놓을 수 있어요.

웹 콘솔이 먼저라면 HTTP POST로 RunAgentInput을 받고 SSE로 이벤트를 흘려보내는 작은 endpoint부터 확인할 수 있어요. WebSocket을 쓴다면 AG-UI 관점에서는 custom transport이므로 순서 보장, terminal event, truncation 처리를 문서화해야 해요.

출처:

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
