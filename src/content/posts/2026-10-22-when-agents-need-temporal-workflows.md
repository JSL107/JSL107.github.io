---
title: "에이전트의 장기 실행에 Temporal이 필요한 순간"
description: "Temporal의 실행 이력이 장기 실행 에이전트에서 LLM 판단과 외부 부수 효과를 어떻게 보존하는지 살펴본다."
pubDatetime: 2026-10-22T19:45:00+09:00
category: infra
---

워커가 재시작돼도 이미 끝난 LLM 판단과 외부 부수 효과를 어떻게 보존할 수 있을까요? Temporal의 Durable Execution을 TypeScript 기반 Slack 멀티 에이전트 시스템에 대입해 봤어요. Temporal의 TypeScript 문서, AI SDK by Vercel 통합 문서, 공식 블로그와 샘플 코드를 읽고 정리한 개념 검토예요. 직접 운영에 적용한 후기는 아니에요.

## Slack 응답 하나가 며칠짜리 실행이 될 때

밤에는 보고서 초안을 자동으로 만들고, 아침에 사람이 승인하면 발행 후보로 넘기는 에이전트가 있다고 해볼게요. 그사이 LLM이 오늘 한 일을 요약하고, GitHub나 업무 기록을 읽고, Slack에 확인 메시지를 보내요. 여기까지는 큐와 워커로도 충분히 만들 수 있어요. 실패한 잡을 다시 넣고, 워커가 죽으면 다른 워커가 가져가면 되니까요.

그런데 “다시 실행”이 언제나 좋은 답은 아니에요. LLM이 이미 후보를 골랐고, Slack에 승인 요청을 보냈고, 외부 API에 기록까지 남겼다면 어떻게 해야 할까요? 워커가 재시작됐다는 이유로 LLM에게 같은 판단을 다시 묻거나 승인 메시지를 또 보내고, 외부 시스템에 같은 결과를 두 번 쓰면 운영자는 큐 재시도보다 더 어려운 문제를 만나게 돼요.

## 큐의 재시도와 Workflow의 재생

BullMQ 같은 큐는 “할 일”을 워커에게 안정적으로 전달하는 데 강해요. 워커가 실패하면 retry 정책에 따라 잡을 다시 실행하고, 여러 워커가 일을 나눠 처리할 수도 있죠. 짧고 독립적인 작업에는 단순해서 좋은 모델이에요. PR 하나를 읽어 리뷰 초안을 만들거나 이슈 하나에 라벨을 붙이는 작업처럼 입력과 출력이 비교적 분명한 경우가 그렇습니다.

하지만 장기 실행 에이전트는 잡 하나보다 “중간 상태를 가진 절차”에 가까워요. LLM 호출과 도구 호출, 사람의 승인 대기, 타임아웃, 재시도, 알림, 후속 작업이 한 흐름으로 이어지죠. 이때는 “잡을 잃지 않는 것”만큼 “이미 끝난 단계를 다시 하지 않는 것”이 중요해요.

Temporal의 Durable Execution은 Workflow가 실행되는 동안 어떤 Activity를 어떤 입력으로 실행해 어떤 결과를 냈는지, 어떤 signal을 받았는지 Event History에 남겨요. 프로세스가 죽으면 Workflow 코드는 처음부터 재생되지만, 이미 기록된 Activity 결과는 다시 실행하지 않고 이력에서 복원해요. 겉으로는 코드가 같은 자리를 다시 지나는 듯해도 실제 LLM이나 외부 API를 다시 호출하는 대신 과거 결과를 쓰는 거예요.

LLM은 같은 프롬프트에도 다른 판단을 내릴 수 있고, 외부 도구는 호출하는 것만으로 부수 효과를 만들 수 있어요. 그래서 재시작할 때 같은 프롬프트로 다시 호출하는 방식은 안전하지 않아요. LLM은 처음 실행할 때 자유롭게 판단하되, 한 번 내린 판단은 실행 이력에 고정돼요.

## 결정론이 에이전트의 행동을 제한하는 것은 아니에요

Temporal이 “Workflow는 deterministic해야 한다”고 할 때, 에이전트가 늘 정해진 경로만 따라야 한다는 뜻은 아니에요. 같은 이력을 재생한 Workflow 코드가 같은 순서로 명령을 만들어야 한다는 뜻에 가까워요.

LLM 호출, API 호출, 브라우저 작업, MCP 도구 호출처럼 결과가 달라질 수 있는 일은 Activity로 빼야 해요. Workflow는 Activity를 언제 호출하고 그 결과를 다음 단계로 어떻게 넘길지 맡아요. Activity 결과가 Event History에 기록되고 나면, 복구할 때 그 결과를 얻으려고 LLM을 다시 부르지 않아요.

모델이 실행 중에 “날씨 도구가 필요하다”고 판단할 수도 있어요. 그 판단과 도구 호출 결과가 실행 이력에 남으면, 재생할 때 모델에게 다시 물어 다른 도구를 고르지 않아요. 처음 실행할 때의 행동은 동적이지만, 복구할 때는 이미 남은 이력을 따라가는 거죠. 큐가 작업 전달과 재시도의 경계라면, Workflow는 시간에 걸친 의사결정과 부수 효과의 경계예요.

## TypeScript에서 AI SDK와 도구 호출 연결하기

보통 Temporal Workflow 안에서는 비결정적 작업을 직접 실행할 수 없어서 LLM 호출을 Activity로 감싸야 해요. @temporalio/ai-sdk 플러그인은 AI SDK의 generateText, streamText, streamObject 호출을 내부에서 Activity로 감싸는 패턴을 제공해요. 개발자는 Workflow 안에서 AI SDK를 쓰는 것과 비슷한 형태로 코드를 작성하고, Worker에 플러그인을 붙여 실제 모델 provider를 연결해요.

공식 샘플의 Worker 설정은 이렇게 생겼어요.

```typescript
import path from 'node:path';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { AiSdkPlugin } from '@temporalio/ai-sdk';
import { openai } from '@ai-sdk/openai';
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function run() {
  const connection = await NativeConnection.connect({
    address: 'localhost:7233',
  });

  const worker = await Worker.create({
    plugins: [
      new AiSdkPlugin({
        modelProvider: openai,
      }),
    ],
    connection,
    namespace: 'default',
    taskQueue: 'ai-sdk',
    workflowsPath: require.resolve('./workflows'),
    activities,
  });

  await worker.run();
}
```

모델 credential과 provider 설정은 Worker 쪽에 있어요. Workflow를 시작하는 클라이언트는 같은 namespace와 task queue로 실행 요청만 보내므로 모델 API key를 알 필요가 없어요. 지금 운영 중인 Slack 에이전트 시스템에 대입하면, Slack 요청을 받는 서버가 “장기 실행이 필요한 작업”을 Workflow로 시작하고 실제 LLM 호출은 별도의 Worker가 맡는 구조에 가까워요.

간단한 LLM 호출도 직접 provider를 쓰는 대신 Workflow-safe provider를 쓰는 형태예요.

```typescript
import { generateText } from 'ai';
import { temporalProvider } from '@temporalio/ai-sdk/workflow';

export async function haikuAgent(prompt: string): Promise<string> {
  const result = await generateText({
    model: temporalProvider.languageModel('gpt-4o-mini'),
    prompt,
    system: 'You only respond in haikus.',
  });

  return result.text;
}
```

예제에서는 하이쿠를 만들지만, 이 시스템에 대입하면 “오늘 할 일 초안 만들기”나 “업무 로그 초안 만들기”처럼 LLM 판단 결과를 나중에 다시 써야 하는 호출에 해당해요. 모델 이름 문자열은 Worker의 modelProvider로 전달되고, 호출 결과는 Activity 이력에 남아요.

에이전트는 도구를 고르고 외부 데이터를 읽은 뒤 그 결과를 다시 모델에 넣어요. AI SDK의 tool calling은 이 흐름을 표현할 수 있지만, Temporal 안에서는 도구의 execute도 Workflow 규칙을 따라야 해요. 네트워크 요청이나 외부 API 호출은 Activity나 Child Workflow로 빼야 하죠. 공식 샘플은 날씨 조회를 Activity로 만들고, Workflow에서 proxyActivities로 가져와 도구 실행 함수에 연결해요.

```typescript
// activities.ts
export async function getWeather(input: {
  location: string;
}): Promise<{ city: string; temperatureRange: string; conditions: string }> {
  return {
    city: input.location,
    temperatureRange: '14-20C',
    conditions: 'Sunny with wind.',
  };
}
```

```typescript
// workflows.ts
import { generateText, stepCountIs, tool } from 'ai';
import { temporalProvider } from '@temporalio/ai-sdk/workflow';
import { proxyActivities } from '@temporalio/workflow';
import z from 'zod';
import type * as activities from './activities';

const { getWeather } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function toolsAgent(question: string): Promise<string> {
  const result = await generateText({
    model: temporalProvider.languageModel('gpt-4o-mini'),
    prompt: question,
    system: 'You are a helpful agent.',
    tools: {
      getWeather: tool({
        description: 'Get the weather for a given city',
        inputSchema: z.object({
          location: z.string().describe('The location to get the weather for'),
        }),
        execute: getWeather,
      }),
    },
    stopWhen: stepCountIs(5),
  });

  return result.text;
}
```

Slack 기반 업무 자동화 시스템이라면 날씨 도구 대신 “PR diff 읽기”, “이슈 목록 가져오기”, “이전 계획 조회하기”, “승인 메시지 보내기” 같은 작업이 들어가요. 특히 Slack 메시지는 중복 전송되면 사용자가 바로 알아차리는 부수 효과라 실행 이력과 함께 다뤄야 해요. 반면 짧고 다시 해도 되는 단순 상태 조회나 캐시할 수 있는 목록 조회는 기존 큐나 서비스 호출로 충분할 수 있어요.

## 스트리밍은 Slack의 사용 방식에 맞춰 검증해야 해요

Temporal AI SDK 샘플에는 streamText를 Workflow와 연결하는 예시가 있어요. 모델은 Activity에서 호출하고, 각 delta를 Workflow Stream topic에 publish해요. Workflow 안에서는 최종 텍스트를 영속적으로 다시 조립하고, 외부 consumer는 workflow id로 topic을 구독해 토큰을 렌더링해요.

Slack 메시지를 토큰 단위로 계속 갱신하려면 UX와 rate limit을 함께 고려해야 해요. 지금 시스템의 Slack 명령 대부분은 먼저 “처리 중”이라고 응답한 뒤 최종 결과로 한 번 교체하는 패턴이면 충분해요. 스트리밍은 긴 보고서 초안이나 코드 리뷰처럼 사용자가 대기 시간을 크게 느끼는 곳에서 따로 검증하는 편이 안전해요. 스트리밍 중 Worker가 죽어도 최종 결과 조립이 복구되는지, 외부 subscriber가 마지막 delta를 놓치지 않도록 signal을 주고받는 방식이 Slack 업데이트 모델에 맞는지도 살펴봐야 해요.

## 첫 적용 후보는 승인 대기가 있는 실행

이 시스템에서 Durable Execution이 가장 먼저 필요한 곳은 사람이 중간에 참여하는 작업이에요. 저녁에 하루 회고를 만들고 블로그나 경력 기록 후보를 고른 뒤 사용자의 승인을 기다리는 흐름이 그렇죠. “후보 생성 → 알림 → 승인 대기 → 후속 실행”이 이어지는 동안 프로세스가 재시작돼도 같은 후보와 승인 상태를 유지해야 해요.

진행 상황이나 지연 원인을 묻는 기능도 관련이 있어요. 현재 진행 중인 일과 승인 대기, 실패한 실행을 묶어 답해야 하니 내부 상태가 일관돼야 하죠. 다만 이 기능은 “긴 실행”보다 “여러 실행 상태를 읽는 조회”에 가까울 때도 많아요. 그런 경우 도입 대상은 조회 기능 자체가 아니라 조회 대상인 장기 실행 작업들이에요.

PR diff를 읽고 LLM으로 리뷰를 만드는 작업은 실패해서 다시 실행해도 치명적인 부수 효과가 적어요. 토큰 비용과 시간이 아깝기는 하지만, 승인 대기나 외부 기록 중복에 비하면 구조적인 위험은 작아요. webhook으로 들어온 이슈에 자동으로 라벨을 붙이는 작업은 중복 side effect를 따져볼 만하지만, 작업이 짧고 idempotency key로 막기 쉽다면 Workflow까지 도입할 필요는 없어요.

Workflow와 Activity의 경계를 나눠야 하고, Workflow 코드가 deterministic하게 재생될 수 있는지도 살펴야 해요. 지금 서비스 코드 전체를 NestJS 유스케이스에서 Temporal Workflow로 옮기거나 짧은 요청-응답 작업까지 모두 Workflow로 만들면 운영 모델이 무거워질 수 있어요. “LLM을 한 번 호출하고 결과를 바로 Slack에 보여주는” 기능은 실패를 알리고 다시 실행하는 기존 구조가 더 단순해요.

Temporal의 Workflow/Activity/Event History 모델은 운영 인프라에 속하지만, TypeScript에서 AI SDK 호출을 Workflow 안에 자연스럽게 두는 통합은 비교적 새로운 축이에요. 그래서 전체를 교체하기보다 장기 작업 하나를 spike로 검증하는 게 맞아요.

먼저 현재 에이전트 실행 기록에서 “다시 실행하면 안 되는 단계”를 표시해야 해요. 하루 회고의 발행 후보를 고르는 LLM 판단부터 Slack 승인 메시지 전송, 승인 후 후속 기록 생성까지 한 흐름이라면 Workflow 후보예요. 이 작업 하나를 Workflow로 만들고, LLM 호출은 temporalProvider.languageModel()로 감싸고, Slack 승인은 signal로 받는 spike를 해볼 수 있어요. 중간에 Worker를 죽여 보면서 LLM 호출이 반복되지 않는지, 승인 메시지가 두 번 가지 않는지, 승인 후 후속 단계가 같은 상태에서 이어지는지 확인해야 해요.

## 참고한 출처

- https://docs.temporal.io/develop/typescript/integrations/ai-sdk
- https://temporal.io/blog/building-durable-agents-with-temporal-and-ai-sdk-by-vercel
- https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal
- https://github.com/temporalio/samples-typescript/tree/main/ai-sdk
