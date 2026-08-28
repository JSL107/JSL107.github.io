---
title: "도구가 많을수록 Code Mode가 맞는 이유"
description: "Cloudflare Agents SDK의 Code Mode가 복잡한 도구 실행 계획과 중간 데이터를 어떻게 다루며, 어떤 작업에 적용할 만한지 살펴본다."
pubDatetime: 2026-08-22T19:05:00+09:00
category: backend
---
겉보기에는 단순합니다. Slack에서 “이 PR 리뷰해줘”라고 말할 때도 그래요. 구현부에서는 여러 도구를 호출하고 큰 중간 결과까지 처리해야 합니다. Cloudflare Agents SDK의 Code Mode는 도구를 하나 더 보태는 기능이 아니에요. 커진 도구 목록을 코드로 조합하고 필요한 결과만 모델에 돌려주는 실행 방식이죠.

## 도구가 많아질수록 생기는 문제

PR 메타데이터를 조회한 뒤 파일 목록을 분류하고, 큰 diff는 나눠야 해요. 테스트·설정 파일을 구분하고 기존 리뷰 스레드도 확인해야 해요. 도구 호출 과정은 한 줄로 끝나지 않고, 그 자체로 작은 실행 계획이 돼요.

일반적인 tool calling은 단계마다 모델 밖으로 나갔다가 결과와 함께 모델 컨텍스트로 돌아와요. 중간 결과가 커지면 부담도 늘고, 최종 판단에 필요 없는 원본 목록까지 모델이 계속 봐야 하니까요. 긴 diff와 임시 분류 결과도 마찬가지예요.

Code Mode에서는 모델이 작업별로 요청을 따로 보내지 않고 JavaScript 코드를 작성해요. 요청 방식부터 달라지는 셈이에요. 모델은 여러 도구를 직접 받지 않고, codemode라는 하나의 바깥 도구에 코드를 넘겨요.

그 코드는 configured tools를 호출하고 결과를 처리한 뒤, 최종 응답에 필요한 값만 반환하는 실행 계획이 돼요.

```typescript
type CodeModeInput = {
  code: string;
};

type CodeModeOutput =
  | { status: "completed"; executionId: string; result: unknown; logs?: string[] }
  | { status: "paused"; executionId: string; pending: PendingAction[] }
  | { status: "error"; executionId: string; error: string; logs?: string[] };
```

핵심 차이는 제어 흐름이 어디에 놓이느냐예요. direct tool call에서는 모델이 tool → result → next tool을 반복해요. Code Mode는 loop, branch, filter, transform 같은 중간 제어를 sandbox 안의 코드로 옮겨요. paused 상태가 생기면 host가 위험한 호출을 pending action으로 멈추므로, 승인·감사·재실행의 경계를 잡을 수 있죠.

## 필요한 도구만 찾아서 실행한다

Code Mode의 또 다른 핵심은 progressive tool discovery예요. 큰 tool catalog를 처음부터 모델 컨텍스트에 모두 넣지 않아요. sandbox 안에서는 codemode.search()와 codemode.describe()로 필요한 connector나 method를 검색하고, 특정 path의 타입 설명만 가져와요.

```typescript
declare const codemode: {
  search(query: string): Promise<SearchOutput>;
  describe(target: string): Promise<DescribeOutput>;
  step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  run(name: string, input?: unknown): Promise<unknown>;
};
```

search는 전체 스키마를 넘기는 대신 관련 path 목록을 반환해요. describe는 선택한 대상의 TypeScript 문서를 돌려줘요. step은 replay를 위해 비결정적이거나 side effect가 있는 작업을 기록하고, run은 저장된 snippet을 실행해요.

connector는 sandbox global로 노출돼요. github라는 connector가 있다면 generated code는 github global을 통해 method를 호출해요. sandbox에는 표준 JavaScript global이 있어요.

Node.js API, host credentials, process, require, unrestricted network access는 노출되지 않아요.

외부 작업은 connector global이나 executor가 명시적으로 제공한 capability를 통해야 해요.

## Durable runtime이 제공하는 실행 경계

Cloudflare의 durable runtime은 Code Mode를 Agents SDK 애플리케이션에 연결해요. Durable Object, Vite, Worker Loader binding이 전제예요. Durable Object hibernation 뒤에도 execution history와 pending approvals를 저장해요. reusable snippets와 rollback metadata도 남겨둬요.

```plain text
compatibility_date = "2026-08-22"
compatibility_flags = ["nodejs_compat"]

[[worker_loaders]]
binding = "LOADER"
```

Vite에는 Agents plugin과 Code Mode plugin을 함께 넣어요.

```typescript
import { cloudflare } from "@cloudflare/vite-plugin";
import codemode from "@cloudflare/codemode/vite";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agents(), codemode(), cloudflare()],
});
```

Code Mode Vite plugin은 Worker entry module에서 CodemodeRuntime facet class를 export해요. plugin을 쓰지 않는다면 `export { CodemodeRuntime } from "@cloudflare/codemode";`를 직접 추가해야 해요. 런타임 상태가 Durable Object facet에 저장되는 건 Workers runtime이 facet class를 ctx.exports에서 찾기 때문이죠.

connector는 평범한 class예요. name()은 sandbox global 이름이 되고, instructions()는 모델에 사용법을 알려줘요. tools()는 호출할 수 있는 method를 정의해요. 문서의 NotesConnector 예시에서는 createNote가 실행 전에 멈춰요. requiresApproval: true로 설정돼 있거든요.

revert 함수는 rollback compensation도 제공해요.

## 모든 작업에 Code Mode가 필요한 것은 아니다

Code Mode는 experimental이고, Cloudflare 문서도 breaking changes 가능성을 명시해요. 안정적으로 동작하는 NestJS, BullMQ, Prisma, Slack Bolt 기반 시스템의 본체를 교체하는 일은 피하는 편이 안전해요. orchestration 일부를 검증하는 실험 계층으로 보는 게 나아요.

호출 순서가 정해진 작업에는 direct tool call이 더 알맞아요. 단일 Slack 응답과 고정된 DB 조회가 여기에 해당해요. 버튼 승인 처리와 단순 파라미터 추출도 마찬가지예요. 루프·분기·필터링·결과 축약이 반복될 때는 Code Mode가 의미 있어요.

중간 결과가 크거나 도구 목록이 커서 progressive discovery의 이득이 있는 작업에도 잘 맞아요. sandbox가 Node.js API와 unrestricted network access를 막더라도 connector 설계는 애플리케이션의 책임이에요. 읽기 전용 method와 승인 대기 상태로 멈출 method를 정해야 해요.

rollback 가능 여부와 실행 로그에 민감정보가 남지 않는지도 확인해야 해요.

## Slack 에이전트에 적용할 수 있는 지점

첫 번째 후보는 agent/code-reviewer예요. 여기에는 github와 pr-review-loop도 포함돼요. PR detail, file list, diff, 기존 review thread, 체크 결과를 조합해도 모든 diff를 모델에 넣을 필요는 없어요. sandbox 안에서 파일 크기와 확장자로 분류한 뒤, 리뷰 가치가 낮은 generated file을 제외해요. 그러고 나서 “검토해야 할 변경 묶음”만 반환할 수 있죠.

두 번째 후보는 slack-collector와 slack-inbox예요. Slack thread context를 모을 때는 메시지 수, 작성자, 시간 범위, 첨부 링크에 따라 분기가 많아요. connector method로 메시지를 가져온 뒤 bot 메시지, 중복 인용, 오래된 context를 줄여요.

최종 context pack만 반환하는 방식이 맞죠.

세 번째 후보는 crawler예요. Puppeteer와 Cheerio로 가져온 결과는 원문이 길고 잡음도 많아요. Code Mode가 crawler 자체를 대신할 필요는 없어요. 여러 crawl 결과에서 제목·본문 후보·링크를 걸러, 모델이 읽을 최소 자료로 줄이는 orchestration layer가 될 수 있어요.

반대로 agent/vacation처럼 자연어 파라미터 추출만 LLM에 맡기고 계산은 결정적인 모듈에서 처리하는 작업에는 맞지 않아요. 후보에서 빼는 게 맞아요. agent-run은 실행 lifecycle과 evidence 기록을 맡는 핵심 인프라예요. Code Mode로 옮기기보다 실행을 감싸는 바깥 감사 레이어로 남는 편이 자연스러워요.

## 도입 전에 확인할 조건

먼저 GitHub PR diff 수집처럼 side effect가 없는 읽기 전용 connector로 검증해야 해요. search, describe, connector method 호출과 최종 result shaping이 한 번에 동작하는지 확인해요. 비교 기준은 모델 라운드트립 횟수가 아니에요. 중간 데이터가 모델 컨텍스트로 얼마나 덜 돌아오는지를 봐야 하죠.

그다음 requiresApproval: true인 method가 실제로 paused 상태와 pending action으로 멈추는지 확인해야 해요. 같은 execution을 replay할 때 codemode.step()으로 기록한 작업이 기대대로 재사용되는지도 봐야 해요. 이 두 가지 검증이 끝나기 전에는 쓰기 작업이나 운영 자동화에 연결하면 안 돼요.

Code Mode의 가치는 단순히 도구 호출을 줄이는 데 있지 않아요. 도구가 많고 중간 결과가 큰 작업에서는 제어 흐름과 데이터 축약을 sandbox로 옮겨요. 모델에는 판단에 필요한 결과만 전달해요.

고정된 작업까지 모두 바꾸기보다, 복잡한 orchestration 구간부터 읽기 전용으로 검증하는 게 적절하죠.

출처는 Cloudflare Agents Code Mode 문서와 How Code Mode works 문서예요. Durable runtime 문서와 cloudflare/agents 공식 저장소 README도 참고했어요.
