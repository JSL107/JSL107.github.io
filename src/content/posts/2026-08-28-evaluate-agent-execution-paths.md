---
title: "에이전트 평가는 답이 아니라 경로를 봐야 한다"
description: "trajectory-based evaluation으로 에이전트의 도구 호출, 근거 조회, fallback을 회귀 테스트하는 방법을 정리한다."
pubDatetime: 2026-08-28T19:07:00+09:00
category: backend
---

배포 전 테스트를 모두 통과했는데도 운영에서 어딘가 이상하다고 느끼는 순간이 있어요. 제가 쓰는 Slack 봇의 슬래시 명령인 `/review-pr`는 여전히 “리뷰 결과”를 돌려주지만, GitHub PR detail만 읽고 diff는 보지 않았을 수 있거든요. 근거가 이미 충분한데 모델을 한 번 더 호출하거나, 실패했을 때 에러 대신 준비된 대체 경로로 넘어가는 graceful fallback이 작동하지 않고 그대로 예외로 끝날 수도 있어요. 셋 다 제가 운영에서 실제로 겪은 사건은 아니에요. 코드 구조상 열려 있는 경로일 뿐인데, 지금 막아 두지 않으면 언젠가 아무 신호 없이 지나갈 수 있죠. 기존 API 테스트로는 이런 변화를 좀처럼 잡아내기 어려워요. 컨트롤러가 200을 반환했는지, DTO 모양이 맞는지, 최종 문자열에 특정 문구가 들어 있는지는 검사할 수 있어요. 하지만 에이전트 시스템에서는 도구 선택과 호출 순서도 품질의 일부고, 실패했을 때 다른 경로로 빠졌는지 근거를 남겼는지도 살펴야 하니까요.

그래서 trajectory-based agent evaluation이 필요해요. 에이전트가 내놓은 답변만 보지 않고, 실행 도중 지나간 경로 전체를 평가하는 방식이에요. 여기까지는 AgentEvals와 OpenAI Evals 문서를 읽고 정리한 것이고 제 시스템에 붙여 돌려본 단계는 아니라는 걸 먼저 밝혀 둘게요. Slack 명령과 GitHub 조회, 모델 라우팅, Queue/Worker, 그리고 같은 입력으로 실행을 다시 돌리는 retry-run 구조가 이미 있다면 더 중요한데, 기존 에이전트의 행동이 조용히 달라지는 순간을 CI에서 잡아야 하거든요.

이름이 비슷한 도구가 셋이라 먼저 갈라 둘게요. [AgentEvals](https://github.com/langchain-ai/agentevals)는 LangChain 팀이 에이전트의 실행 경로 평가에 초점을 맞춰 내놓은 오픈소스 패키지고, [OpenEvals](https://github.com/langchain-ai/openevals)는 같은 팀의 범용 LLM 앱 평가 패키지예요. 둘은 서로를 “일반 평가는 저쪽, 에이전트 평가는 이쪽”으로 안내하는 자매 패키지인데, 지금은 OpenEvals 쪽에도 trajectory 평가가 함께 들어와 있어요. [OpenAI Evals](https://developers.openai.com/api/docs/guides/evals)는 설치해 쓰는 패키지가 아니라 OpenAI 플랫폼이 API와 대시보드로 호스팅하던 eval 제품이고요. 이 글에 인용한 문서와 링크는 모두 2026년 9월 8일에 확인한 판 기준이에요.

## 최종 응답 테스트로는 보이지 않는 회귀

출력만 보는 평가는 틀린 게 아니라 범위가 좁을 뿐이에요. LLM 애플리케이션을 처음 만들 때는 대개 출력부터 평가하고, 질문을 넣고 답변이 맞는지 확인하는 식이죠. [OpenEvals 문서](https://github.com/langchain-ai/openevals)도 첫 줄에서 eval을 전통적인 소프트웨어의 테스트에 빗대며, LLM 애플리케이션을 production으로 가져갈 때 빠뜨릴 수 없는 부분이라고 말해요. 평가 설계의 출발점이 바로 이 출력 평가라는 뜻이죠. 모델을 올리거나 프롬프트를 바꿀 때, 여러 모델을 견줄 때, prompt regression을 막을 때 모두 eval이 필요해요.

이 관점은 지금도 중요해요. 단순 분류나 요약, 포맷 변환처럼 “입력 → 출력” 구조가 분명한 작업은 최종 출력만 평가해도 많은 문제를 잡을 수 있거든요. OpenAI의 [Working with evals](https://developers.openai.com/api/docs/guides/evals) 문서에 나오는 IT ticket categorization 예시는 ticket text를 Hardware, Software, Other 중 하나로 분류해요. string_check grader로 정답 라벨과 정확히 같은지 비교하고요.

아래는 그 문서에 실린 예시를 그대로 옮긴 것이에요.

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

`data_source_config`는 이 eval이 받을 데이터의 모양을 선언하는 자리라, `item_schema`에 적은 `ticket_text`와 `correct_label`이 곧 데이터셋 한 줄의 필드가 돼요. 여기에 `include_sample_schema`를 `true`로 두면 데이터뿐 아니라 모델이 만들어 낸 출력까지 채점 기준에서 참조할 수 있게 되고요. 그래야 아래 `testing_criteria`의 템플릿 변수 두 개가 성립해요. `{{ item.correct_label }}`은 데이터에 적힌 정답을, `{{ sample.output_text }}`는 모델이 실제로 뱉은 문자열을 가리키거든요. 이 eval이 하는 일은 그 둘을 `eq`로 맞춰 보는 게 전부예요.

에이전트는 스스로 control flow를 선택하기 때문에 여기서 한 단계 더 복잡해져요. [AgentEvals 문서](https://github.com/langchain-ai/agentevals)는 agentic application을 문제를 풀기 위해 LLM에게 control flow의 자유를 넘긴 애플리케이션이라고 정의하면서, 그 자유가 강력한 만큼 LLM이 블랙박스라서 에이전트 한 부분의 변경이 뒤쪽에 어떤 영향을 줄지 이해하기 어렵다고 덧붙여요.

code review agent라면 최종 답변이 “전반적으로 괜찮다”로 끝나는지만 봐서는 안 돼요. PR detail과 diff를 읽었는지, 모델 provider 호출 전에 input snapshot이 남았는지, Slack formatter가 실패를 사용자가 이해할 문장으로 바꿨는지까지 확인해야 해요. 출력이 비슷해 보여도 지나온 경로가 다르면 신뢰성도 달라지니까요.

## trajectory는 실행 로그가 아니라 평가 단위다

trajectory는 에이전트가 실행되는 동안 거친 메시지와 도구 호출의 sequence예요. agent trajectory는 OpenAI-style messages의 list로 나타낼 수 있어요.

이 목록이 중요한 건 평가 대상이 답변 한 줄에서 실행 기록 전체로 넓어진다는 뜻이기 때문이에요. user message와 assistant message, assistant의 tool_calls가 여기에 들어가고, tool role의 tool result와 마지막 assistant response도 포함되거든요.

가장 작은 trajectory는 이렇게 생겼어요. 사용자가 “SF 날씨”를 물으면 assistant가 get_weather tool을 호출하고, tool result를 받은 다음 최종 응답을 만들어요. 코드는 AgentEvals 문서의 TypeScript quickstart 원문 그대로예요.

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

마지막 줄이 찍는 값은 문서에 이렇게 실려 있어요.

```text
{
    key: 'trajectory_accuracy',
    score: true,
    comment: '...'
}
```

여기서는 “날씨가 맞는가”만 평가하지 않아요. 날씨 도구를 호출하고 그 결과를 바탕으로 답변했는지, 전체 진행이 합리적이었는지까지 보는 거죠. 그래서 반환값도 점수 하나가 아니라 trajectory_accuracy라는 key와 boolean score, 그리고 그렇게 판정한 이유가 담기는 comment로 이뤄져 있어요.

이 구조는 기존 로그와 닮았지만 목적은 달라요. 로그가 사후 분석을 위해 남기는 기록이라면, trajectory fixture는 다음 실행도 같은 품질의 경로를 밟는지 비교하는 기준이거든요. 운영 로그를 사람이 읽는 데서 끝나면 observability지만, 그 로그를 fixture로 만들어 CI에서 실패시키면 evaluation이 돼요.

## 비교 방식은 하나가 아니다

trajectory-based evaluation은 크게 두 계열로 나뉘어요. 하나는 기준 경로와 실제 경로를 비교하는 match evaluator고, 다른 하나는 LLM-as-judge로 전체 경로가 합리적인지 판단하는 방식이죠.

[AgentEvals](https://github.com/langchain-ai/agentevals)와 [OpenEvals](https://github.com/langchain-ai/openevals)는 trajectory match mode로 strict, unordered, subset, superset을 제공해요. LangChain 문서의 [trajectory evaluation 가이드](https://docs.langchain.com/langsmith/trajectory-evals)도 같은 네 가지를 표로 정리해 두고 있고요.

strict는 같은 tool call이 같은 순서로 나와야 하고, unordered는 순서가 달라도 같은 tool call이 있으면 돼요. subset은 실제 출력의 tool call이 reference의 부분집합인지 보고, superset은 실제 출력이 reference의 핵심 tool call을 포함하는지 확인해요.

| 모드 | 무엇을 보는가 | 어울리는 상황 |
| --- | --- | --- |
| strict | 같은 tool call, 같은 순서 | 순서 자체가 계약인 workflow |
| unordered | 같은 tool call, 순서 무관 | 독립 조회가 여러 개 있는 경우 |
| subset | 실제 호출이 기준보다 넘치지 않는지 | 불필요한 tool 사용을 막고 싶을 때 |
| superset | 필수 호출이 포함됐는지 | 추가 탐색은 허용하되 핵심 단계는 강제할 때 |

만드는 쪽은 호출 한 줄이에요. AgentEvals 문서의 TypeScript 예제에서 생성부와 호출부만 추렸고, 모드 이름만 갈아 끼우면 표의 네 가지가 그대로 나와요.

```typescript
import { createTrajectoryMatchEvaluator } from "agentevals";

const evaluator = createTrajectoryMatchEvaluator({
  trajectoryMatchMode: "superset", // "strict" | "unordered" | "subset" | "superset"
});

const result = await evaluator({
  outputs,
  referenceOutputs,
});
```

인자 자리를 보면 이 평가가 무엇과 무엇을 견주는지가 드러나요. `outputs`가 이번 실행이 남긴 messages 배열이고, `referenceOutputs`가 기준으로 삼은 경로예요. 반환값은 `{ key: 'trajectory_superset_match', score: true }`처럼 모드 이름이 붙은 key와 boolean score라서, 어떤 모드로 통과했는지가 결과에 그대로 남고요.

### 인자까지 맞춰야 하는가

도구 인자를 비교하는 방식도 조절할 수 있어요. 기본적으로 같은 tool name과 같은 arguments가 필요한데, `toolArgsMatchMode: "ignore"`로 인자를 무시하고 같은 도구를 호출했는지만 볼 수도 있어요. `"subset"`, `"superset"`으로 인자의 포함 관계를 보거나, `toolArgsMatchOverrides`로 특정 도구의 비교 규칙을 바꿀 수도 있고요.

이 구분은 실무에서 중요해요. GitHub PR detail을 조회할 때 owner, repo, pullNumber는 정확해야 해요. 하지만 검색 query처럼 표현이 조금씩 달라질 수 있는 인자에 exact match를 걸면 테스트가 지나치게 잘 깨지거든요. trajectory eval은 모든 것을 엄격히 고정하는 장치가 아니라, 경로에서 계약으로 삼을 부분과 유연하게 둘 부분을 나누는 장치에 가까워요.

## LLM judge는 유용하지만 게이트 전체가 되면 위험하다

LLM-as-judge 방식은 사람이 정답 경로를 촘촘히 작성하기 어려울 때 유용해요. 일반적인 시작점은 OpenEvals가 내보내는 `createLLMAsJudge`인데, prompt와 model을 받아 evaluator function을 만들어 줘요. AgentEvals의 `createTrajectoryLLMAsJudge`는 문서가 밝히듯 그와 같은 파라미터를 받으면서, trajectory 전용 judge prompt인 `TRAJECTORY_ACCURACY_PROMPT`까지 함께 제공하고요.

이 방식은 경로의 “품질”까지 볼 수 있다는 장점이 있어요. strict match는 도구 순서가 달라지면 실패하지만, 순서가 달라도 괜찮은 경우가 있어요. 도구 이름은 맞아도 목적과 무관한 호출이 끼어들 수도 있죠. judge는 “이 경로가 요청 해결에 합리적인가”, “불필요한 우회가 있는가” 같은 질문을 다룰 수 있어요.

### 게이트 첫 줄에 두면 안 되는 이유

CI gate의 첫 줄부터 LLM judge로 세우는 일은 조심해야 해요. judge도 모델 호출이라 비용과 지연이 생기고, 판정이 완전히 결정적이지 않으니까요. offline evaluation과 online evaluation은 나눠서 봐야 해요.

LangChain의 [Evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts) 문서가 쓰는 구분을 빌리면, 개발 중에 도는 offline evaluation은 정답을 붙여 둔 curated dataset 위에서 버전을 갈아 끼우며 regression을 찾는 일이에요. 반대로 운영 중의 online evaluation에는 비교할 정답이 없어서, live traffic을 sampling rate와 filter로 추린 다음 정답 없이 판정하는 reference-free judge나 응답이 정해진 JSON 구조와 필수 필드를 지켰는지 보는 format validation으로 감시해요.

처음에는 deterministic evaluator부터 두는 편이 안전해요. “필수 도구가 호출됐는가”, “실패 시 fallback evidence가 남았는가”, “retry-run이 가능한 trigger와 input snapshot이 있는가”는 코드 규칙으로 검사할 수 있거든요. LLM judge는 그 위에 한 겹 더 얹어요. 경로가 자연스러운지, 불필요하게 돌아가지는 않았는지 같은 판단을 그때 맡기면 돼요.

:::callout ⚠️ red

OpenAI는 2026년 6월 3일 자로 [Evals platform deprecation](https://developers.openai.com/api/docs/deprecations)을 공지했어요. 기존 evals content는 전환 기간 동안 유지되지만, 기존 사용자에게는 2026년 10월 31일 read-only가 되고 2026년 11월 30일 종료될 예정이라고 해요. 같은 공지가 이전 경로로 [Moving from OpenAI Evals to Promptfoo](https://developers.openai.com/cookbook/examples/evaluation/moving-from-openai-evals-to-promptfoo) 예제를 안내하고 있으니, 위 curl 예시가 닫힌 뒤에는 그쪽을 보면 돼요. 저는 새 평가 설계를 특정 벤더 콘솔에 깊이 묶기보다 fixture, TypeScript evaluator, CI gate로 시작하는 편이 안전하다고 봐요.

:::

## Slack 에이전트 시스템에 대입하면

제가 쓰는 Slack 기반 멀티 에이전트 시스템에는 평가 단위로 삼을 만한 경계가 이미 많아요. agent-run은 실행 lifecycle을 묶고, 그 실행이 무엇을 근거로 판단했는지 남기는 EvidenceRecord가 옆에 붙어요. 여기에 trajectory export layer를 붙이면 “운영 기록”을 “평가 fixture”로 바꿀 수 있거든요.

제 시스템에서 가장 먼저 연결할 모듈은 agent-run, model-router, github, slack 네 개예요. agent-run은 하나의 실행을 식별하고, model-router는 에이전트 종류를 가리키는 enum인 AgentType이 어떤 provider로 갔는지 보여줘요. github는 assigned issue, PR detail, diff 같은 외부 근거 조회를 맡고, slack은 slash command ack와 최종 응답 포맷을 담당하고요. 이 네 지점만 이어도 “사용자 입력 → 근거 조회 → 모델 호출 → Slack 응답”의 최소 trajectory가 나와요.

### 슬래시 세 개는 서로 다른 경로를 밟는다

`/review-pr`는 agent/code-reviewer, github, model-router, pr-review-loop, slack에 걸쳐 있어요. 최소 기준 경로에는 PR detail 조회와 diff 조회, code-reviewer provider 호출과 Slack formatter 응답이 들어가요. 여기서 superset match를 쓰면 추가 메타데이터 조회는 허용하면서 diff 조회 누락은 막을 수 있어요.

`/today`가 부르는 모듈은 조금 다른데, agent/pm과 daily-plan이 들어오고 pr-review-loop가 빠져요. 이 명령은 사용자의 자연어 입력을 받아 GitHub assigned task를 조회하고, 전일 plan이나 기존 daily plan context를 합친 뒤 PM agent provider를 호출하고, 마지막에 Slack 응답으로 정리해요. 이 순서가 곧 기준 경로가 되죠. GitHub가 실패해도 사용자 입력만으로 graceful fallback이 작동해야 한다면 실패 trajectory도 별도 fixture로 둬야 하고요.

`/worklog`에서는 EvidenceRecord가 경로의 한가운데로 올라와요. 업무 로그 초안은 근거가 빈약하면 그럴듯한 문장만 남기 쉬우니까요. 그래서 출력 문장보다 먼저 보는 지표가 셋 있어요. 정량 근거가 EvidenceRecord에 실제로 남았는지, 근거가 비었을 때 그 한계를 사용자에게 드러냈는지, 모델을 쓸데없이 다시 부르지는 않았는지예요.

### 어느 명령부터 붙일까

처음부터 모든 agent에 eval을 붙일 필요는 없어요. Slack slash command처럼 entrypoint가 고정되고 외부 도구 호출 순서가 비교적 명확하며 실패 경로가 중요한 명령부터 시작하는 편이 좋아요. `/review-pr`, `/today`, `/worklog`가 좋은 첫 후보예요.

## 언제 쓰면 안 되는가

trajectory eval이 만능은 아니에요. agent workflow가 자주 바뀌는 초기 설계 단계에서는 strict fixture가 오히려 발목을 잡을 수 있는데, 제 쪽에도 경로가 아직 굳지 않은 명령이 섞여 있어서 입구와 호출 순서가 안정된 `/review-pr`부터만 후보로 잡았어요. 이때는 최종 출력 평가나 LLM judge 중심의 느슨한 평가가 더 나아요. 경로가 제품 요구사항으로 굳기 전에 순서를 고정하면 리팩터링 비용만 커지니까요.

단순 completion 작업에는 trajectory eval이 과해요. 입력 문장을 특정 tone으로 바꾸는 작업처럼 tool call이 없고 중간 의사결정도 거의 없다면 output evaluator가 알맞죠. OpenEvals가 제공하는 conciseness, correctness 같은 LLM-as-judge나 exact match, embedding similarity 계열이 더 단순해요.

관측 데이터가 없으면 시작할 수도 없어요. trajectory-based evaluation을 하려면 실행 중간 단계가 기록돼야 해요. assistant message와 tool call, tool result, final response가 남지 않으면 나중에 fixture로 만들 수 없거든요.

evaluation보다 observability가 먼저인 이유예요. AgentRunService.execute와 EvidenceRecord가 실행과 근거를 남기긴 하지만, 그 기록이 tool call과 tool result까지 messages 형태로 담고 있는지는 확인해 보지 않았고, 확인 전까지는 이 접근이 잘 맞는다고 말하기가 일러요.

## 운영 trace에서 CI fixture로

구현은 AgentEvals의 TypeScript match evaluator를 현재 테스트 러너에 얹는 데서 시작해요. AgentEvals 문서는 TypeScript 설치를 `npm install agentevals @langchain/core`로 안내하고, 러너 쪽은 LangSmith의 Vitest·Jest 연동 문서로 넘겨요. 제가 확인한 실행 조건은 이 정도예요.

- **패키지**: npm 레지스트리 기준 `agentevals` 최신판은 0.0.7이고 2026년 3월 3일에 배포됐어요. peer dependency로 `@langchain/core` 0.3.80 이상과 `@langchain/langgraph` 0.2.46 이상을 요구하고요.
- **Node**: `agentevals` 패키지에는 `engines` 필드가 없어서 요구 하한을 확인하지 못했어요. 제 레포가 Node 22.12 이상에서 돈다는 것만 확실해요.
- **API 키**: judge를 돌리려면 `OPENAI_API_KEY`가 필요해요. 문서 quickstart가 OpenAI `o3-mini`를 judge로 쓰거든요. 반대로 match evaluator만 쓰면 모델을 부르지 않으니 키도 필요 없어요. 결과를 LangSmith에 쌓으려면 `LANGSMITH_API_KEY`와 `LANGSMITH_TRACING`을 더 넣어야 하고요.
- **러너**: 제 레포는 Jest 29 위에서 `pnpm test`로 도는데, 문서 예제는 `vitest run test_trajectory.eval.ts` 형태라 NestJS의 Jest 설정과 어디서 부딪히는지는 아직 확인하지 못했어요.

이미 TypeScript와 NestJS 테스트 문화가 있다면 별도 플랫폼을 들이는 것보다 fixture 파일과 evaluator spec부터 만드는 쪽이 작아요.

각 Slack 명령의 “필수 trajectory step”도 정해야 해요. `/review-pr`, `/today`, `/worklog`마다 정상 경로 1개와 실패 경로 1개를 골라요. 정상 경로에서는 superset match로 필수 tool call을 보장하고, 실패 경로에서는 fallback evidence와 Slack 응답을 검사해요. 그다음 LLM judge를 붙여 “경로가 과하게 돌아가지 않았는가”까지 볼 수 있을 텐데, 여기부터는 문서를 읽고 세운 계획이라 실제로 돌려 보기 전에는 비용도 판정 흔들림도 얼마나 될지 모르겠어요.

fixture 한 건은 더 줄일 수 없는 형태로 잡아 뒀어요. 문서가 정한 OpenAI-style messages 형식에 `/review-pr`의 기준 경로를 제가 끼워 넣은 재구성본이라, 아직 돌려 본 코드는 아니고요.

```typescript
// /review-pr 정상 경로의 기준 trajectory (문서 형식 위에 재구성, 미실행)
const referenceOutputs = [
  {
    role: "user",
    content: "/review-pr https://github.com/foo/bar/pull/34",
  },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        function: {
          name: "getPullRequest",
          arguments: JSON.stringify({ repo: "foo/bar", number: 34 }),
        },
      },
      {
        function: {
          name: "getPullRequestDiff",
          arguments: JSON.stringify({ repo: "foo/bar", number: 34 }),
        },
      },
    ],
  },
  { role: "tool", content: "diff --git a/src/a.ts ..." },
  { role: "assistant", content: "리뷰 결과 ..." },
];
```

이 fixture로 확인할 항목은 셋이에요. superset match가 `getPullRequestDiff` 호출 누락을 잡아내는지, 인자의 `repo`와 `number`가 정확히 맞는지, 짝이 되는 실패 fixture에서 diff 조회가 빠진 자리에 fallback evidence와 Slack 응답이 남는지를 봐요.

전후 비교의 기준선은 이미 레포에 있어요. `review-pull-request.usecase.spec.ts`는 실행이 돌려준 DTO의 `result`와 `modelUsed` 필드를 단언하는 식이라, 중간 도구 호출이 하나 빠지더라도 같은 DTO만 나오면 그대로 초록이에요. 그러니 “기존 spec은 통과인데 trajectory fixture는 실패”라는 조합이 나오면 그게 이 평가가 새로 잡아낸 몫이고, 두 쪽이 늘 같이 움직이면 fixture가 기존 단언을 옮겨 적은 것에 가까워요. 다만 이건 통과·실패라는 이진 신호라서 몇 퍼센트 좋아졌다는 식으로는 말할 수 없어요.

실패 경로에서는 볼 것이 더 늘어요. 실패한 실행이 agent-run에 어떤 상태와 input snapshot을 남기는지, 그 기록만으로 retry-run이 같은 입력을 재구성할 수 있는지, 같은 실행을 두 번 돌렸을 때 Slack 응답이나 GitHub 코멘트가 중복으로 나가지는 않는지까지 검증 항목에 넣어야 하거든요.

에이전트 품질은 최종 답변뿐 아니라 실행 경로에도 담겨 있어요. 그런데 경로를 fixture로 굳히는 순간 그 경로 자체가 바꾸기 어려워지니까, 무엇을 계약으로 삼고 무엇을 열어 둘지는 평가를 붙이기 전에 정해 두는 편이 나아요. 저는 `/review-pr`의 diff 조회 하나만 먼저 고정해 두고, 나머지는 실제로 깨지는 걸 본 다음에 늘릴 생각이에요.

## 참고 자료

아래 문서는 글을 올린 뒤 출처를 다시 짚으며 2026년 9월 8일에 모두 직접 열어 확인했어요.

- [AgentEvals — Readymade evaluators for agent trajectories](https://github.com/langchain-ai/agentevals)

  agentic application이 LLM에게 control flow의 자유를 준다는 정의와 블랙박스 서술, trajectory를 OpenAI-style messages로 표현하는 형식, trajectory match mode 네 가지, `createTrajectoryMatchEvaluator`와 `createTrajectoryLLMAsJudge`의 사용법, 설치 명령과 `OPENAI_API_KEY`, LangSmith Vitest·Jest 연동 예제가 이 문서에서 왔어요.

- [OpenEvals — Readymade evaluators for your LLM apps](https://github.com/langchain-ai/openevals)

  eval을 전통적인 소프트웨어 테스트에 빗대며 production 진입의 출발점으로 두는 서술, `createLLMAsJudge`가 이 패키지 소속이라는 사실, conciseness·correctness prompt와 exact match·embedding similarity 계열, OpenEvals에도 trajectory match가 들어 있다는 점의 근거예요.

- [Working with evals (OpenAI)](https://developers.openai.com/api/docs/guides/evals)

  IT ticket categorization 예시 curl과 `data_source_config`·`include_sample_schema`·템플릿 변수 두 개에 대한 설명의 출처예요. 이 페이지 자체가 종료 예정이라 아래 공지와 같이 봐야 해요.

- [Deprecations · 2026-06-03: Evals platform (OpenAI)](https://developers.openai.com/api/docs/deprecations)

  2026년 10월 31일 read-only, 2026년 11월 30일 종료라는 날짜 두 개가 여기 적혀 있어요. 같은 항목이 대체 경로로 [Moving from OpenAI Evals to Promptfoo](https://developers.openai.com/cookbook/examples/evaluation/moving-from-openai-evals-to-promptfoo) 예제를 안내하니, 위의 두 OpenAI 링크가 닫힌 뒤에는 그쪽이 후속 조사 자리예요.

- [How to evaluate your agent with trajectory evaluations (LangChain)](https://docs.langchain.com/langsmith/trajectory-evals)

  trajectory match mode 네 가지를 표로 정리한 문서예요. AgentEvals README와 같은 내용을 짧게 다루니, README가 길게 느껴지면 이쪽이 먼저 읽기 좋아요.

- [Evaluation concepts (LangChain)](https://docs.langchain.com/langsmith/evaluation-concepts)

  offline evaluation과 online evaluation의 구분, sampling rate와 filter, reference-free evaluator와 format validation 서술이 이 문서 기준이에요.

본문에서 이름으로만 부른 나머지 개념은 위에 적은 문서 안에서 확인한 범위까지만 썼어요. 제 레포에 실제로 얹어 돌린 결과는 아직 없고요.
