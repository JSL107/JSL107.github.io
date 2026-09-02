---
title: "에이전트 평가는 답이 아니라 경로를 봐야 한다"
description: "trajectory-based evaluation으로 에이전트의 도구 호출, 근거 조회, fallback을 회귀 테스트하는 방법을 정리한다."
pubDatetime: 2026-08-28T19:07:00+09:00
category: backend
---

배포 전 테스트를 모두 통과했는데도 운영에서 어딘가 이상하다고 느끼는 순간이 있어요. `/review-pr` 명령은 여전히 “리뷰 결과”를 돌려주지만, GitHub PR detail만 읽고 diff는 보지 않았을 수 있거든요. 근거가 이미 충분한데 모델을 한 번 더 호출하거나, 실패하면 graceful fallback으로 가야 할 경로가 예외로 끝날 수도 있어요.

기존 API 테스트로는 이런 변화를 좀처럼 잡아내기 어려워요. 컨트롤러가 200을 반환했는지, DTO 모양이 맞는지, 최종 문자열에 특정 문구가 들어 있는지는 검사할 수 있어요. 하지만 에이전트 시스템에서는 도구 선택과 호출 순서도 품질의 일부고, 실패했을 때 다른 경로로 빠졌는지 근거를 남겼는지도 살펴야 하니까요.

그래서 trajectory-based agent evaluation이 필요해요. 에이전트가 내놓은 답변만 보지 않고, 실행 도중 지나간 경로 전체를 평가하는 방식이에요. Slack 명령과 GitHub 조회, 모델 라우팅, Queue/Worker, retry-run 구조가 이미 있다면 더 중요한데, 기존 에이전트의 행동이 조용히 달라지는 순간을 CI에서 잡아야 하거든요.

## 최종 응답 테스트로는 보이지 않는 회귀

LLM 애플리케이션을 처음 만들 때는 대개 출력부터 평가해요. 질문을 넣고 답변이 맞는지 확인하는 식이죠. OpenEvals README도 eval을 전통적인 소프트웨어 테스트와 비슷하다고 설명하며, LLM 애플리케이션을 production으로 가져가기 위한 출발점이라고 말해요. OpenAI Evals 문서도 모델 업그레이드와 프롬프트 변경, 모델 비교, prompt regression 방지에 eval이 필요하다고 설명해요.

이 관점은 지금도 중요해요. 단순 분류나 요약, 포맷 변환처럼 “입력 → 출력” 구조가 분명한 작업은 최종 출력만 평가해도 많은 문제를 잡을 수 있거든요. OpenAI 문서의 IT ticket categorization 예시는 ticket text를 Hardware, Software, Other 중 하나로 분류해요. string_check grader로 정답 라벨과 정확히 같은지 비교하고요.

```bash
curl https://api.openai.com/v1/evals \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "IT Ticket Categorization",
    "data_source_config": {
      "type": "custom",
      "item_schema": {
        "type": "object",
        "properties": {
          "ticket_text": { "type": "string" },
          "correct_label": { "type": "string" }
        },
        "required": ["ticket_text", "correct_label"]
      },
      "include_sample_schema": true
    },
    "testing_criteria": [
      {
        "type": "string_check",
        "name": "Match output to human label",
        "input": "{{ sample.output_text }}",
        "operation": "eq",
        "reference": "{{ item.correct_label }}"
      }
    ]
  }'
```

에이전트는 스스로 control flow를 선택하기 때문에 여기서 한 단계 더 복잡해져요. LangChain의 AgentEvals README는 agentic application을 “문제를 풀기 위해 LLM에게 control flow의 자유를 주는 애플리케이션”으로 설명해요. 이 자유는 강력하지만, LLM이 블랙박스라 한 부분의 변경이 뒤쪽 행동에 미칠 영향을 예측하기 어렵다고도 하고요.

code review agent라면 최종 답변이 “전반적으로 괜찮다”로 끝나는지만 봐서는 안 돼요. PR detail과 diff를 읽었는지, 모델 provider 호출 전에 input snapshot이 남았는지, Slack formatter가 실패를 사용자가 이해할 문장으로 바꿨는지까지 확인해야 해요. 출력이 비슷해 보여도 지나온 경로가 다르면 신뢰성도 달라지니까요.

## trajectory는 실행 로그가 아니라 평가 단위다

trajectory는 에이전트가 실행되는 동안 거친 메시지와 도구 호출의 sequence예요. AgentEvals와 OpenEvals 문서는 모두 agent trajectory를 OpenAI-style messages의 list로 나타낼 수 있다고 설명하죠.

user message와 assistant message, assistant의 tool_calls가 여기에 들어가요. tool role의 tool result와 마지막 assistant response도 포함되고요.

AgentEvals README의 TypeScript 예시는 날씨 질문을 처리하는 가장 작은 trajectory를 보여줘요. 사용자가 “SF 날씨”를 물으면 assistant가 get_weather tool을 호출하고, tool result를 받은 다음 최종 응답을 만들어요.

```typescript
import {
  createTrajectoryLLMAsJudge,
  type FlexibleChatCompletionMessage,
  TRAJECTORY_ACCURACY_PROMPT,
} from "agentevals";

const trajectoryEvaluator = createTrajectoryLLMAsJudge({
  prompt: TRAJECTORY_ACCURACY_PROMPT,
  model: "openai:o3-mini",
});

const outputs = [
  { role: "user", content: "What is the weather in SF?" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        function: {
          name: "get_weather",
          arguments: JSON.stringify({ city: "SF" }),
        },
      },
    ],
  },
  { role: "tool", content: "It's 80 degrees and sunny in SF." },
  {
    role: "assistant",
    content: "The weather in SF is 80 degrees and sunny.",
  },
] satisfies FlexibleChatCompletionMessage[];

const evalResult = await trajectoryEvaluator({
  outputs,
});

console.log(evalResult);
```

여기서는 “날씨가 맞는가”만 평가하지 않아요. 날씨 도구를 호출하고 그 결과를 바탕으로 답변했는지, 전체 진행이 합리적이었는지까지 보는 거죠. AgentEvals의 예시 결과도 trajectory_accuracy라는 key와 boolean score를 반환해요.

이 구조는 기존 로그와 닮았지만 목적은 달라요. 로그가 사후 분석을 위해 남기는 기록이라면, trajectory fixture는 다음 실행도 같은 품질의 경로를 밟는지 비교하는 기준이거든요. 운영 로그를 사람이 읽는 데서 끝나면 observability지만, 그 로그를 fixture로 만들어 CI에서 실패시키면 evaluation이 돼요.

## 비교 방식은 하나가 아니다

trajectory-based evaluation은 크게 두 계열로 나뉘어요. 하나는 기준 경로와 실제 경로를 비교하는 match evaluator고, 다른 하나는 LLM-as-judge로 전체 경로가 합리적인지 판단하는 방식이죠.

AgentEvals와 OpenEvals는 trajectory match mode로 strict, unordered, subset, superset을 제공해요.

strict는 같은 tool call이 같은 순서로 나와야 하고, unordered는 순서가 달라도 같은 tool call이 있으면 돼요. subset은 실제 출력의 tool call이 reference의 부분집합인지 보고, superset은 실제 출력이 reference의 핵심 tool call을 포함하는지 확인해요.

| 모드 | 무엇을 보는가 | 어울리는 상황 |
| --- | --- | --- |
| strict | 같은 tool call, 같은 순서 | 순서 자체가 계약인 workflow |
| unordered | 같은 tool call, 순서 무관 | 독립 조회가 여러 개 있는 경우 |
| subset | 실제 호출이 기준보다 넘치지 않는지 | 불필요한 tool 사용을 막고 싶을 때 |
| superset | 필수 호출이 포함됐는지 | 추가 탐색은 허용하되 핵심 단계는 강제할 때 |

### 인자까지 맞춰야 하는가

도구 인자를 비교하는 방식도 조절할 수 있어요. 기본적으로 같은 tool name과 같은 arguments가 필요하지만, 문서에는 `toolArgsMatchMode: "ignore"`로 인자를 무시하고 같은 도구를 호출했는지만 보는 방식이 나와요. `"subset"`, `"superset"`으로 인자의 포함 관계를 보거나, `toolArgsMatchOverrides`로 특정 도구의 비교 규칙을 바꿀 수도 있고요.

이 구분은 실무에서 중요해요. GitHub PR detail을 조회할 때 owner, repo, pullNumber는 정확해야 해요. 하지만 검색 query처럼 표현이 조금씩 달라질 수 있는 인자에 exact match를 걸면 테스트가 지나치게 잘 깨지거든요. trajectory eval은 모든 것을 엄격히 고정하는 장치가 아니라, 경로에서 계약으로 삼을 부분과 유연하게 둘 부분을 나누는 장치에 가까워요.

## LLM judge는 유용하지만 게이트 전체가 되면 위험하다

LLM-as-judge 방식은 사람이 정답 경로를 촘촘히 작성하기 어려울 때 유용해요. OpenEvals README는 `createLLMAsJudge`를 일반적인 시작점으로 소개하며, prompt와 model을 받아 evaluator function을 만든다고 설명해요. AgentEvals도 trajectory 전용 judge prompt인 `TRAJECTORY_ACCURACY_PROMPT`를 제공해요.

이 방식은 경로의 “품질”까지 볼 수 있다는 장점이 있어요. strict match는 도구 순서가 달라지면 실패하지만, 순서가 달라도 괜찮은 경우가 있어요. 도구 이름은 맞아도 목적과 무관한 호출이 끼어들 수도 있죠. judge는 “이 경로가 요청 해결에 합리적인가”, “불필요한 우회가 있는가” 같은 질문을 다룰 수 있어요.

### 게이트 첫 줄에 두면 안 되는 이유

CI gate의 첫 줄부터 LLM judge로 세우는 일은 조심해야 해요. judge도 모델 호출이라 비용과 지연이 생기고, 판정이 완전히 결정적이지 않으니까요. LangSmith 문서는 offline evaluation과 online evaluation을 구분해요.

개발 중에는 curated dataset으로 version을 비교해 regression을 찾아요. 운영 중에는 live traffic을 sampling, filter, reference-free judge, format validation 같은 방식으로 모니터링하고요.

처음에는 deterministic evaluator부터 두는 편이 안전해요. “필수 도구가 호출됐는가”, “실패 시 fallback evidence가 남았는가”, “retry-run이 가능한 trigger와 input snapshot이 있는가”는 코드 규칙으로 검사할 수 있거든요. LLM judge는 그다음에 경로의 자연스러움이나 과잉 탐색 여부를 살피는 보조 평가로 두는 편이 나아요.

:::callout ⚠️ red

OpenAI 문서에는 Evals platform deprecation 공지가 있어요. 기존 evals content는 전환 기간 동안 유지되지만, 기존 사용자에게는 2026년 10월 31일 read-only가 되고 2026년 11월 30일 종료될 예정이라고 해요. 새 평가 설계를 특정 벤더 콘솔에 깊이 묶기보다 fixture, TypeScript evaluator, CI gate로 시작하는 편이 안전해요.

:::

## Slack 에이전트 시스템에 대입하면

Slack 기반 멀티 에이전트 시스템에는 평가 단위로 삼을 만한 경계가 이미 많아요. agent-run은 실행 lifecycle을 묶고, EvidenceRecord는 근거를 남겨요. 여기에 trajectory export layer를 붙이면 “운영 기록”을 “평가 fixture”로 바꿀 수 있거든요.

가장 먼저 연결할 모듈은 agent-run, model-router, github, slack이에요. agent-run은 하나의 실행을 식별하고, model-router는 어떤 AgentType이 어떤 provider로 갔는지 보여줘요.

github는 assigned issue, PR detail, diff 같은 외부 근거 조회를 맡고, slack은 slash command ack와 최종 응답 포맷을 담당해요. 이 네 지점만 이어도 “사용자 입력 → 근거 조회 → 모델 호출 → Slack 응답”의 최소 trajectory가 나와요.

### 슬래시 하나가 지나는 경로

`/review-pr`는 agent/code-reviewer, github, model-router, pr-review-loop, slack에 걸쳐 있어요. 최소 기준 경로에는 PR detail 조회와 diff 조회, code-reviewer provider 호출과 Slack formatter 응답이 들어가요. 여기서 superset match를 쓰면 추가 메타데이터 조회는 허용하면서 diff 조회 누락은 막을 수 있어요.

`/today`는 agent/pm, github, daily-plan, model-router, slack과 맞닿아 있어요. 사용자의 자연어 입력을 받고 GitHub assigned task를 조회해요. 전일 plan이나 기존 daily plan context를 합친 뒤 PM agent provider를 호출하고요.

마지막에 Slack 응답으로 정리하는 경로가 기준이 되죠. GitHub가 실패해도 사용자 입력만으로 graceful fallback이 작동해야 한다면 실패 trajectory도 별도 fixture로 둬야 하고요.

`/worklog`는 agent/work-reviewer, agent-run, EvidenceRecord, model-router, slack을 살펴요. 업무 로그 초안은 근거가 빈약하면 그럴듯한 문장만 남기 쉬우니까요. “정량 근거가 EvidenceRecord에 남았는가”, “근거 누락 시 사용자에게 한계를 드러냈는가”, “불필요한 모델 재호출이 없었는가”가 출력 문장보다 먼저 볼 지표가 되죠.

처음부터 모든 agent에 eval을 붙일 필요는 없어요. Slack slash command처럼 entrypoint가 고정되고 외부 도구 호출 순서가 비교적 명확하며 실패 경로가 중요한 명령부터 시작하는 편이 좋아요. `/review-pr`, `/today`, `/worklog`가 좋은 첫 후보예요.

## 언제 쓰면 안 되는가

trajectory eval이 만능은 아니에요. agent workflow가 자주 바뀌는 초기 설계 단계에서는 strict fixture가 오히려 발목을 잡을 수 있어요. 이때는 최종 출력 평가나 LLM judge 중심의 느슨한 평가가 더 나아요. 경로가 제품 요구사항으로 굳기 전에 순서를 고정하면 리팩터링 비용만 커지니까요.

단순 completion 작업에는 trajectory eval이 과해요. 입력 문장을 특정 tone으로 바꾸는 작업처럼 tool call이 없고 중간 의사결정도 거의 없다면 output evaluator가 알맞죠. OpenEvals가 제공하는 conciseness, correctness 같은 LLM-as-judge나 exact match, embedding similarity 계열이 더 단순해요.

관측 데이터가 없으면 시작할 수도 없어요. trajectory-based evaluation을 하려면 실행 중간 단계가 기록돼야 해요. assistant message와 tool call, tool result, final response가 남지 않으면 나중에 fixture로 만들 수 없거든요.

evaluation보다 observability가 먼저인 이유고, AgentRunService.execute와 EvidenceRecord 같은 기록 구조가 있는 시스템에 이 접근이 특히 잘 맞는 이유도 여기에 있어요.

## 운영 trace에서 CI fixture로

구현은 AgentEvals의 TypeScript match evaluator를 현재 테스트 러너에 얹는 데서 시작해요. 문서에는 TypeScript 설치 명령으로 `npm install agentevals @langchain/core`가 제시되고 Vitest/Jest 통합도 언급돼요. 이미 TypeScript와 NestJS 테스트 문화가 있다면 별도 플랫폼보다 fixture 파일과 evaluator spec부터 만드는 편이 작아요.

각 Slack 명령의 “필수 trajectory step”도 정해야 해요. `/review-pr`, `/today`, `/worklog`마다 정상 경로 1개와 실패 경로 1개를 골라요. 정상 경로에서는 superset match로 필수 tool call을 보장하고, 실패 경로에서는 fallback evidence와 Slack 응답을 검사해요. 그다음 LLM judge를 붙여 “경로가 과하게 돌아가지 않았는가”를 평가하면 돼요.

에이전트 품질은 최종 답변뿐 아니라 실행 경로에도 담겨 있어요. 시작점은 거창한 평가 플랫폼이 아니라, 운영 trace를 fixture로 바꿔 tool call 순서와 필수 근거 조회를 검사하는 거예요. fallback과 불필요한 호출도 TypeScript evaluator와 CI에서 확인하면 돼요.
