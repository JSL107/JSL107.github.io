---
title: "Mastra로 다시 나누는 AI 업무봇의 실행 구조"
description: "커진 AI 업무봇을 agent, workflow, memory, eval, observability로 분해하고 Mastra를 전면 교체가 아닌 비교 기준으로 활용하는 방법을 살펴본다."
pubDatetime: 2026-08-23T19:07:00+09:00
category: backend
---
Slack에서 LLM 기반 업무봇을 운영하다 보면 프롬프트와 모델 선택에만 머물지 않아요. 핵심은 실행 구조로 옮겨갑니다. 이미 커진 업무봇에서는 Mastra를 비교 기준으로 삼아 무엇을 agent로 남기고 무엇을 workflow로 고정할지 다시 판단할 수 있거든요.

## 모든 LLM 호출이 agent인 것은 아니다

도구 선택은 열려 있어요. 느슨한 자연어 요청을 보고 어떤 도구를 호출할지는 그때 판단해야 해요. GitHub에서 assigned task를 가져오고, 전일 plan과 사용자 입력을 합쳐 daily plan을 만드는 순서는 비교적 분명해요. PR 리뷰도 diff 수집, 컨텍스트 정리, 리뷰 생성, 근거 검증으로 나눌 수 있어요.

이 모두를 agent라고 부르면 편하지만, agent와 workflow의 경계를 나누지 않으면 추적과 평가가 어려워져요. 직접 만든 NestJS 서비스에서는 이 문제를 domain, usecase, queue, trace, eval, memory 같은 계층으로 나눠요. 자유도는 높지만 기능이 늘 때마다 실행 저장 방식과 입출력 검증, trace 범위, 평가 점수를 붙일 위치를 다시 정해야 하거든요.

### Mastra 는 그 경계를 어디에 긋나

Mastra는 AI 에이전트와 애플리케이션을 만드는 TypeScript framework를 표방해요. TypeScript로 정의하며 React, Next.js, Node.js 환경에 통합하거나 standalone server로 배포할 수 있어요. agent, tool, workflow, memory, eval, observability도 한 TypeScript 프로젝트에서 같은 방식으로 정의해요.

중요한 기준은 agent와 workflow의 차이예요. agent의 단계는 미리 정해지지 않으며, 모델이 어떤 tool을 몇 번 호출하고 언제 멈출지 판단하는 open-ended task에 맞아요. workflow는 순서와 데이터 흐름이 뚜렷해 실행 경로가 정해진 multi-step process에 어울려요. 모델에게 맡긴 결정과 개발자가 명시한 제어 흐름도 이 기준으로 나눌 수 있어요.

기존 NestJS 구조에서는 agent 실행, workflow 실행, queue job, trace, eval을 각각 직접 설계해요. Mastra는 agent와 workflow를 schema, storage, scorer, observability에 연결하는 primitive로 제시해요. 곧바로 교체하기보다 직접 만든 계층 중 무엇을 framework primitive로 옮길 수 있는지 비교하는 편이 안전해요.

## schema가 실행 단위를 작게 만든다

Mastra의 tool은 createTool()로 정의해요. id, description, inputSchema, outputSchema, execute를 함께 두죠. 자연어 문자열 하나가 아니라 검증 가능한 입출력 계약에 따라 tool을 호출한다는 점이 중요해요.

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

Slack command 입력, GitHub task 목록, PR diff 요약, worklog 산출물은 LLM에 통째로 던질 문자열이 아니에요. 검증 가능한 작은 데이터로 나누고, /worklog 전체를 하나의 agent 호출로 두는 대신 근거 수집 step과 초안 생성 step으로 쪼갤 수 있어요.

정량 근거 포함 여부는 scorer가 판단해요. Mastra는 이런 분해를 라이브러리 밖의 운영 관습이 아니라 framework의 기본 표현으로 만들잖아요.

## memory와 eval은 운영 중인 품질을 다룬다

Mastra memory는 message history를 append하는 데 그치지 않고 storage provider를 기반으로 삼아요. agent 호출 시 resource와 thread를 넘기면 같은 사용자나 대화 흐름을 이어갈 수 있어요. thread owner인 resourceId는 생성한 뒤 바꿀 수 없으며, 서로 다른 owner가 같은 thread ID를 재사용해서는 안 돼요.

```typescript
const response = await memoryAgent.generate('Remember my favorite color is blue.', {
  memory: {
    resource: 'user-123',
    thread: 'conversation-123',
  },
})
```

Observational Memory는 긴 대화의 오래된 메시지를 dense observations로 압축해 context는 작게 유지하면서 장기 기억은 그대로 보존해요.

Slack 멀티턴 업무봇에 매일의 plan과 누적 선호, 이전 리뷰 스타일, 반복되는 보고서 수정 요청을 모두 raw log로 넣으면 비용과 노이즈가 커져요. 반대로 너무 많이 버리면 지난 요청을 잊게 돼요. Mastra의 memory 모델은 이 문제를 thread, resource, storage 단위로 다시 보게 해요.

Evals는 별도 배치 테스트만 뜻하지 않아요. scorer를 agent나 workflow step에 붙여 live evaluation을 수행할 수 있어요. scorer는 model-graded, rule-based, statistical 방식으로 구성하며 보통 0에서 1 사이의 score를 반환해요. step-level scorer는 해당 step의 input과 output을 받아 중간 단계의 품질을 평가해요.

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

평가 기준은 구체적이어야 해요. /worklog에서는 정량 근거가 들어갔는지, /review-pr에서는 PR diff와 무관한 리뷰를 하지 않았는지 평가해요. agent/be-sre라면 스택트레이스의 실제 에러 위치를 근거로 삼았는지도 볼 수 있어요. 최종 답변만 읽는 게 아니라 실행 단계마다 품질 신호를 붙이는 구조죠.

## observability에서는 span 경계를 먼저 봐야 한다

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

중요한 건 hosted UI가 아니라 span의 경계예요. agent run, workflow step, tool call, model interaction이 같은 trace에 들어가면 실패한 Slack 응답의 원인을 모델과 tool 입력, 이전 workflow step으로 나눠 찾을 수 있어요.

agent-run, queue, trace, eval 저장소를 이미 갖췄다면 중복을 피해야 해요. trace ID 체계를 합칠지, 기존 실행 테이블을 source of truth로 둘지 먼저 정해야 해요. Mastra storage/exporter를 어디까지 쓸지도 결정해야 하니까요.

## 기존 시스템에서는 workflow 후보가 먼저 보인다

/today를 담당하는 agent/pm은 사용자의 오늘 입력과 GitHub assigned tasks, 전일 plan을 합쳐 daily plan을 만들어요.

완전히 open-ended하지 않으므로 전체를 agent로 처리하기보다 workflow로 감싸고 일부 판단만 agent에 맡기는 편이 맞아요. task 수집 step과 전일 plan 요약 step 다음에 daily plan 생성 agent step을 두고, 마지막에 결과 검증 scorer를 붙여요.

agent/work-reviewer의 업무 로그 생성은 자연어 품질이 중요하며, 정량 근거 포함 여부는 별도 scorer로 떼어내기 좋아요. agent/code-reviewer에서는 diff 입력, 리뷰 후보, 근거 매핑, scorer 결과를 모두 다루고 같은 trace에 남겨요. 이 기록을 바탕으로 PR diff와 관계없는 리뷰를 판별할 수 있어요.

자연어 멘션을 intent classifier로 보내 여러 worker dispatcher 중 하나로 넘기는 router는 agent 후보에 가까워요. 사용자의 요청이 열려 있어 어떤 agent가 맞는지 판단해야 하거든요.

agent/vacation은 자연어 파라미터 추출에만 LLM을 쓰고 실제 계산은 규칙에 맡겨요. agent로 키우지 않아도 tool이나 workflow step 안에서 작은 LLM 호출만 하면 충분해요.

## 전면 교체보다 작은 비교가 먼저다

Mastra는 Node.js-compatible environment에 배포할 수 있어요. standalone Mastra server로 띄우거나 기존 web framework와 통합할 수 있어요. runtime으로 Node.js v22.13.0 이상, Bun, Deno, Cloudflare를 제시하며 standalone server는 Hono를 기반으로 해요.

production에서는 workflow orchestration, cron scheduling, background tool execution을 API server와 분리한 dedicated worker process에서 실행할 수 있어요.

Slack Socket Mode, BullMQ, Prisma, 기존 router, retry 정책, CLI provider 격리, trace 저장소가 이미 있다면 Mastra의 primitive와 겹칠 수 있어요.

model router는 provider/model 문자열과 OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY 같은 환경변수를 사용해요. 구독형 CLI를 별도 child process로 격리한 시스템에는 바로 맞지 않을 수 있어요.

Mastra의 가치는 새 framework로 전면 교체하는 데 있지 않아요. 먼저 기존 agent-run trace에 Mastra식 span 경계를 적용할 수 있는지 확인해야 해요.

episodic-memory가 raw Slack log 대신 observation log를 만들 수 있는지도 살펴봐야 해요. agent/work-reviewer와 agent/code-reviewer에 step-level scorer를 붙일 수 있는지도 비교해야 해요.

AI 업무봇은 agent, workflow, memory, eval, observability라는 primitive를 기준으로 다시 나눠야 해요. 어느 실행을 agent로 남기고 workflow로 고정할지, 어느 품질을 scorer로 측정할지 정하는 일이 Mastra 도입 여부보다 먼저죠.
