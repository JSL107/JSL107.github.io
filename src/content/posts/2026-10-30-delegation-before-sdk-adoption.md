---
title: "SDK 도입 전에 나눌 위임과 대화 소유권"
description: "Slack 멀티 에이전트 시스템에서 worker 호출과 대화 소유권 이전을 구분하고, 권한과 승인 경계를 점검한다."
pubDatetime: 2026-10-30T19:48:00+09:00
category: backend
---

LLM 기반 Slack 봇에서 worker가 늘어나면 라우터의 질문도 “어디로 보낼까?”에서 “보낸 뒤에는 누가 사용자에게 답할까?”로 바뀌어요. 이 글은 현재 운영 중인 Slack 멀티 에이전트 시스템을 점검하려고 OpenAI Agents SDK for TypeScript의 공식 문서와 예제를 읽은 기록이에요. 직접 프로젝트에 붙여 실행한 후기는 아니에요.

사용자가 “오늘 할 일 정리해 줘”라고 하면 계획을 만드는 worker에게 보내고, “이 PR 봐줘”라고 하면 코드 리뷰 worker에게 보내면 돼요. 하지만 여러 결과를 모아 하나의 답으로 만들어야 할 때도 있고, 전문 worker가 다음 대화를 직접 맡는 편이 나을 때도 있어요. 승인이 필요한 명령은 실행 전에 멈췄다가 승인받은 뒤 같은 맥락에서 이어가야 해요.

## worker 호출과 대화 소유권 이전

OpenAI Agents SDK for TypeScript에서는 Agent, tool, handoff, guardrail, run state, tracing 같은 요소로 에이전트 애플리케이션을 구성할 수 있어요. 설치와 기본 예제도 간단해요.

```bash
npm install @openai/agents zod
```

```typescript
import { Agent, run } from '@openai/agents';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a helpful assistant.',
});

const result = await run(
  agent,
  'Write a haiku about recursion in programming.',
);

console.log(result.finalOutput);
```

이미 NestJS로 라우터와 worker를 만들었다면 위임 방식을 구분하는 게 중요해요. SDK는 다른 agent를 tool처럼 호출하는 방식과 대화의 active agent를 바꾸는 handoff를 구분해요. 앞의 방식에서는 PM 역할을 하는 라우터가 결과를 모아 최종 답을 쓰고, 뒤의 방식에서는 전문 담당자가 다음 대화를 직접 맡아요.

### 결과를 합성해야 하면 agent는 tool로 남는다

agents as tools에서는 manager agent가 대화의 주도권을 쥔 채 specialist agent를 호출해요. specialist는 독립된 지시문에 따라 일하지만 사용자에게 최종 응답을 직접 보내지는 않아요. 누구를 호출하고 결과를 어떻게 합쳐 어떤 형식으로 답할지는 manager가 결정해요.

그날 할 일을 정하려면 GitHub의 할당 작업, 전날 계획, 사용자가 오늘 입력한 내용을 함께 보고 하나의 계획으로 묶어야 해요. 업무 로그나 주간 보고 초안을 만들 때, PR 변경 요약과 리뷰 결과를 엮을 때도 마찬가지예요. 여러 worker가 각자 Slack에 답하면 사용자는 “그래서 오늘 무엇을 하면 되지?”라고 다시 물어야 하니, 이런 흐름에서는 manager가 마지막 답을 책임지는 편이 안전해요.

### specialist가 이어 말해야 하면 handoff다

handoff에서는 specialist가 대화의 주도권을 넘겨받아요. SDK는 handoff를 모델에 tool처럼 보여줘요. Refund agent로 넘길 때는 transfer_to_refund_agent 같은 도구 이름이 드러나고, 모델이 이를 선택하면 SDK가 active agent를 바꿔 대화를 이어가요.

```typescript
import { Agent, handoff } from '@openai/agents';

const billingAgent = new Agent({ name: 'Billing agent' });
const refundAgent = new Agent({ name: 'Refund agent' });

// Use Agent.create method to ensure the finalOutput type considers handoffs
const triageAgent = Agent.create({
  name: 'Triage agent',
  handoffs: [billingAgent, handoff(refundAgent)],
});
```

Slack 업무 봇에서는 지원 내역을 조회한 뒤 다음 상태를 묻거나, 휴가 잔여일을 계산하는 데 빠진 파라미터를 되묻는 흐름이 이에 가까워요. 라우터가 한 번 분류한 뒤에도 specialist가 자기 도메인에 관한 질문을 직접 던져야 한다면 handoff가 자연스러워요. handoff에는 실행 대상과 함께 전달할 히스토리, 노출 조건, 위임할 때 붙일 구조화 데이터도 포함돼요.

| 구분 | agent as tool | handoff |
| --- | --- | --- |
| 대화 소유권 | manager가 유지 | specialist가 이어받음 |
| 최종 응답 | manager가 합성 | specialist가 생성 |
| 잘 맞는 일 | 계획·보고·평가처럼 여러 근거 합성 | 파라미터 보완·상태 조회·전문 대화 |
| 위험 지점 | specialist 결과를 맹신하면 합성 품질 저하 | 잘못 넘기면 권한과 맥락이 과하게 전달됨 |

## handoff에서 넘길 정보와 권한

SDK의 handoff() helper에는 inputType, onHandoff, inputFilter, isEnabled 같은 옵션이 있어요. inputType은 다음 agent의 본문 입력을 대체하는 값이 아니라, 모델이 handoff를 선택하면서 함께 제출하는 작은 메타데이터 schema예요. SDK는 이를 handoff tool의 parameters로 보여주고 반환된 arguments를 로컬에서 파싱해 onHandoff에 넘겨요.

```typescript
import { z } from 'zod';

import { Agent, handoff, RunContext } from '@openai/agents';

const EscalationData = z.object({ reason: z.string() });

type EscalationData = z.infer<typeof EscalationData>;

async function onHandoff(
  ctx: RunContext<EscalationData>,
  input: EscalationData | undefined,
) {
  console.log(`Escalation agent called with reason: ${input?.reason}`);
}

const agent = new Agent<EscalationData>({ name: 'Escalation agent' });

const handoffObj = handoff(agent, {
  onHandoff,
  inputType: EscalationData,
});
```

예시에 나온 reason을 쓰면 “왜 이 specialist가 대화를 맡았는가”를 감사 로그에 남길 수 있어요. Slack 라우터에 적용한다면 handoff input에는 사용자 의도, 넘긴 이유, 허용된 작업 범위 정도를 둘 수 있어요. Slack 채널이나 thread 식별자는 애플리케이션 context에 남기고, 모델이 쓰는 handoff payload에는 넣지 않는 편이 나아요. 승인 뒤 실행을 재개하거나 잘못된 위임을 분석할 때도 target 이름만 남기는 것보다 당시의 위임 이유를 함께 보는 게 유용해요.

SDK는 handoff를 모델에 보여주기 전에 isEnabled를 평가해요. 이를 이용하면 특정 사용자, 채널, 요청 종류에서만 specialist를 보여줄 수 있어요. 권한 없는 사용자가 “배포해 줘”라고 해도 배포 worker 자체를 보여주지 않는 식이에요.

inputFilter로는 다음 agent에게 전달할 history를 조정해요. 지원 기록 조회 worker에게 PR diff 전체가 필요하지 않고, PR 리뷰 worker에게 개인 일정 대화가 필요하지도 않아요. 대화의 주도권을 넘긴다고 이전 대화를 전부 넘길 이유는 없는 거죠. 현재 CLI 기반 라우터에서도 worker를 호출할 때 Slack thread 전체를 넘기는지, 요약한 intent만 넘기는지, 민감한 실행 권한을 worker에게 보여주는지 점검할 수 있어요.

## guardrail은 도구 호출 경계에서도 확인해야 한다

Agents SDK의 guardrail은 input, output, tool 세 층으로 나뉘어요. input guardrail은 첫 agent의 입력에서, output guardrail은 최종 출력을 만드는 agent에서 동작해요. 중간에 handoff가 일어나거나 nested agent를 tool로 호출하면 agent-level guardrail만으로는 모든 호출을 감쌀 수 없어요. tool guardrail은 function tool invocation마다 실행 전후에 붙일 수 있어요.

GitHub 조회, Slack 메시지 전송, 재시도 명령, 지원 상태 변경에는 각각 외부 조회나 부작용이 따라요. 그래서 처음 입력만 볼 게 아니라 지금 실행하려는 도구 호출도 확인해야 해요. handoff 뒤에 specialist가 직접 tool을 호출할 수도 있고, manager가 specialist를 tool로 부른 뒤 그 내부에서 다시 tool을 호출할 수도 있어요. PR 읽기, Slack 쓰기, 작업 상태 변경에 같은 정책을 적용해서는 안 돼요.

input guardrail을 병렬로 실행하면 guardrail이 검사하는 동안 agent도 실행을 시작할 수 있어 latency가 줄어요. 다만 guardrail이 뒤늦게 tripwire를 걸면 모델 호출이나 일부 tool 실행이 이미 진행됐을 수 있어요. runInParallel: false로 설정하면 guardrail을 마친 뒤 모델을 호출해요. 조회성 Slack 요청에서는 병렬 실행을 받아들일 만하지만, 상태 변경·외부 전송·재시도처럼 권한이나 승인이 필요한 요청에는 fail closed가 더 중요해요.

## 승인은 멈춘 run을 이어가는 문제다

Human-in-the-loop 문서의 승인 흐름은 run-wide예요. tool에 needsApproval을 붙이면 SDK는 해당 tool call을 바로 실행하지 않고 run을 멈춘 다음, interruptions에 pending approval을 반환해요. 애플리케이션은 interruption을 approve 또는 reject하고 같은 RunState에서 실행을 이어가요.

```typescript
import { tool } from '@openai/agents';

import z from 'zod';

const sensitiveTool = tool({
  name: 'cancelOrder',
  description: 'Cancel order',
  parameters: z.object({
    orderId: z.number(),
  }),

  // always requires approval
  needsApproval: true,

  execute: async ({ orderId }, args) => {
    // prepare order return
  },
});
```

Slack 업무 봇에서는 메시지 전송, 외부 시스템의 상태 기록, 실패한 실행의 재시도가 여기에 해당해요. nested agent.asTool() 내부에서 요청한 승인도 바깥 run의 interruptions로 올라와요. 사용자는 내부 agent를 몰라도 되고, 애플리케이션은 하나의 승인 UI에서 처리할 수 있어요. 승인받은 뒤에는 state에 결정을 기록하고 원래 root agent로 이어가요.

```typescript
result.state.approve(interruption);
result.state.reject(interruption);

result.state.approve(interruption, { alwaysApprove: true });
result.state.reject(interruption, { alwaysReject: true });

runner.run(agent, state);
```

Slack에서 몇 초나 몇 분 뒤 승인 버튼을 누르는 상황이라면 toString()과 fromString()으로 run state를 serialize/deserialize할 수 있다는 점도 맞닿아 있어요.

function tool input guardrail은 기본적으로 승인 뒤 실제 tool을 실행하기 직전에 돌아요. 승인 화면을 보여주기 전에도 검증하려면 toolExecution: { preApprovalInputGuardrails: true } 옵션을 써요. 잘못 파싱된 tool arguments나 권한 없는 요청이 승인 대기 목록에 올라오면 나중에 실행을 막더라도 불필요한 정보가 보일 수 있어요. 문서에 따르면 pre-approval guardrail이 허용했어도 승인 뒤에는 guardrail을 다시 실행해요. 기다리는 동안 조건이 바뀔 수 있기 때문이에요.

현재 CLI 구독 기반 실행 구조에서는 SDK의 run state를 그대로 쓰기 어려워요. 대신 실행 요청을 승인 대기 항목으로 저장하고 승인 또는 거절 결정을 붙인 뒤, 원래 요청과 최소한의 history를 재구성하는 패턴은 가져올 수 있어요. 승인 버튼은 새 명령을 만드는 게 아니라 멈춘 실행을 재개하는 역할이어야 해요.

## 현재 시스템에 적용할 범위

OpenAI Agents SDK for TypeScript는 Node.js 22 이상, Deno, Bun을 지원해요. text와 sandbox agent 예제는 서버 환경의 OPENAI_API_KEY를 전제로 해요. 공식 레포는 provider-agnostic이라고 설명하지만 문서와 기본 경로는 OpenAI API 중심이에요.

현재 시스템은 OpenAI API key를 직접 호출하기보다 ChatGPT와 Claude의 CLI 구독 쿼터를 라우터 뒤에 붙여 실행해요. SDK를 런타임 중심에 바로 넣으면 model-router와 CLI provider 계층이 중복되고, 인증과 실패 처리, fallback 방식도 달라져요.

그날 할 일 정리, 업무 로그 작성, PR 영향도 보고서, 여러 평가를 합친 커리어 기록 후보 생성은 manager가 결과를 합치는 방식에 가까워요. 지원 기록을 조회한 뒤 조건을 되묻거나, 휴가 계산에 필요한 값을 묻거나, 진행 상태와 지연 원인을 직접 설명하는 기능은 handoff 후보가 될 수 있어요.

내부 전용 배치 분석, 야간 회고 후보 생성, 문서 수정안 생성, 메모리 정리처럼 Slack 사용자가 실시간으로 대화하지 않는 흐름에서는 handoff의 장점이 작아요. 이런 흐름에서는 코드 기반 orchestration과 감사 로그가 더 중요해요.

다음에는 worker마다 최종 답을 manager가 합쳐야 하는지, specialist가 다음 Slack 응답을 맡아도 되는지 표시해야 해요. 이어서 handoff input에 위임 사유·사용자 의도·허용 작업 범위면 충분한지, Slack 응답 작성·GitHub 조회·상태 변경·재시도 실행의 tool guardrail을 각각 어디에 둬야 하는지 확인해야 해요.

:::toggle 참고한 공식 출처

- https://openai.github.io/openai-agents-js/
- https://openai.github.io/openai-agents-js/guides/multi-agent/
- https://openai.github.io/openai-agents-js/guides/handoffs/
- https://openai.github.io/openai-agents-js/guides/guardrails/
- https://openai.github.io/openai-agents-js/guides/human-in-the-loop/
- https://openai.github.io/openai-agents-js/guides/tools/
- https://openai.github.io/openai-agents-js/guides/running-agents/
- https://openai.github.io/openai-agents-js/guides/results/
- https://github.com/openai/openai-agents-js

:::
