---
title: "Genkit Agents를 기존 Slack 런타임에 어디까지 맡길까"
description: "Genkit flow와 Agents API가 맡을 수 있는 상태를 기존 NestJS 기반 Slack 봇의 책임과 비교한다."
pubDatetime: 2026-11-07T19:45:00+09:00
category: backend
---

Slack 봇에 LLM 기능을 늘리다 보면 모델을 호출하는 코드보다 실행 상태를 관리하는 코드가 더 커져요. 공식 Genkit 문서, Firebase 블로그, Genkit 공식 README를 읽고 TypeScript·NestJS 기반 Slack 멀티 에이전트 시스템에 대입해 보면서 프레임워크와 기존 앱의 경계를 살펴봤어요.

## 모델 호출보다 실행 상태가 무거워질 때

LLM 기능을 처음 붙일 때는 모델 호출 하나면 충분해 보여요. 사용자가 명령을 보내면 서버가 프롬프트를 만들고, 모델 응답을 받아 Slack에 돌려주죠. 여기까지는 NestJS 유스케이스 하나와 응답 포맷터 하나로도 감당할 수 있어요.

두 번째 기능부터는 사정이 달라져요. 오늘 할 일을 정리하려면 GitHub 작업과 전날 계획을 읽어야 하고 업무 로그를 쓰려면 정량 근거를 모아야 해요. PR 리뷰는 diff를 읽어야 하고 실패하면 다시 실행할 수 있어야 하죠. 어떤 기능은 사람의 승인을 기다려야 하고 어떤 기능은 자연어 요청을 알맞은 워커에게 넘겨야 해요.

실행 시작과 종료, 실패 상태부터 Slack의 즉시 ack와 후속 메시지 교체, 큐, 재시도, 승인 대기까지 관리하다 보면 직접 만든 코드가 작은 실행 런타임에 가까워져요.

## 단발 작업은 flow부터 살펴볼 수 있다

Genkit에서 시작하기 좋은 단위는 flow예요. AI 로직을 함수로 감싸고 입력과 출력에 Zod 스키마를 붙일 수 있어요. Developer UI에서 실행 trace를 보고, 필요하면 streaming을 열어 Cloud Functions for Firebase나 Node.js 런타임에 배포할 수도 있어요.

공식 예제는 복잡하지 않아요.

```typescript
import { googleAI } from '@genkit-ai/google-genai';
import { genkit, z } from 'genkit';

const ai = genkit({
  plugins: [googleAI()],
});

export const menuSuggestionFlow = ai.defineFlow(
  {
    name: 'menuSuggestionFlow',
    inputSchema: z.object({ theme: z.string() }),
    outputSchema: z.object({ menuItem: z.string() }),
  },
  async ({ theme }) => {
    const { text } = await ai.generate({
      model: googleAI.model('gemini-flash-latest'),
      prompt: `Invent a menu item for a ${theme} themed restaurant.`,
    });

    return { menuItem: text };
  },
);
```

Slack 봇의 ‘그날 할 일 정리’나 ‘업무 로그 초안 생성’도 이 구조와 닮았어요. 입력을 모아 모델을 한 번 또는 몇 번 호출한 뒤 검증 가능한 형태로 결과를 돌려주는 작업이라면 agent까지 쓸 이유는 크지 않아요.

지금의 NestJS 유스케이스도 같은 일을 할 수 있어요. 직접 만든 구조는 도메인 규칙과 기존 DB 모델에 더 잘 맞고, Genkit flow는 입력·출력 스키마, 실행 trace, streaming, 배포 연결을 한 단위로 묶어줘요. 그 연결과 관찰 도구를 얻는 대신 기존 실행 기록·큐·권한 모델과 일부 중복되는 부분은 받아들여야 해요.

## 대화가 이어질 때 Agents API가 의미를 갖는다

Agents API는 대화가 이어지는 동안 도구를 호출하고 상태를 저장해야 하는 작업을 다뤄요. Genkit 문서에 따르면 모델 루프, 메시지 히스토리, tool calls, streaming, persistence, snapshots, aborts, interrupts, background execution, continuation from previous turns를 하나의 대화형 API로 묶어요.

가장 작은 agent 예제는 이렇게 생겼어요.

```typescript
import { genkit } from 'genkit/beta';

import { googleAI } from '@genkit-ai/google-genai';

const ai = genkit({
  plugins: [googleAI()],
  model: googleAI.model('gemini-flash-latest'),
});

const assistant = ai.defineAgent({
  name: 'assistant',
  system: 'You are a helpful assistant.',
});

const chat = assistant.chat();

const res = await chat.send('Hello. What can you do?');

console.log(res.text);
```

여기서 눈여겨볼 부분은 defineAgent보다 chat().send()예요. agent를 한 번 실행하는 함수가 아니라 계속 이어지는 대화 객체로 다루거든요. 로컬 agent와 HTTP로 노출된 remote agent가 같은 인터페이스를 쓰므로 웹·모바일·다른 서버에서도 같은 대화 모델을 이어받을 수 있어요.

Slack 명령 하나에 결과 메시지 하나를 돌려주는 기능이라면 session과 snapshot 모델은 과할 수 있어요. 반면 사용자가 긴 작업의 중간 산출물을 확인하고 승인하거나 방향을 바꾼 뒤 이후 대화에서도 작업을 이어가야 한다면 Genkit agent가 맞을 가능성이 커져요.

## interrupt가 맡는 승인 대기의 범위

Slack 기반 업무 봇에서 ‘잠깐 멈춤’을 구현하기는 까다로워요. 모델이 액션을 하려 할 때 앱이 Slack 버튼을 보내고 승인 대기 상태를 DB에 남겨야 해요. 사용자가 버튼을 누르면 원래 실행을 찾아 이어 붙여야 하고 실패·중복 클릭·만료까지 챙겨야 하니 단순한 tool call로 끝나지 않아요.

Genkit interrupt는 특별한 tool이에요. 모델에는 tool call처럼 보이지만 Genkit은 그 호출에서 생성 루프를 멈추고 애플리케이션에 제어권을 돌려줘요. 앱이 응답을 넣어 resume하면 모델은 그 값을 받아 생성을 이어가요.

공식 문서에서는 interrupt를 이렇게 정의해요.

```typescript
import { genkit, z } from 'genkit';

import { googleAI } from '@genkit-ai/google-genai';

const ai = genkit({
  plugins: [googleAI()],
  model: googleAI.model('gemini-flash-latest'),
});

const askQuestion = ai.defineInterrupt({
  name: 'askQuestion',
  description: 'use this to ask the user a clarifying question',
  inputSchema: z.object({
    choices: z.array(z.string()).describe('the choices to display to the user'),
    allowOther: z.boolean().optional().describe('when true, allow write-ins'),
  }),
  outputSchema: z.string(),
});
```

Slack 시스템에 대입하면 승인 대기나 추가 질문 상태에 해당해요. PR 리뷰 답변을 자동으로 수락할지 묻거나 업무 보고 초안을 발행하기 전에 확인받는 단계에 쓸 수 있어요.

버튼 메시지를 보내고 권한을 확인하며 만료를 처리하고 응답자가 동일 사용자인지 검증하는 일은 여전히 앱이 해야 해요. Genkit이 줄여주는 것은 LLM tool loop를 멈추고 이어가는 접착 코드예요. 조직의 승인 정책과 감사 로그까지 대신 설계해 주지는 않아요.

## multi-agent 위임과 앱의 권한 판단

Genkit의 multi-agent 문서는 도구가 많아질수록 단일 agent가 올바른 tool을 고르기 어려워진다는 문제에서 출발해요. 전문 agent를 만들고 일반 목적의 triage agent가 이를 tool처럼 호출하는 방식이죠. 공식 예제에서는 예약, 메뉴 안내, 불만 처리를 각각 전문 prompt로 두고 triage prompt의 tools 배열에 넣어요.

```typescript
// Define a prompt that represents a specialist agent
const reservationAgent = ai.definePrompt({
  name: 'reservationAgent',
  description: 'Reservation Agent can help manage guest reservations',
  tools: [reservationTool, reservationCancelationTool, reservationListTool],
  system: 'Help guests make and manage reservations',
});

// Or load agents from .prompt files
const menuInfoAgent = ai.prompt('menuInfoAgent');

const complaintAgent = ai.prompt('complaintAgent');

// The triage agent is the agent that users interact with initially
const triageAgent = ai.definePrompt({
  name: 'triageAgent',
  description: 'Triage Agent',
  tools: [reservationAgent, menuInfoAgent, complaintAgent],
  system: `You are an AI customer service agent for Pavel's Cafe.

Greet the user and ask them how you can help. If appropriate, transfer to an
agent that can better handle the request. If you cannot help the customer with
the available tools, politely explain so.`,
});
```

사용자의 문장을 보고 ‘오늘 할 일 정리’, ‘업무 로그 작성’, ‘PR 리뷰 생성’, ‘지원 기록 조회’, ‘휴가 잔여 계산’ 중 하나로 넘기는 Slack 자연어 라우터와 닮았어요. 위임할 대상을 LLM이 고르게 하면 유연해지는 만큼 감사하기는 어려워질 수 있어요. 앱 코드에서 intent classifier와 dispatcher를 통제하면 예측 가능성은 높아지지만 새 기능을 추가할 때마다 라우팅 규칙과 테스트도 늘어나요.

자연어 라우터의 일부는 실험해 볼 만해요. 위험도가 낮고 결과가 읽기 전용인 작업에 Genkit식 delegation을 붙여 보되 권한·재시도·감사 로그는 기존 앱에서 통제하는 편이 안전해요.

## Firebase와 연결될 때의 이점

NestJS와 Slack만 놓고 보면 Genkit의 장점이 덜 선명할 수 있어요. Firebase Functions와 Firestore를 써 본 팀이라면 flow를 callable function으로 감싸고 streaming callable functions와 연결해 웹·모바일 클라이언트에 부분 결과를 보낼 수 있어요.

Firebase 블로그의 예시는 request.acceptsStreaming을 확인한 뒤 가능한 클라이언트에 response.sendChunk(...)로 중간 결과를 보내요. 마지막에는 non-streaming 클라이언트를 위한 전체 결과도 반환해요.

```javascript
exports.getForecast = onCall(async (request, response) => {
  const locations = request.data.locations;

  const allLocations = locations.map(async ({ latitude, longitude }) => {
    const forecast = await fetchWeather(latitude, longitude);

    // Stream each forecast as it resolves!
    if (request.acceptsStreaming) {
      response.sendChunk({ latitude, longitude, forecast });
    }

    return { latitude, longitude, forecast };
  });

  // Fallback for non-streaming clients
  return Promise.all(allLocations);
});
```

클라이언트에서는 stream과 최종 data를 함께 받아요.

```javascript
const getForecast = getFunctions("getForecast");

const { stream, data } = await getForecast.stream({ locations });

for await (const chunk of stream) {
  updateUI(chunk); // Live updates!
}

const allData = await data; // Full response when done
```

예제는 날씨를 다루지만 긴 보고서 초안, 여러 PR의 요약, 후보 작업 목록을 만들 때도 같은 구조를 대입할 수 있어요. Slack에서는 ack 후 메시지를 교체하고 웹 클라이언트에서는 streaming으로 부분 결과를 바로 보여주는 편이 더 자연스러워요.

## 기존 기능에 대입해 보면

그날 할 일 정리는 우선 flow 후보예요. 사용자 메모, 할당된 작업, 이전 계획처럼 입력이 명확하고 출력도 일일 계획이라는 구조화된 결과예요. 긴 대화를 이어가기보다 한 번의 요청에서 좋은 결과를 만드는 게 중요하므로 input/output schema와 Developer UI trace가 잘 맞아요.

업무 로그나 주간 보고 초안도 근거를 모으고 출력 형식을 맞추는 일이 핵심이어서 flow부터 검토할 만해요. 다만 사용자가 초안을 보고 항목을 빼거나 지연 사유를 여러 턴에 걸쳐 다듬는 경험을 만든다면 agent가 후보가 돼요. 현재 Slack 명령은 flow에 가깝고, 이후 편집 경험은 agent에 가까워요.

PR 리뷰도 diff를 읽고 리뷰를 생성하는 작업만 보면 flow로 충분해요. 다만 권한·보안·외부 CLI 격리·프롬프트 전달 방식은 기존 시스템에서 지켜야 할 중요한 불변식이에요. Genkit의 model provider와 tool calling이 로컬 CLI 구독 기반 호출과 격리 정책까지 같은 방식으로 대체할 수 있다는 근거는 이번 조사에서 확인하지 못했어요. 이 부분은 기존 NestJS 유스케이스를 유지하는 편이 자연스러워요.

자연어 라우터는 multi-agent의 triage 구조와 맞아서 agent 실험 후보가 돼요. 실패 재실행, 감사 로그, 안전 등급, 읽기 전용과 쓰기 작업의 구분은 앱 코드에 남겨야 해요. LLM이 위임 대상을 고르는 일과 앱이 허용 여부를 판단하고 기록하는 일을 분리할 필요가 있어요.

휴가 잔여 계산처럼 결정론적 규칙이 중심이고 LLM은 자연어 파라미터 추출에만 쓰는 기능이라면 작은 parser 또는 flow가 나아요. 내부 배치로 선호 신호를 분석하거나 운영 이상 신호를 요약하는 작업도 사용자와 여러 턴을 이어가지 않는다면 기존 배치·큐 구조가 더 단순해요.

## Beta와 상태 소유권을 고려한 다음 실험

Agents API는 JavaScript에서 Beta로 표시돼 있고 minor release에서 breaking change가 생길 수 있다고 안내해요. 핵심 업무 봇 전체를 옮기기보다 새 제품 표면이나 실험 기능의 하네스로 먼저 검토할 이유예요.

flow는 명시적 워크플로우·request/response 작업·scheduled job·앱이 이미 상태를 관리하는 시스템에 적합해요. agent는 persistent chat, approval workflow, task copilot, long-running generator, specialized agent delegation처럼 대화와 상태가 이어질 때 의미가 커져요.

Genkit agent state에는 message history, custom application state, artifacts, session identity, snapshot lineage가 들어가요. 서버가 상태를 소유하면 session store를 붙일 수 있고 클라이언트가 상태를 들고 다니는 방식도 가능해요.

Firestore session store는 Firebase 기반 제품과 잘 맞을 수 있지만 기존 시스템이 PostgreSQL에 실행 기록과 근거를 쌓고 있다면 데이터 모델이 이중화돼요. 대화 히스토리와 snapshot은 Genkit에 맡더라도 업무 감사 로그와 재실행 정책은 기존 앱에 남길 수 있어요.

가장 작은 실험은 그날 할 일 정리나 업무 로그 초안 생성 중 하나를 골라 세 선택지를 비교하는 거예요.

| 선택지 | 맞는 부분 | 걸리는 부분 |
|---|---|---|
| Genkit flow | 입력·출력 스키마, trace, streaming, Firebase 배포 | 기존 실행 기록과 일부 중복 |
| Genkit agent | 여러 턴 편집, 승인 대기, session/snapshot | JS Beta, 상태 모델 이중화 |
| 기존 NestJS 유스케이스 | 도메인 규칙, 큐, 감사 로그, Slack 운영 안정성 | streaming·Dev UI·클라이언트 연동은 직접 구현 |

flow 하나를 만들어 Developer UI trace가 기존 실행 기록과 얼마나 중복되는지 비교할 수 있어요. 그다음 interrupt 예제를 Slack 승인 버튼에 연결해 ‘멈춤과 재개’ 외에 권한·만료·중복 처리를 얼마나 직접 구현해야 하는지 확인하면 돼요.

## 참고한 출처

- https://genkit.dev/docs/js/agents/overview
- https://genkit.dev/docs/js/flows
- https://genkit.dev/docs/js/interrupts
- https://genkit.dev/docs/js/multi-agent
- https://genkit.dev/docs/js/agents/run
- https://genkit.dev/docs/js/agents/state
- https://genkit.dev/docs/js/agents/session-stores
- https://genkit.dev/docs/js/agents/http
- https://firebase.blog/posts/2025/03/streaming-cloud-functions-genkit
- https://github.com/genkit-ai/genkit
