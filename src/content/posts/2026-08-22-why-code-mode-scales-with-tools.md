---
title: "도구가 많을수록 Code Mode가 맞는 이유"
description: "Cloudflare Agents SDK의 Code Mode가 복잡한 도구 실행 계획과 중간 데이터를 어떻게 다루며, 어떤 작업에 적용할 만한지 살펴본다."
pubDatetime: 2026-08-22T19:05:00+09:00
category: backend
---

겉보기에는 단순합니다. Slack에서 “이 PR 리뷰해줘”라고 말할 때도 그래요. 구현부에서는 여러 도구를 호출하고 큰 중간 결과까지 처리해야 합니다.

Cloudflare Agents SDK의 Code Mode는 도구를 하나 더 보태는 기능이 아니에요. 커진 도구 목록을 코드로 조합하고 필요한 결과만 모델에 돌려주는 실행 방식이죠.

## 도구가 많아질수록 생기는 문제

PR 메타데이터를 조회하고 파일 목록을 분류해야 합니다. 큰 diff를 나누고 테스트·설정 파일도 구분해요. 기존 리뷰 스레드도 확인해야 합니다.

도구 호출은 직선 하나로 끝나지 않아요. 작은 실행 계획이 되죠.

일반적인 tool calling에서는 단계마다 모델 밖으로 나갔다가 결과와 함께 모델 컨텍스트로 돌아옵니다. 중간 결과가 커질수록 부담도 커져요.

최종 판단에 필요 없는 원본 목록까지 모델이 계속 보게 됩니다. 긴 diff와 임시 분류 결과도 마찬가지죠.

Code Mode에서는 모델이 작업마다 따로 요청하지 않고 JavaScript 코드를 작성합니다. 요청 방식부터 달라져요. 모델은 여러 도구를 직접 받는 대신 codemode라는 하나의 바깥 도구에 코드를 넘깁니다.

이 코드는 configured tools를 호출합니다. 결과를 처리한 뒤 최종 응답에 필요한 값만 반환하는 실행 계획이 돼요.

```typescript
type CodeModeInput = {
  code: string;
};

type CodeModeOutput =
  | { status: "completed"; executionId: string; result: unknown; logs?: string[] }
  | { status: "paused"; executionId: string; pending: PendingAction[] }
  | { status: "error"; executionId: string; error: string; logs?: string[] };
```

차이는 제어 흐름의 위치입니다. direct tool call에서는 모델이 tool → result → next tool을 반복해요.

Code Mode는 loop, branch, filter, transform 같은 중간 제어를 sandbox 안의 코드로 옮깁니다. paused 상태가 생기면 host가 위험한 호출을 pending action으로 멈춰요. 승인·감사·재실행의 경계를 잡을 수 있죠.

## 필요한 도구만 찾아서 실행한다

Code Mode의 또 다른 핵심은 progressive tool discovery입니다. 큰 tool catalog를 처음부터 모델 컨텍스트에 모두 넣지 않아요.

sandbox 안에서는 두 함수를 씁니다. codemode.search()와 codemode.describe()로 필요한 connector나 method를 검색하고, 특정 path의 타입 설명만 가져오죠.

```typescript
declare const codemode: {
  search(query: string): Promise<SearchOutput>;
  describe(target: string): Promise<DescribeOutput>;
  step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  run(name: string, input?: unknown): Promise<unknown>;
};
```

search는 전체 스키마 대신 관련 path 목록을 반환합니다. describe는 선택한 대상의 TypeScript 문서를 돌려줘요. step은 replay를 위해 비결정적이거나 side effect가 있는 작업을 기록하고, run은 저장된 snippet을 실행하죠.

connector는 sandbox global로 노출됩니다. github라는 connector가 있다면 generated code에서 github global을 통해 method를 호출해요.

sandbox에는 표준 JavaScript global이 있습니다. Node.js API, host credentials, process, require, unrestricted network access는 노출되지 않아요. 외부 작업은 connector global이나 executor가 명시적으로 제공한 capability를 통해야 합니다.

## Durable runtime이 제공하는 실행 경계

Cloudflare의 durable runtime은 Code Mode를 Agents SDK 애플리케이션에 연결합니다. Durable Object, Vite, Worker Loader binding이 전제예요.

런타임은 Durable Object hibernation 뒤에도 execution history와 pending approvals를 저장합니다. reusable snippets와 rollback metadata도 남겨둬요.

```plain text
compatibility_date = "2026-08-22"
compatibility_flags = ["nodejs_compat"]

[[worker_loaders]]
binding = "LOADER"
```

Vite에는 Agents plugin을 넣습니다. Code Mode plugin도 함께 넣어요.

```typescript
import { cloudflare } from "@cloudflare/vite-plugin";
import codemode from "@cloudflare/codemode/vite";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agents(), codemode(), cloudflare()],
});
```

Code Mode Vite plugin은 Worker entry module에서 CodemodeRuntime facet class를 export합니다. plugin을 사용하지 않는다면 `export { CodemodeRuntime } from "@cloudflare/codemode";`를 직접 추가해야 해요.

런타임 상태는 Durable Object facet에 저장됩니다. Workers runtime이 facet class를 ctx.exports에서 찾기 때문이죠.

connector는 평범한 class입니다. name()은 sandbox global 이름이 되고, instructions()는 모델에게 사용법을 알려줘요. tools()는 호출 가능한 method를 정의합니다.

문서의 NotesConnector 예시에서는 createNote가 실행 전에 멈춥니다. requiresApproval: true로 설정되어 있거든요. revert 함수로 rollback compensation도 제공합니다.

## 모든 작업에 Code Mode가 필요한 것은 아니다

Code Mode는 experimental입니다. Cloudflare 문서는 breaking changes가 있을 수 있다고 명시해요.

안정적으로 동작하는 NestJS, BullMQ, Prisma, Slack Bolt 기반 시스템의 본체를 교체하는 건 피하는 편이 안전합니다. orchestration 일부를 검증하는 실험 계층으로 보는 게 낫죠.

호출 순서가 정해진 작업에는 direct tool call이 낫습니다. 단일 Slack 응답과 고정된 DB 조회가 여기에 해당해요. 버튼 승인 처리와 단순 파라미터 추출도 마찬가지입니다.

루프·분기·필터링·결과 축약이 반복되면 Code Mode가 의미 있어요. 중간 결과가 크거나 도구 목록이 커서 progressive discovery의 이득이 있는 작업에도 맞습니다.

sandbox가 Node.js API와 unrestricted network access를 막더라도 connector 설계는 애플리케이션의 책임입니다.

읽기 전용 method와 승인 대기 상태로 멈출 method를 정해야 해요. rollback 가능 여부와 실행 로그에 민감정보가 남지 않는지도 확인해야 합니다.

## Slack 에이전트에 적용할 수 있는 지점

첫 번째 후보는 agent/code-reviewer입니다. github와 pr-review-loop도 포함돼요.

PR detail, file list, diff, 기존 review thread, 체크 결과를 조합할 때 모든 diff를 모델에 넣을 필요는 없습니다. sandbox 안에서 파일 크기와 확장자로 분류해요. 리뷰 가치가 낮은 generated file을 제외한 뒤 “검토해야 할 변경 묶음”만 반환할 수 있죠.

두 번째 후보는 slack-collector와 slack-inbox입니다. Slack thread context 수집은 메시지 수, 작성자, 시간 범위, 첨부 링크에 따라 분기가 많아요.

connector method로 메시지를 가져옵니다. bot 메시지와 중복 인용, 오래된 context를 줄인 뒤 최종 context pack만 반환하는 방식이 맞죠.

세 번째 후보는 crawler입니다. Puppeteer와 Cheerio로 가져온 결과는 원문이 길고 잡음도 많아요.

Code Mode가 crawler 자체를 대신할 필요는 없습니다. 여러 crawl 결과에서 제목·본문 후보·링크를 걸러 모델이 읽을 최소 자료로 줄이는 orchestration layer가 될 수 있죠.

반대로 agent/vacation처럼 자연어 파라미터 추출만 LLM에 맡기고 계산은 결정적인 모듈에서 처리하는 작업은 적합하지 않습니다. 후보에서 빼는 게 맞아요.

실행 lifecycle과 evidence 기록을 맡는 agent-run 같은 핵심 인프라도 Code Mode로 옮기지 않는 편이 자연스럽습니다. Code Mode 실행을 감싸는 바깥 감사 레이어로 남는 편이 자연스러워요.

## 도입 전에 확인할 조건

먼저 GitHub PR diff 수집처럼 side effect가 없는 읽기 전용 connector로 검증해야 합니다. search, describe, connector method 호출과 최종 result shaping이 한 번에 동작하는지 확인해요.

비교 기준은 모델 라운드트립 횟수가 아닙니다. 중간 데이터가 모델 컨텍스트로 얼마나 덜 돌아오는지를 봐야 하죠.

그다음 requiresApproval: true인 method가 실제로 paused 상태와 pending action으로 멈추는지 확인해야 합니다. 같은 execution을 replay할 때 codemode.step()으로 기록한 작업이 기대대로 재사용되는지도 봐야 해요.

두 가지 검증이 먼저입니다. 끝나기 전에는 쓰기 작업이나 운영 자동화에 연결하면 안 돼요.

Code Mode의 가치는 단순히 도구 호출을 줄이는 데 있지 않습니다. 도구가 많고 중간 결과가 큰 작업에서는 제어 흐름과 데이터 축약을 sandbox로 옮겨요.

모델에는 판단에 필요한 결과만 전달합니다. 고정된 작업을 모두 바꾸기보다 복잡한 orchestration 구간부터 읽기 전용으로 검증하는 게 적절하죠.

출처는 Cloudflare Agents Code Mode 문서와 How Code Mode works 문서입니다. Durable runtime 문서와 cloudflare/agents 공식 저장소 README도 참고했어요.
