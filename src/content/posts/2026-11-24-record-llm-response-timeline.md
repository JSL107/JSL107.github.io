---
title: "LLM 응답을 실행 타임라인으로 기록하기"
description: "Gemini Interactions API의 step 모델을 살펴보고 Slack 기반 멀티 에이전트 시스템의 실행 로그에 적용할 범위와 한계를 정리한다."
pubDatetime: 2026-11-24T19:46:00+09:00
category: backend
---

Slack에서 “이 PR 좀 봐줘”라고 요청했는데 40초 뒤 긴 리뷰 문장 하나만 도착했다고 해봐요. 사용자는 답을 받았지만 운영자는 모델이 어떤 도구를 썼는지, 어디서 실패했는지, 어느 단계부터 재시도해야 하는지 알기 어려워요.

이 글에서는 Gemini Interactions API의 공식 문서와 예제를 읽고, LLM 응답을 provider-neutral step event log로 표준화할 때 참고할 개념을 살펴봐요. 실제 서비스를 Gemini Interactions API로 교체해 운영한 경험담은 아니에요.

## 최종 답변 하나만 저장하면 운영자가 볼 수 없는 것이 생긴다

LLM을 단순 채팅 UI로 쓸 때는 최종 문자열이 중요해요. 사용자가 묻고 모델이 답하니 입력과 출력만 저장해도 충분해 보이죠. 하지만 Slack 기반 업무 자동화에서는 달라요. “오늘 할 일 정리”, “PR 리뷰 생성”, “업무 로그 초안 작성” 같은 요청은 대개 내부 데이터 조회와 외부 API 확인을 거쳐 요약하고 다시 쓰는 단계를 밟아요.

최종 문자열만으로는 실패를 알아채기 어려워요. PR 리뷰를 만들면서 GitHub diff를 읽지 못했는데도 모델이 일반적인 리뷰 문장을 내놓았다면 결과는 그럴듯해 보일 수 있어요. 하지만 운영자가 확인해야 할 것은 답이 그럴듯한지가 아니라 어떤 근거로 만들어졌는지예요.

운영하려면 시간순 기록이 필요해요. 입력을 받은 뒤 모델이 생각 요약을 만들고 함수를 호출하려 했으며 앱이 함수를 실행해 결과를 다시 모델에 넘긴 끝에 최종 텍스트가 나왔다는 기록이요.

## Interactions API는 대화를 실행 타임라인에 가깝게 본다

Gemini Interactions API에서 눈여겨볼 변화는 응답 단위가 `outputs`에서 `steps`로 옮겨갔다는 점이에요. 2026년 5월 변경으로 legacy `outputs` 구조가 `steps` 구조로 바뀌었고 문서는 이 변화가 mid-flight steering과 asynchronous tool calls 같은 후속 기능의 기반이라고 설명해요. 이름보다 중요한 건 응답을 “결과 묶음”이 아닌 “진행 순서”로 다루기 시작했다는 점이에요.

단순한 joke 요청도 새 구조에서는 `model_output` step 안에 `text` content로 담겨요. `GET /interactions/{id}`로 조회하면 `user_input`까지 포함한 전체 타임라인을 볼 수 있어요. 생성 요청의 결과를 보는 일과 실행 전체를 복원하는 일이 구분되는 거죠.

```json
{
  "id": "int_123",
  "steps": [
    {
      "type": "user_input",
      "content": [
        { "type": "text", "text": "Tell me a joke." }
      ]
    },
    {
      "type": "model_output",
      "content": [
        {
          "type": "text",
          "text": "Why did the chicken cross the road?"
        }
      ]
    }
  ]
}
```

같은 배열에 `user_input`, `model_output`, `thought`, `function_call`, `google_search_call`, `google_search_result` 같은 step이 놓일 수 있어요. 텍스트와 도구 호출이 하나의 실행 타임라인에 기록된 서로 다른 사건이 되는 셈이에요.

기존 `generateContent`식 접근과 비교하면 차이가 더 분명해져요.

| 관점 | 기존 메시지/최종 응답 중심 | Interactions API의 step 중심 |
| --- | --- | --- |
| 저장 단위 | 입력과 최종 출력 | 시간순 step |
| 도구 호출 | 응답 안의 특수 part 또는 별도 처리 | `function_call` step |
| 스트리밍 | 텍스트 chunk 중심으로 보기 쉬움 | 모든 산출물을 typed event로 처리 |
| 재시도 지점 | 전체 요청 단위가 되기 쉬움 | step index나 call id 기준으로 좁힐 수 있음 |
| 운영 로그 | 문자열 파싱에 의존하기 쉬움 | 이벤트 타입과 상태를 저장 가능 |

단순한 호출에는 step 모델이 더 복잡해요. 최종 답변만 필요한 화면이라면 `output_text` 같은 편의 필드가 훨씬 쓰기 쉽죠. 도구 호출과 검색, 감사 기록, 재시도가 중요해질수록 그 복잡성을 감수할 이유가 생겨요.

## streaming은 텍스트 조각이 아니라 step event를 흘려보낸다

Interactions API는 SSE(Server-Sent Events)로 `interaction.created`, `step.start`, `step.delta`, `step.stop`, `interaction.completed` 같은 이벤트를 보내요. 이벤트마다 JSON `data`와 `event_type`이 들어 있어요. 공식 예제의 JavaScript 코드는 평범한 스트리밍 출력처럼 보이지만 조건문에서 `event.event_type === "step.delta"`와 `event.delta.type === "text"`를 함께 확인한다는 점이 중요해요.

```javascript
import { GoogleGenAI } from "@google/genai";

const client = new GoogleGenAI({});

const stream = await client.interactions.create({
  model: "gemini-3.8-flash",
  input: "Count from 1 to 25.",
  stream: true,
});

for await (const event of stream) {
  if (event.event_type === "step.delta") {
    if (event.delta.type === "text") {
      process.stdout.write(event.delta.text);
    }
  }
}
```

여기서 `text`는 여러 delta 중 하나예요. streaming 문서의 이벤트 모델에는 `thought_signature`, `thought_summary`, `function_call`, `arguments_delta`, `google_search_call`, `google_search_result`, `code_execution_call`, `code_execution_result` 같은 타입도 나와요. 이를 활용하면 Slack progress message도 “문자열이 몇 글자 나왔는가”보다 “지금 어떤 step이 진행 중인가”를 기준으로 바꿀 수 있어요.

PR 리뷰를 만든다면 “요청 접수”는 `interaction.created`, “diff 분석 중”은 `thought` 또는 내부 준비 step, “GitHub 데이터 확인 중”은 function call 계열, “리뷰 작성 중”은 `model_output` text delta에 대응시킬 수 있어요. Gemini의 step 타입을 UI에 그대로 보여주기보다 내부 표준 이벤트로 매핑하면 돼요.

주의할 점도 있어요. streaming의 `interaction.completed` 이벤트에는 최종 interaction object와 usage statistics가 담기지만 문서에 따르면 이벤트 자체에 `steps`는 포함되지 않아요. streaming으로 받은 step 이벤트를 운영 로그로 쓰려면 클라이언트가 이벤트를 조립해 저장해야 해요. `completed`만 저장하면 중간 타임라인을 잃을 수 있어요.

## function calling은 모델의 요청과 앱의 실행을 분리한다

모델이 실제 함수를 실행하는 건 아니에요. 모델이 `function_call` step을 만들면 애플리케이션이 그 요청에 따라 외부 함수나 API를 실행해요. 앱은 결과를 `call_id`와 함께 `function_result`로 넘겨 다음 interaction을 만들어요.

공식 migration 예제는 이런 흐름을 보여줘요.

```python
result = "52°F and rain"
interaction = client.interactions.create(
    model="gemini-3.8-flash",
    previous_interaction_id=interaction.id,
    input=[
        {
            "type": "function_result",
            "call_id": step.id,
            "name": step.name,
            "result": [{"type": "text", "text": result}],
        }
    ],
)
print(interaction.output_text)
```

모델이 “날씨 조회 함수를 이 인자로 호출해 달라”고 요청하면 앱이 실제 날씨 API를 호출하고 결과를 `function_result` step으로 돌려줘요. 이렇게 나누면 모델 생성 단계에서 실패했는지, 도구 실행 단계에서 실패했는지, 도구 결과를 받은 뒤 후속 생성에서 실패했는지 구분할 수 있어요.

Slack 멀티 에이전트 시스템에서도 `function_call`과 `function_result`를 근거 단위로 저장할 수 있어요. 그날 할 일을 정리하면서 GitHub assigned task를 조회했다면 “모델이 조회를 요청했다”는 사실과 “앱이 조회한 결과”를 따로 남기는 거예요. 업무 로그를 만들 때 지난 실행 기록을 참고했다면 참고 요청과 실제 조회 결과를 각각 검증할 수도 있어요.

그렇다고 모든 내부 호출을 LLM function calling으로 바꿀 필요는 없어요. 휴가 잔여일 계산처럼 결정론적으로 처리할 수 있는 기능은 LLM의 tool call로 감쌀 이유가 적어요. 자연어에서 날짜나 조건만 추출하고 계산은 일반 코드로 하는 편이 더 안전해요. step log가 필요한 곳은 모델의 판단에 외부 근거가 섞이는 지점이에요.

## 서버 상태 연결에는 데이터 보존 정책이 따른다

Interactions API에는 `previous_interaction_id`가 있어요. 이전 interaction을 서버 쪽 상태로 이어 다음 interaction을 만들 수 있어 멀티턴 대화나 function result 회신에 편해요. `store=false`를 쓰면 stateless 모드가 되지만 이후 turn chaining과 background 실행에는 제약이 생겨요.

Slack 봇에는 사내 업무 데이터와 개인 일정, PR 내용, 지원 현황처럼 민감도가 다른 입력이 섞여요. 모든 agent type에 같은 저장 정책을 적용할 수는 없어요. 서버 저장의 편의를 얻어도 되는 요청이 있는가 하면 내부 로그에도 최소 필드만 남겨야 하는 요청이 있어요.

| 선택 | 얻는 것 | 내주는 것 |
| --- | --- | --- |
| `previous_interaction_id` 중심 | 서버 쪽 대화 연결, 후속 tool result 처리 편의 | provider 저장 정책 검토 필요 |
| `store=false` 중심 | 상태 보존 부담 감소 | turn chaining, background 실행 제약 |
| 내부 provider-neutral log | provider 교체와 감사 기록에 유리 | 직접 조립, 보존 정책 설계 필요 |

Gemini의 `steps`는 참고할 만하지만 내부 시스템이 Gemini 전용 step 타입에 묶이면 다른 provider를 붙일 때 다시 손봐야 해요. 내부 타입은 `stepIndex`, `stepType`, `deltaType`, `callId`, `status`, `text` 정도의 최소 필드로 시작하고 provider 원문을 별도 raw payload로 보관할지 결정하는 편이 나아요.

## 먼저 표준화할 곳과 적용하지 않을 곳

내 시스템에서 가장 먼저 영향을 받는 곳은 모델 라우팅 계층이에요. 지금은 여러 모델 provider를 호출해도 대개 최종 텍스트만 쓰고 있어요. 하지만 라우터의 내부 반환 타입을 `finalText` 하나로 고정하면 provider가 제공한 tool call, search result, thought summary, usage 정보를 나중에 되살리기 어려워요.

다음은 에이전트 실행 기록 계층이에요. 요청마다 실행을 시작하고 모델을 호출한 뒤 성공하거나 실패해요. 여기에 step event log를 넣으면 “PR 리뷰 생성 실패”를 “GitHub diff 조회는 성공했고 모델의 후속 출력 조립에서 실패했다”처럼 구체적으로 나눌 수 있어요. 전체를 다시 실행하는 대신 특정 도구 결과 이후부터 재시도하는 설계도 검토할 수 있고요.

Slack 응답에서는 “처리 중”이라는 progress message를 더 구체적인 상태로 바꿀 수 있어요. 사용자는 `function_call`이라는 이름보다 “관련 PR 정보를 확인하는 중”이라는 설명을 보고 싶을 거예요.

단순 알림, 정해진 DB 조회, 날짜 계산처럼 LLM의 판단이 필요 없는 기능은 step event model의 이점이 작아요. 이런 곳까지 억지로 event log를 넣으면 감사 가능성보다 복잡성이 먼저 늘어요. 중간 추론이나 도구 호출이 운영상 의미 있는지가 도입의 전제예요.

## 남은 한계와 확인할 일

Gemini Interactions API는 현재 Google API와 SDK의 개념이에요. Interactions API reference에는 beta 버전이 포함돼 있고 May 2026 breaking changes처럼 스키마가 바뀐 이력도 있어요. 기존 운영 시스템을 곧바로 이 API 중심으로 교체하기보다는 내부 실행 로그를 설계할 때 참고하는 편이 맞아요.

참고한 문서는 [May 2026 breaking changes](https://ai.google.dev/gemini-api/docs/interactions-breaking-changes-may-2026), [streaming](https://ai.google.dev/gemini-api/docs/streaming), [function calling](https://ai.google.dev/gemini-api/docs/function-calling), [Interactions API reference](https://ai.google.dev/api/interactions-api), [migration guide](https://ai.google.dev/gemini-api/docs/migrate-to-interactions)예요.

다음에는 작은 adapter를 만들어 현재 실행 기록에 저장할 최소 타입이 정말 여섯 필드로 충분한지 확인해야 해요. 텍스트 delta, function call, function result, status update를 각각 한 줄 record로 바꿔 보면 빠진 필드가 드러날 거예요.

Slack progress message와 감사 로그가 같은 event source를 공유해도 되는지도 확인해야 해요. 사용자에게 보여줄 이벤트와 운영자가 볼 이벤트는 민감도와 상세도가 다르거든요.
