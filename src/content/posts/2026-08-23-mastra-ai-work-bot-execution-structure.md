---
title: "봇이 커지자 무엇이 agent이고 무엇이 workflow인지 흐려졌어요"
description: "Slack 업무봇에 기능을 더할 때마다 실행 기록과 평가 지점을 다시 정하게 돼요. Mastra가 경계를 긋는 방식을 기준 삼아 무엇을 모델 판단에 남기고 무엇을 정해진 순서로 굳힐지 다시 나눠 봤어요."
pubDatetime: 2026-08-23T19:07:00+09:00
category: backend
---
업무봇에 기능을 하나 더 붙였는데, 실행 기록을 어디에 남길지부터 다시 정하게 된 적 있나요? 저는 Slack에서 도는 개인 업무봇([personal_agents](https://github.com/JSL107/personal_agents))을 만들어 쓰는데, 워커를 추가할 때마다 같은 질문을 반복했어요. 입출력은 어디서 검증하고, 실행 기록은 어떤 단위로 남기고, 품질 점수는 어느 지점에 붙일까.

이 글에서 **agent**는 다음에 무엇을 할지 모델이 그때그때 정하는 실행을, **workflow**는 순서와 데이터 흐름을 사람이 미리 못 박아 둔 실행을 뜻해요. 둘을 가르지 않고 전부 "AI가 처리한다"로 묶어 두면 문제가 생겨요. 결과가 이상할 때 **모델의 판단이 틀린 건지 순서가 잘못된 건지 구분할 수 없거든요.**

읽는 분이 가져갈 건 경계를 긋는 기준 하나예요. [Mastra](https://mastra.ai)라는 TypeScript 프레임워크가 이 경계를 어디에 긋는지 보고, 그 기준으로 제 봇의 워커를 다시 분류해 봤어요. **아래 Mastra 설명은 공식 문서와 예제 코드를 2026년 9월 7일에 읽고 정리한 것이지, 붙여서 돌려본 결과가 아니에요.** 도입을 권하는 글도 아니고요. 뒤쪽에서는 오히려 제 시스템에 안 맞는 지점을 적었어요.

## 모든 LLM 호출이 agent인 것은 아니다

어떤 도구를 호출할지 미리 정할 수 없는 일이 있어요. 느슨한 자연어 요청이 그런데, 요청을 본 그때라야 판단이 서거든요.

반대로 순서가 이미 정해진 일도 있어요. GitHub에서 assigned task를 가져오고 전일 plan과 사용자 입력을 합쳐 daily plan을 만드는 순서는 비교적 분명하고, PR 리뷰도 diff 수집과 컨텍스트 정리, 리뷰 생성, 근거 검증으로 나눌 수 있거든요.

이 모두를 agent라고 부르면 편하지만, 경계를 나누지 않으면 추적과 평가가 어려워져요. 제가 만든 NestJS 서비스에서는 이 문제를 domain, usecase, queue, trace, eval, memory 같은 계층으로 나눠 뒀어요. 자유도는 높지만 기능이 늘 때마다 실행 저장 방식과 입출력 검증, trace 범위, 평가 점수를 붙일 위치를 다시 정해야 하거든요. 도입부에서 말한 반복이 여기서 나와요.

### Mastra 는 그 경계를 어디에 긋나

Mastra에서 눈여겨볼 건 agent, tool, workflow, memory, eval, observability를 한 TypeScript 프로젝트에서 같은 방식으로 정의한다는 점이에요. AI 에이전트와 애플리케이션을 만드는 TypeScript framework를 표방하고, TypeScript로 정의하며 React, Next.js, Node.js 환경에 통합하거나 standalone server로 배포할 수 있어요.

중요한 기준은 agent와 workflow의 차이예요. agent의 단계는 미리 정해지지 않으며, 모델이 어떤 tool을 몇 번 호출하고 언제 멈출지 판단하는 open-ended task에 맞아요. workflow는 순서와 데이터 흐름이 뚜렷해 실행 경로가 정해진 multi-step process에 어울려요. 모델에게 맡긴 결정과 개발자가 명시한 제어 흐름도 이 기준으로 나눌 수 있어요.

여기서 **tool**은 모델이 호출할 수 있는 함수 하나를, **primitive**는 프레임워크가 미리 만들어 둔 기본 구성 요소를 가리켜요. 기존 NestJS 구조에서는 agent 실행, workflow 실행, queue job, trace, eval을 각각 직접 설계해요. Mastra는 agent와 workflow를 schema, storage, scorer, observability에 연결하는 primitive로 제시해요. 곧바로 교체하기보다 직접 만든 계층 중 무엇을 framework primitive로 옮길 수 있는지 비교하는 편이 안전해요.

## schema가 실행 단위를 작게 만든다

tool 호출이 자연어 문자열 하나가 아니라 검증 가능한 입출력 계약을 따른다는 점이 중요해요. 여기서 **schema**는 어떤 값이 들어오고 나가는지 코드로 못 박은 명세예요. Mastra의 tool은 createTool()로 정의하고 id, description, inputSchema, outputSchema, execute를 함께 둬요.

```typescript
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

export const weatherTool = createTool({
  id: 'get-weather',
  description: 'Get current weather for a location',
  inputSchema: z.object({
    location: z.string().describe('City name'),
  }),
  outputSchema: z.object({
    location: z.string(),
    temperatureCelsius: z.number(),
    conditions: z.string(),
  }),
  execute: async ({ location }) => {
    return {
      location,
      temperatureCelsius: 21,
      conditions: 'sunny',
    }
  },
})
```

이 예시는 문서의 것을 그대로 옮긴 것이라 날씨 조회 자체가 요지는 아니에요. `inputSchema`가 있으면 **모델이 엉뚱한 모양의 값을 넘겼을 때 tool 안이 아니라 경계에서 걸린다**는 점이 핵심이에요.

createStep()으로 workflow step의 inputSchema, outputSchema, execute를 함께 정의해요. createWorkflow()에서 workflow 자체의 입출력 schema를 정하고 .then(step)으로 연결한 뒤 .commit()으로 확정해요. Zod 외에 Standard JSON Schema 계열인 Valibot, ArkType도 쓸 수 있어요.

```typescript
import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'

const step1 = createStep({
  id: 'step-1',
  inputSchema: z.object({
    message: z.string(),
  }),
  outputSchema: z.object({
    formatted: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { message } = inputData

    return {
      formatted: message.toUpperCase(),
    }
  },
})
```

제 봇에 대보면 Slack command 입력, GitHub task 목록, PR diff 요약, 업무 로그 산출물은 LLM에 통째로 던질 문자열이 아니라 검증 가능한 작은 데이터로 나눌 수 있어요. 업무 로그를 쓰는 워커를 예로 들면 지금은 한 번의 모델 호출로 끝나는데, 근거 수집 step과 초안 생성 step으로 쪼갤 수 있어요. 그러면 결과가 나빴을 때 근거가 부족했는지 문장이 나빴는지 나눠 볼 수 있고요.

정량 근거가 실제로 들어갔는지는 뒤에 나올 scorer가 판단해요. Mastra는 이런 분해를 라이브러리 밖의 운영 관습이 아니라 framework의 기본 표현으로 만든다는 게 차이예요.

## memory는 무엇을 이어 붙일지의 문제다

대화를 이어 가려면 지난 메시지를 어딘가 들고 있어야 해요. 그런데 전부 들고 있으면 비용이 커지고, 많이 버리면 지난 요청을 잊어요. 어디서 끊어야 할까요?

Mastra memory는 message history를 append하는 데 그치지 않고 storage provider를 기반으로 삼아요. agent 호출 시 resource와 thread를 넘기면 같은 사용자나 대화 흐름을 이어갈 수 있어요. **resource**는 사용자처럼 오래 유지되는 주체를, **thread**는 그 안의 개별 대화를 가리켜요. thread owner인 resourceId는 생성한 뒤 바꿀 수 없으며, 서로 다른 owner가 같은 thread ID를 재사용해서는 안 돼요. 문서는 재사용하면 조회할 때 오류가 난다고 못 박아요.

```typescript
const response = await memoryAgent.generate('Remember my favorite color is blue.', {
  memory: {
    resource: 'user-123',
    thread: 'conversation-123',
  },
})
```

Observational Memory는 긴 대화의 오래된 메시지를 dense observations로 압축해 context는 작게 유지하면서 장기 기억은 그대로 보존해요. 배경에서 도는 별도 agent가 그 압축을 맡는 구조라, 압축 자체도 모델 호출이라는 비용이 따라온다는 뜻이기도 해요.

제 봇으로 돌아오면, 매일의 plan과 누적 선호, 이전 리뷰 스타일, 반복되는 보고서 수정 요청을 모두 raw log로 넣으면 비용과 노이즈가 커져요. 반대로 너무 많이 버리면 지난 요청을 잊게 되고요. 앞의 질문에 Mastra가 주는 답은 얼마나 남길지가 아니라 **무엇을 기준으로 묶을지**예요. thread, resource, storage라는 단위가 그 기준이죠.

## eval은 최종 답변이 아니라 중간 단계에 붙는다

Evals는 별도 배치 테스트만 뜻하지 않아요. **scorer**는 출력에 점수를 매기는 자동 채점기인데, agent나 workflow step에 붙여 live evaluation을 수행할 수 있어요. scorer는 model-graded, rule-based, statistical 방식으로 구성하며 보통 0에서 1 사이의 score를 반환해요. step-level scorer는 해당 step의 input과 output을 받아 중간 단계의 품질을 평가해요.

```typescript
const contentStep = createStep({
  id: "content-step",
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ content: z.string() }),
  scorers: {
    customStepScorer: {
      scorer: customStepScorer(),
      sampling: {
        type: "ratio",
        rate: 1,
      },
    },
  },
  execute: async ({ inputData }) => {
    return { content: await generateContent(inputData.topic) };
  },
});
```

`sampling`의 `rate: 1`은 모든 실행을 채점한다는 뜻이에요. 채점도 모델 호출이라 비용이 붙으니, 실제로는 이 비율을 낮춰 일부만 재는 선택지가 있다는 걸 이 필드가 알려줘요.

평가 기준은 구체적이어야 하는데, 업무 로그를 쓰는 워커라면 정량 근거가 들어갔는지, PR 리뷰를 만드는 워커라면 diff와 무관한 지적을 하지 않았는지 보면 돼요. 최종 답변만 읽는 게 아니라 실행 단계마다 품질 신호를 붙이는 구조죠.

## observability에서는 span 경계를 먼저 봐야 한다

Slack 응답 하나가 이상하게 나왔을 때, 모델이 잘못 판단한 건지 tool에 넘긴 값이 틀린 건지 어떻게 가릴까요? 그걸 가르는 게 span 경계예요. **span**은 실행 한 구간의 시작과 끝을 묶은 기록 단위고, 여러 span이 모여 하나의 trace가 돼요.

Mastra의 observability는 tracing, logging, metrics, feedback, storage를 한 흐름으로 묶어요. tracing은 agent run, workflow execution, tool call, model interaction을 span으로 기록해요.

실행은 span으로 남고, metrics는 span이 끝날 때 duration, token count, estimated cost를 추출해요. log는 traced context 안에서 trace/span ID와 연결되며, feedback도 trace나 span에 붙일 수 있어요.

```typescript
import { Mastra } from '@mastra/core/mastra'
import { LibSQLStore } from '@mastra/libsql'
import { DuckDBStore } from '@mastra/duckdb'
import { MastraCompositeStore } from '@mastra/core/storage'
import {
  Observability,
  MastraStorageExporter,
  MastraPlatformExporter,
  SensitiveDataFilter,
} from '@mastra/observability'

export const mastra = new Mastra({
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: 'file:./mastra.db',
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new MastraStorageExporter(),
          new MastraPlatformExporter(),
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(),
        ],
        logging: {
          enabled: true,
          level: 'info',
        },
      },
    },
  }),
})
```

설정이 길지만 읽을 곳은 두 군데예요. `exporters`는 기록을 어디로 보낼지 정하고, `spanOutputProcessors`의 `SensitiveDataFilter`는 기록에 남기기 전에 민감한 값을 걸러낼 자리를 가리켜요. 실행 기록에 토큰이나 개인정보가 그대로 실리는 사고를 막는 지점이 여기라는 뜻이에요.

중요한 건 hosted UI가 아니라 span의 경계예요. agent run, workflow step, tool call, model interaction이 같은 trace에 들어가면 실패한 Slack 응답의 원인을 모델과 tool 입력, 이전 workflow step으로 나눠 찾을 수 있어요. 앞의 질문에 답이 되는 자리가 바로 여기죠.

다만 실행 기록 테이블과 작업 큐, trace, 평가 결과를 이미 갖춘 시스템이라면 중복을 피해야 해요. trace ID 체계를 합칠지, 기존 실행 테이블을 정본으로 둘지부터 정해야 하죠. 그 답이 나와야 Mastra의 storage와 exporter를 어디까지 쓸지 결정할 수 있어요.

## 기존 시스템에서는 workflow 후보가 먼저 보인다

이 기준으로 제 봇의 워커를 다시 나눠 봤어요.

그날 할 일을 정리하는 워커는 사용자의 오늘 입력과 GitHub assigned tasks, 전일 plan을 합쳐 daily plan을 만들어요. 완전히 open-ended하지 않으므로 전체를 agent로 처리하기보다 workflow로 감싸고 일부 판단만 agent에 맡기는 편이 맞아요. task 수집 step과 전일 plan 요약 step 다음에 daily plan 생성 agent step을 두고, 마지막에 결과 검증 scorer를 붙이는 식이죠.

업무 로그를 쓰는 워커는 자연어 품질이 중요하며, 정량 근거 포함 여부는 별도 scorer로 떼어내기 좋아요. PR 리뷰를 만드는 워커라면 diff 입력, 리뷰 후보, 근거 매핑, scorer 결과를 한 trace에 모아 두는 구성이 자연스러워요. 이 기록을 바탕으로 PR diff와 관계없는 리뷰를 판별할 수 있어요.

반대로 자연어 멘션을 받아 어느 워커로 보낼지 정하는 라우터는 agent 후보에 가까워요. 사용자의 요청이 열려 있어 어떤 워커가 맞는지 그때 판단해야 하거든요.

휴가 일수를 계산하는 워커는 자연어 파라미터 추출에만 LLM을 쓰고 실제 계산은 규칙에 맡겨요. agent로 키우지 않아도 tool이나 workflow step 안에서 작은 LLM 호출만 두면 될 것 같은데, 문서를 보고 그려 본 그림이지 붙여서 확인한 건 아니에요.

## Mastra의 primitive는 이미 있는 것들과 겹친다

여기까지 잘 맞는 이야기만 했으니, 안 맞는 쪽도 적어야 공평하겠죠.

Mastra는 Node.js-compatible environment에 배포할 수 있어요. standalone Mastra server로 띄우거나 기존 web framework와 통합할 수 있고요. runtime으로 Node.js v22.13.0 이상, Bun, Deno, Cloudflare를 제시하며 standalone server는 Hono를 기반으로 해요. production에서는 workflow orchestration, cron scheduling, background tool execution을 API server와 분리한 dedicated worker process에서 실행할 수 있어요.

문제는 그 목록이 제 시스템에 이미 있는 것들과 거의 그대로 겹친다는 점이에요. Slack Socket Mode 연결, 작업 큐(BullMQ), Prisma, 자연어 요청을 워커로 보내는 라우터, retry 정책, CLI provider 격리, 실행 기록 저장소가 이미 돌고 있어요. 새 primitive를 얹는 게 아니라 **같은 일을 하는 층이 두 겹이 되는** 상황이죠.

더 걸리는 건 모델 호출 방식이에요. Mastra의 model router는 provider/model 문자열과 OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY 같은 환경변수를 사용해요. 그런데 제 봇은 API 키가 아니라 **구독형 CLI를 별도 child process로 띄워** 모델을 부르고, 그 자식 프로세스에 넘기는 환경변수를 일부러 최소한으로 깎아요. 인증 방식 자체가 다르니 model router를 그대로 쓰는 경로는 지금 구조에서 막혀 있어요.

그래서 이 글의 결론은 "도입하자"가 아니라, 겹치는 층을 두 겹으로 만들지 않으면서 가져올 수 있는 게 무엇이냐는 질문이에요.

## 도입 여부는 무엇으로 판정할까

지금은 실측 결과가 없어요. 붙여서 돌려본 적이 없으니 얼마나 좋아졌다고 말할 근거가 제게는 없죠. 대신 무엇을 재면 판정이 되는지는 미리 정할 수 있으니, 나중에 확인할 때 아래 셋을 같은 기준으로 재면 돼요.

| 무엇을 | 지금 값 | 도입 후 비교 기준 |
| --- | --- | --- |
| 실패 원인을 가르는 데 걸리는 시간 | 미측정 | 같은 실패 사례 5건에서 원인 지점을 찾기까지의 시간 |
| 중간 단계 품질 신호 | 최종 산출물에만 있음 | step 단위 scorer가 붙은 워커 수 |
| 실행 기록의 중복 | 실행 테이블 1벌 | 도입 후 기록 저장소가 몇 벌인지 |

셋 중 마지막이 가장 중요한데, 앞의 둘이 좋아져도 기록이 두 벌이 되면 어느 쪽이 정본인지가 새 문제로 생기거든요. 그래서 도입을 시험한다면 **워커 하나에만 얹어 기록이 한 벌로 유지되는지부터** 보는 게 맞아요.

## 마무리

처음 질문은 기능을 더할 때마다 실행 기록과 평가 지점을 다시 정하게 된다는 것이었어요. 원인은 무엇이 모델 판단이고 무엇이 정해진 순서인지 가르지 않은 채 층을 쌓았기 때문이고요.

Mastra의 기준을 빌려 다시 나눠 보니 제 봇에서는 **workflow 후보가 먼저 보였어요.** 그날 할 일을 정리하는 워커와 PR 리뷰를 만드는 워커는 순서가 이미 정해져 있어서, 전체를 모델에 맡기는 대신 순서를 굳히고 판단이 필요한 자리에만 모델을 두는 편이 맞았어요.

이 정리는 Mastra를 안 쓰기로 해도 남아요. 어느 실행을 agent로 남기고 workflow로 고정할지, 어느 품질을 scorer로 측정할지 정하는 일은 프레임워크 선택보다 앞에 있으니까요. 인증 방식이 안 맞아 model router를 그대로 못 쓴다는 것도 그 정리 덕분에 미리 알았고요.

다음에 해볼 만한 걸 하나 남겨요. 지금 쓰는 봇에서 워커 하나를 골라 **입력과 출력을 schema로 적어 보세요.** 적히지 않는 자리가 있다면 그곳이 모델 판단에 맡긴 부분이고, 전부 적힌다면 그 워커는 workflow로 굳혀도 되는 후보예요.

## 출처

제품 동작과 제한은 문서 확인 시점과 버전에 따라 달라질 수 있어요. 아래 자료는 2026년 9월 7일에 직접 확인했어요. 코드 예시는 문서의 것을 그대로 옮겼고, 제 시스템에 대입한 부분은 문서가 아니라 제 판단이에요.

| 제목 | 자료 링크 | 본문 주장 대응 | 확인일 |
| --- | --- | --- | --- |
| Agents vs. Workflows | [직접 링크](https://mastra.ai/learn/agents-vs-workflows) | agent는 단계가 미리 정해지지 않은 open-ended task, workflow는 실행 경로가 정해진 multi-step process | 2026-09-07 |
| Agents overview | [직접 링크](https://mastra.ai/docs/agents/overview) | agent가 memory·logging·observability 같은 공유 자원에 접근하는 구조 | 2026-09-07 |
| Workflows overview | [직접 링크](https://mastra.ai/docs/workflows/overview) | createStep의 inputSchema·outputSchema, createWorkflow의 .then과 .commit | 2026-09-07 |
| Tools and MCP | [직접 링크](https://mastra.ai/docs/agents/using-tools-and-mcp) | createTool의 id·description·inputSchema·execute 구성 | 2026-09-07 |
| Memory overview | [직접 링크](https://mastra.ai/docs/memory/overview) | resource와 thread의 역할, resourceId 변경 불가, thread ID 재사용 시 조회 오류, Observational Memory의 압축 방식 | 2026-09-07 |
| Evals overview | [직접 링크](https://mastra.ai/docs/evals/overview) | scorer의 model-graded·rule-based·statistical 방식과 0~1 점수, 과거 trace·span 채점 | 2026-09-07 |
| Deployment overview | [직접 링크](https://mastra.ai/docs/deployment/overview) | Node.js v22.13.0 이상·Bun·Deno·Cloudflare 지원, Hono 기반 standalone server, worker process 분리 권고 | 2026-09-07 |
| AI Agent Observability | [직접 링크](https://mastra.ai/ai-agent-observability) | agent run·tool call·memory 조작을 기록하고 token·latency를 남기는 구조 | 2026-09-07 |
