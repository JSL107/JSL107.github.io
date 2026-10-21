---
title: "OpenTelemetry GenAI 규약으로 에이전트 장애 경계 추적하기"
description: "Slack 멀티 에이전트 시스템에서 모델 호출, 워크플로우, 에이전트 실행을 구분해 장애를 추적하는 방법을 검토합니다."
pubDatetime: 2026-10-21T09:00:00+09:00
category: infra
---

Slack에서 에이전트에게 일을 맡겼는데 응답이 늦거나 실패하면 겉으로는 “답이 안 왔다”는 것만 보입니다. 이 글은 OpenTelemetry GenAI Semantic Conventions의 공식 저장소와 GenAI span/event 문서, JavaScript 계측 문서를 바탕으로 TypeScript·NestJS 기반 Slack 멀티 에이전트 시스템의 실패 지점을 어떻게 구분할지 검토한 개념 글이에요. 직접 붙여 운영한 후기는 아닙니다.

## 실패한 에이전트 실행은 어디서 망가졌는지 말해 주지 않아요

그사이 시스템은 사용자 요청의 의도를 분류하고 담당 워커를 골라 LLM CLI를 호출했을 수 있어요. GitHub나 DB를 읽고 큐 worker에서 재시도했을 수도 있고요. 실패했다면 모델 호출이 늦었는지, 도구 실행이 막혔는지, 라우터가 처음부터 엉뚱한 워커를 골랐는지 알아야 해요.

기존 observability는 HTTP 요청, DB 쿼리, Redis, queue 같은 경계를 추적하는 데 익숙해요. NestJS 컨트롤러로 요청이 들어와 Prisma가 SQL을 날리고 Redis가 큐 상태를 바꾸는 흐름은 따라가기 쉽죠. 어려운 건 LLM과 에이전트의 경계예요. “모델을 불렀다”는 기록 하나로는 모델 호출, 에이전트 호출, 워크플로우 실행, 계획 수립, 도구 실행을 구분할 수 없어요.

## GenAI Semantic Conventions는 실행을 구분하는 공통 어휘예요

OpenTelemetry GenAI Semantic Conventions는 GenAI 실행을 gen_ai.*라는 공통 속성 이름으로 span, event, metric에 남기는 규칙이에요. 모델 호출은 chat, 임베딩은 embeddings, 검색은 retrieval, 도구 실행은 execute_tool, 에이전트 실행은 invoke_agent, 여러 에이전트나 GenAI 작업을 조합한 흐름은 invoke_workflow, 계획 수립은 plan으로 표현할 수 있어요. 이 이름이 gen_ai.operation.name에 들어갑니다. OpenAI API를 직접 쓰든, 로컬 framework를 감싸든, CLI provider를 호출하든 관측 레이어에서는 같은 기준으로 묶어 볼 수 있어요.

HTTP tracing으로는 “외부 프로세스를 실행했다”거나 “어떤 endpoint를 호출했다”는 정도까지 볼 수 있어요. 하지만 그 호출이 사용자 질문에 답하기 위한 최종 모델 호출인지, 계획을 세우는 중간 호출인지, 도구를 쓰기로 판단한 뒤 실행한 호출인지는 알기 어려워요. GenAI convention은 이런 의미를 span 이름과 속성으로 나눠 남깁니다. 모델 호출 span의 이름은 보통 {gen_ai.operation.name} {gen_ai.request.model}, 도구 실행 span은 execute_tool {gen_ai.tool.name} 형식이에요. 에이전트 내부 실행은 invoke_agent {gen_ai.agent.name}, 워크플로우는 invoke_workflow {gen_ai.workflow.name}, 계획 단계는 plan {gen_ai.agent.name}처럼 잡을 수 있어요.

실제 LLM 호출에서 metadata만 남기면 대략 이런 모양이에요. 값은 공식 non-normative 예시에 나온 필드와 예시 값을 그대로 가져왔고, 이 Slack 에이전트 시스템에서는 CLI provider를 감싸는 지점의 span 속성에 해당해요.

```json
{
  "span.name": "chat gpt-4",
  "gen_ai.provider.name": "openai",
  "gen_ai.operation.name": "chat",
  "gen_ai.request.model": "gpt-4",
  "gen_ai.request.max_tokens": 200,
  "gen_ai.request.top_p": 1.0,
  "gen_ai.response.id": "chatcmpl-9J3uIL87gldCFtiIbyaOvTeYBRA3l",
  "gen_ai.response.model": "gpt-4-0613",
  "gen_ai.usage.input_tokens": 52,
  "gen_ai.usage.output_tokens": 47,
  "gen_ai.usage.cache_read.input_tokens": 20,
  "gen_ai.response.finish_reasons": ["stop"]
}
```

이 span에는 요청한 provider와 모델, 실제 응답 모델, input/output token 수, 종료 시의 finish reason이 붙어요. 모델 호출이 Slack 응답 지연과 비용의 중심이라면 이 속성을 이용해 에이전트 종류별 평균 지연과 실패율을 나눠 볼 수 있어요.

## 에이전트 실행은 workflow, agent, plan으로 구분해요

GenAI agent span 문서는 에이전트를 LLM을 한 번 부르는 함수가 아니라 모델, reasoning과 planning, 외부 도구나 API 접근, 어느 정도 자율적인 task execution이 결합된 실행 단위로 봐요. 그래서 trace에는 누가 실행을 시작했고 어떤 계획을 세웠으며 어떤 도구를 썼는지가 드러나야 해요.

### 사용자에게 보이는 조합 흐름은 workflow로 잡을 수 있어요

invoke_workflow는 여러 에이전트나 GenAI operation을 조합한 프로세스를 실행할 때 쓰는 span이에요. 문서에서는 graph, orchestrator, multi-agent process를 예로 들고, 단독 에이전트 호출에는 붙이지 말라고 해요. agent나 tool의 내부 구현 때문에 runner가 잠깐 도는 경우도 사용자에게 드러나는 workflow로 보지 않습니다.

이 기준을 Slack 에이전트 시스템에 대입하면 자연어 멘션을 받아 의도를 분류하고 담당 실행 흐름으로 넘기는 라우터가 후보예요. 사용자는 “오늘 할 일 정리해 줘”라고 말하지만 시스템 안에서는 intent classification을 거쳐 dispatcher를 선택하고 실제 에이전트를 실행해요.

```json
{
  "span.name": "invoke_workflow idaeri-router",
  "gen_ai.operation.name": "invoke_workflow",
  "gen_ai.workflow.name": "idaeri-router"
}
```

이 예시는 도입 설계안이지 공식 문서의 완성 예시는 아니에요. 공식 문서가 정한 것은 invoke_workflow {gen_ai.workflow.name}라는 span name 형식과 gen_ai.operation.name=invoke_workflow의 의미예요. 실제 workflow name은 서비스에서 low-cardinality로 정해야 해요. Slack thread id나 사용자 문장을 이름에 넣으면 대시보드의 cardinality가 폭발합니다.

### 담당 실행 단위는 agent invocation으로 보는 편이 자연스러워요

invoke_agent는 같은 프로세스 안에서 GenAI agent를 호출할 때도 쓸 수 있어요. span kind는 INTERNAL이고, agent name이 있으면 invoke_agent {gen_ai.agent.name}, 없으면 invoke_agent를 권장해요. hosted agent만을 위한 규칙이 아니라 LangChain agents, CrewAI agents 같은 로컬 framework operation에도 적용할 수 있어요.

이 시스템에서 그날 할 일을 정리하거나 PR 리뷰를 만들거나 업무 로그를 생성하는 쪽은 각각 담당 실행 단위예요. 사용자의 Slack 요청이 라우터를 거쳐 이 실행 단위에 도달하면 invoke_agent span을 열 수 있어요. 그러면 trace tree에서 “라우터는 성공했지만 담당 에이전트가 실패했다”는 경우와 “담당 에이전트 안의 모델 호출이 실패했다”는 경우를 구분할 수 있어요.

모든 서비스 클래스를 agent로 부르면 안 돼요. 휴가 잔여일을 계산하는 기능이 대부분 결정론적 계산이고 LLM은 자연어 파라미터를 추출하는 데만 쓴다면, 전체 기능을 invoke_agent로 감싸기보다 LLM 추출 호출만 chat으로 남기는 편이 실제 구조에 더 가까워요.

### 계획 단계는 구분할 수 있을 때만 plan으로 남겨야 해요

plan span은 agent가 전략을 세우거나 task decomposition을 하는 단계예요. 문서는 planning을 일반 reasoning이나 일반 inference와 안정적으로 구분할 수 있을 때만 보고하라고 해요. 일반 답변 생성 prompt에 plan이라는 이름을 붙이면 trace를 읽는 사람은 그 단계에서 계획을 만들고 그 결과로 도구나 작업 span이 이어졌다고 잘못 해석할 수 있어요.

이 시스템에서 사용자 입력과 외부 task 목록을 받아 하루 계획을 만드는 실행은 plan 후보예요. 반면 PR 리뷰 생성은 계획보다 분석과 생성에 가깝고, 지연 원인 조회처럼 결정론적 조회가 중심인 흐름은 plan으로 부르기 어려워요.

## prompt와 response 캡처는 필요한 경우에만 켜요

GenAI convention은 prompt, user message, model output을 중요하게 다루지만 기본적으로 캡처하라고 권하지는 않아요. 내용이 크고 민감할 수 있기 때문이에요. Slack 메시지, PR diff, 업무 로그 초안에는 개인 정보와 업무 맥락이 쉽게 섞여요. 이를 trace backend에 그대로 넣으면 장애 분석 도구가 민감정보 저장소가 됩니다.

gen_ai.client.inference.operation.details event에는 chat history, request parameter, output detail, token usage, model/provider metadata, tool definition, system instruction 같은 세부 내용을 담을 수 있어요. requirement level은 opt-in이라서 실패를 재현하거나 샘플링해야 할 때만 켜는 편이 맞아요.

공식 예시의 입력 메시지는 이런 구조예요. 날씨 예시 자체보다 role과 parts, tool_call, tool_call_response를 같은 구조로 표현한다는 점이 중요해요. 이 시스템에서는 PR 정보를 읽는 도구 호출이나 업무 로그를 만들기 위해 외부 데이터를 조회하는 작업이 여기에 대응될 수 있어요.

```json
[
  {
    "role": "user",
    "parts": [
      {
        "type": "text",
        "content": "Weather in Paris?"
      }
    ]
  },
  {
    "role": "assistant",
    "parts": [
      {
        "type": "tool_call",
        "id": "call_VSPygqKTWdrhaFErNvMV18Yl",
        "name": "get_weather",
        "arguments": {
          "location": "Paris"
        }
      }
    ]
  },
  {
    "role": "tool",
    "parts": [
      {
        "type": "tool_call_response",
        "id": "call_VSPygqKTWdrhaFErNvMV18Yl",
        "response": "rainy, 57°F"
      }
    ]
  }
]
```

운영 시스템에서는 이 구조를 매번 trace attribute에 넣기보다 실패한 실행 중 일부만 별도 저장소에 보관하고 span에는 참조만 남기는 편이 더 안전해요. GenAI span 문서도 content upload hook이나 telemetry processing pipeline에서 외부 저장소로 넘기는 방법을 언급해요. 다만 공통 reference 기록 방식은 아직 TODO로 남아 있으니 DB schema에 고정하기보다 adapter 뒤에 숨기는 편이 좋아요.

## Node.js에서는 자동 계측과 수동 span의 경계를 나눠요

TypeScript·NestJS 시스템에서 @opentelemetry/auto-instrumentations-node는 여러 Node.js library/framework instrumentation을 묶어 주는 metapackage예요. HTTP, NestJS, Redis, DB 주변부부터 계측할 때 출발점으로 쓸 수 있어요.

```bash
npm install --save @opentelemetry/auto-instrumentations-node
```

SDK를 직접 초기화할 때 문서의 TypeScript 예시는 getNodeAutoInstrumentations()를 NodeSDK에 등록하는 형태예요.

```typescript
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  // ...
  // This registers all instrumentation packages
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
```

운영 봇의 모든 경계를 자동 계측으로 처리할 수는 없어요. OpenTelemetry JavaScript 문서는 metapackage가 dependency graph size를 늘린다고 설명해요. npm 패키지 문서에는 instrumentation configuration을 환경변수만으로는 아직 지원하지 않아 세부 설정이 필요하면 programmatic initialization을 해야 한다는 제한도 나와요.

먼저 HTTP/NestJS/Redis/Postgres처럼 표준 instrumentation이 잘 맞는 주변부를 계측해요. 그다음 CLI provider 호출 함수, 에이전트 실행을 감싸는 서비스, 자연어 요청을 담당 실행으로 넘기는 라우터 주변에 custom span을 추가합니다. 특히 Codex CLI 같은 외부 CLI를 감싸 쓰는 구조에서는 GenAI 자동 instrumentation이 내부 모델 호출을 알아서 잡아 주기 어려워요. 이 경계는 수동 span으로 남기는 편이 더 정확해요.

## 변경될 수 있는 이름은 adapter에 모아요

GenAI semantic conventions 문서의 상태는 Development예요. 공식 저장소도 core semantic conventions와 별도 GenAI conventions 저장소로 운영하고, human-readable 문서의 큰 부분은 model YAML에서 생성해요. 장기 SLA나 DB 컬럼 이름으로 바로 고정하기에는 조심스러운 단계예요.

애플리케이션 코드 곳곳에 gen_ai.usage.input_tokens 같은 문자열을 흩뿌리면 convention이 바뀌었을 때 수정할 곳을 찾기 어려워요. GenAiTelemetryAttributes 같은 작은 adapter나 mapper에 이름을 모으고 서비스 코드에서는 의미가 드러나는 함수로 호출하는 편이 좋아요.

도입 대상도 골라야 해요. Slack 요청 lifecycle을 기록하는 실행 관리 레이어, 자연어 의도 분류와 dispatcher 선택을 맡는 라우터, LLM CLI 실행 환경을 격리하고 실제 모델 호출을 수행하는 provider 경계에는 잘 맞아요. 큐 worker도 trace context가 이어진다면 지연과 재시도를 묶어 볼 수 있어요. 시세 수집, 크롤러, 결정론적 계산, 일반 CRUD처럼 GenAI 판단이 중심이 아닌 모듈은 기존 HTTP/DB/queue convention만으로 충분할 수 있어요.

## 다음에는 실제 코드 경계에서 확인해요

에이전트 실행을 감싸는 최상위 서비스에는 invoke_agent, 자연어 라우터에는 invoke_workflow, 계획이 명확한 워커에만 plan을 매핑해 볼 수 있어요. 다음 단계는 실제 trace에서 이 세 span의 부모·자식 관계와 실패 지점을 확인하는 거예요.

content capture 정책도 정해야 해요. 기본적으로 metadata와 token usage만 남기고 gen_ai.client.inference.operation.details event는 실패 샘플링이나 재현 모드에서만 켜는 편이 안전해요. prompt와 response를 직접 넣을지, 별도 저장소의 참조만 남길지는 운영 보안 기준을 먼저 정해야 해요.

출처:

- https://github.com/open-telemetry/semantic-conventions-genai
- https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai
- https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-spans.md
- https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-agent-spans.md
- https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-events.md
- https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-metrics.md
- https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/non-normative/examples-llm-calls.md
- https://opentelemetry.io/docs/languages/js/libraries
- https://www.npmjs.com/package/@opentelemetry/auto-instrumentations-node
