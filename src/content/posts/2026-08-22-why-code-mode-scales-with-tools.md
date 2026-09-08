---
title: "도구가 많을수록 Code Mode가 맞는 이유"
description: "Cloudflare Agents SDK의 Code Mode가 복잡한 도구 실행 계획과 중간 데이터를 어떻게 다루며, 어떤 작업에 적용할 만한지 살펴본다."
pubDatetime: 2026-08-22T19:05:00+09:00
category: backend
---
Slack에서 “이 PR 리뷰해줘”라고 말하는 건 겉보기에 단순하지만, 구현부에서는 여러 도구를 호출하고 큰 중간 결과까지 처리해야 해요. Cloudflare Agents SDK의 Code Mode는 도구를 하나 더 보태는 기능이 아니에요. 커진 도구 목록을 코드로 조합하고 필요한 결과만 모델에 돌려주는 실행 방식이죠. 아래는 공식 문서와 저장소 README를 읽고 정리한 내용이고, 제 Slack 에이전트에 붙여 돌려본 건 아직 아니에요.

## 도구가 많아질수록 생기는 문제

도구 호출 과정은 한 줄로 끝나지 않고, 그 자체로 작은 실행 계획이 돼요. PR 메타데이터를 조회한 뒤 파일 목록을 분류하고 큰 diff는 나눠야 하며, 테스트·설정 파일을 구분하고 기존 리뷰 스레드도 확인해야 하니까요.

일반적인 tool calling은 단계마다 모델 밖으로 나갔다가 결과와 함께 모델 컨텍스트로 돌아와요. 중간 결과가 커질수록 모델 컨텍스트에 쌓이는 입력이 늘고, 최종 판단에 필요 없는 원본 목록까지 모델이 계속 보게 되죠. 긴 diff와 임시 분류 결과도 마찬가지예요.

Code Mode에서는 모델이 작업별로 요청을 따로 보내지 않고 JavaScript 코드를 작성하니, 요청 방식부터 달라지는 셈이에요. 모델은 여러 도구를 직접 받지 않고 codemode라는 하나의 바깥 도구에 코드를 넘기는데, 그 코드가 configured tools를 호출하고 결과를 처리한 뒤 최종 응답에 필요한 값만 반환하는 실행 계획이 돼요.

아래 블록은 작성자 재구성이에요. Code Mode API reference 문서의 입출력 정의를 이 글의 맥락에 맞게 다시 적은 것이고, 문서에서 출력 타입의 이름은 `ProxyToolOutput`이에요.

```typescript
type CodeModeInput = {
  code: string;
};

type CodeModeOutput =
  | { status: "completed"; executionId: string; result: unknown; logs?: string[] }
  | { status: "paused"; executionId: string; pending: PendingAction[] }
  | { status: "error"; executionId: string; error: string; logs?: string[] };
```

여기서 `PendingAction`은 Code Mode API reference 문서에 `executionId`와 순번 `seq`, 그리고 멈춘 호출을 가리키는 `connector`·`method`·`args`로 정의돼 있어요.

핵심 차이는 제어 흐름이 어디에 놓이느냐예요. direct tool call에서는 모델이 tool → result → next tool을 반복해요. Code Mode는 loop, branch, filter, transform 같은 중간 제어를 sandbox 안의 코드로 옮기고요. host(sandbox 바깥에서 connector가 이어 주는 서비스를 쥐고 있는 쪽)가 위험한 호출을 pending action으로 멈추면 그 실행이 paused 상태가 되므로, 승인·감사·재실행의 경계를 잡을 수 있어요. 나머지 한 갈래인 `status: "error"`는 sandbox 오류와 replay 오류일 때 돌아오고, 이때도 오류가 모델 tool call 쪽으로 던져지지는 않는다고 Code Mode API reference 문서가 적어요.

## 필요한 도구만 찾아서 실행한다

Code Mode의 또 다른 핵심은 progressive tool discovery예요. 큰 tool catalog를 처음부터 모델 컨텍스트에 모두 넣지 않고, sandbox 안에서 codemode.search()와 codemode.describe()로 필요한 connector나 method를 검색해 특정 path의 타입 설명만 가져와요.

아래 선언은 Code Mode API reference 문서에 실린 정의 그대로예요.

```typescript
declare const codemode: {
  search(query: string): Promise<SearchOutput>;
  describe(target: string): Promise<DescribeOutput>;
  step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  run(name: string, input?: unknown): Promise<unknown>;
};
```

search는 전체 스키마를 넘기는 대신 관련 path 목록을 반환하고, describe는 선택한 대상의 TypeScript 문서를 돌려줘요. step은 replay를 위해 비결정적이거나 side effect가 있는 작업을 기록하고, run은 저장된 snippet을 실행해요. 반환 타입도 같은 문서에 있어요. `SearchOutput`은 결과 목록 `results`와 전체 개수 `total`, 목록이 잘렸는지 알리는 `truncated`로 이뤄지고, `DescribeOutput`은 `path`와 선택 필드인 `description`·`requiresApproval`, 타입 설명 `types`, 그리고 대상이 connector인지 method인지 snippet인지 알리는 `kind`를 담아요.

connector는 sandbox global로 노출돼요. github라는 connector가 있다면 generated code는 github global을 통해 method를 호출해요. How Code Mode works 문서를 보면 sandbox에는 표준 JavaScript global이 있고, Node.js API와 host credentials, process, require, unrestricted network access는 노출되지 않아요. sandbox 안의 worker는 인터넷 통신도 금지돼서 global `fetch()`와 `connect()`가 오류를 던지고요. 그래서 외부 작업은 connector global이나 executor(코드를 실행하되 상태는 저장하지 않는 구성 요소)가 명시적으로 제공한 capability를 통해야 해요.

## Durable runtime이 실행 경계를 대신 잡아 준다

### Durable Object와 Vite부터 맞춰야 한다

Code Mode를 Agents SDK 애플리케이션에 붙일 때 실행 상태를 지켜 주는 쪽은 Cloudflare의 durable runtime이에요. 전제는 Durable Object(런타임이 실행 상태를 담아 두는 저장 단위)와 Vite, 그리고 Worker Loader binding(아래 설정의 `worker_loaders` 항목으로 선언하는 binding)이에요. 그 대가로 Durable Object hibernation(그 객체가 잠들었다 다시 깨어나는 구간) 뒤에도 execution history와 pending approvals를 저장하고, reusable snippets와 rollback metadata까지 남겨 둬요.

설정은 `wrangler.toml`에 넣어요. durable runtime 문서는 같은 내용을 `wrangler.json`으로도 보여 줘요.

```toml
compatibility_date = "2026-08-22"
compatibility_flags = ["nodejs_compat"]

[[worker_loaders]]
binding = "LOADER"
```

`nodejs_compat`이 앞 절의 sandbox 차단 목록과 부딪히는 것처럼 보이지만, 이 플래그는 Worker 본체 설정이고 차단 목록은 sandbox 안쪽 이야기예요. 다만 문서가 `nodejs_compat`을 왜 켜야 하는지는 설명하지 않아서, 이유는 확인하지 못했어요.

최소 재현 조건은 이 정도로 잡혀요.

- Durable Object와 Worker Loader binding을 쓸 수 있는 Workers 프로젝트, 그리고 위 `compatibility_date`·`compatibility_flags` 설정
- 문서가 언급한 패키지인 `@cloudflare/codemode`, `@cloudflare/ai-chat`, `@cloudflare/vite-plugin`, `agents`, `ai`
- 각 패키지의 버전은 **미확인** — 문서에 버전 표기가 없어요

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

Code Mode Vite plugin은 Worker entry module에서 CodemodeRuntime facet class를 export해요. 여기서 facet은 Durable Object 안에서 실행 상태가 담기는 단위예요. plugin을 쓰지 않는다면 `export { CodemodeRuntime } from "@cloudflare/codemode";`를 직접 추가해야 하고요. durable runtime 문서는 런타임이 실행 상태를 Durable Object facet에 저장하고, Workers runtime이 facet class를 `ctx.exports`(Workers runtime이 facet class에 닿는 통로)로 찾을 수 있어야 한다고 적어요.

### connector는 평범한 class로 쓴다

connector는 평범한 class예요. name()은 sandbox global 이름이 되고, instructions()는 모델에 사용법을 알려주며, tools()는 호출할 수 있는 method를 정의해요. 감싸는 대상이 직접 작성한 코드로 한정되지도 않아요. How Code Mode works 문서를 보면 connector는 host 측 서비스를 sandbox로 잇는 장치예요. MCP(Model Context Protocol, 모델에 도구를 붙이는 표준) 서버와 OpenAPI 문서, AI SDK toolset, 직접 작성한 코드를 감쌀 수 있고, 감싼 결과는 각각 하나의 global namespace가 돼요. sandbox 안 코드 입장에서는 무엇을 감쌌든 global 하나로 보이는 셈이죠. 그 호출은 Workers RPC로 sandbox 경계를 넘고, runtime이 connector를 실행하기 전에 호출을 하나씩 가로채 승인·로깅·replay·rollback 정책을 적용해요. durable runtime 문서의 NotesConnector 예시에서는 createNote가 requiresApproval: true로 설정돼 있어 실행 전에 멈추고, revert 함수는 rollback compensation(되돌리기용 보상 동작)도 제공하고요.

이 글에는 connector class 코드를 싣지 않았어요. 문서 예시를 옮겨 적기보다 아래 참고 자료의 링크로 남기는 편이 낫다고 봤거든요. 확인하지 못한 범위도 적어 둘게요. snippet이 runtime facet에 남는다는 것까지는 문서에서 확인했지만, 어떤 코드가 언제 snippet으로 저장되는지와 codemode 도구를 애플리케이션의 어느 지점에 등록하는지는 확인하지 못했어요.

## 모든 작업에 Code Mode가 필요한 것은 아니다

Code Mode는 experimental이에요. Code Mode 문서와 How Code Mode works 문서가 모두 breaking changes 가능성을 적어 두고, Code Mode 문서는 프로덕션에서 조심해서 쓰라는 문장까지 덧붙여요. 안정적으로 동작하는 NestJS, BullMQ, Prisma, Slack Bolt 기반 시스템의 본체를 교체하기보다, orchestration 일부를 검증하는 실험 계층으로 보는 편이 안전해요.

호출 순서가 정해진 작업에는 direct tool call이 더 알맞아요. 단일 Slack 응답과 고정된 DB 조회, 버튼 승인 처리, 단순 파라미터 추출이 여기에 해당해요. 반대로 루프·분기·필터링·결과 축약이 반복될 때는 Code Mode가 의미 있어요.

중간 결과가 크거나 도구 목록이 커서 progressive discovery의 이득이 있는 작업에도 잘 맞아요. 다만 sandbox가 Node.js API와 unrestricted network access를 막더라도 connector 설계는 애플리케이션의 책임이에요. 읽기 전용 method와 승인 대기 상태로 멈출 method를 직접 정해야 하고, rollback 가능 여부와 실행 로그에 민감정보가 남지 않는지도 함께 확인해야 해요.

## 우리 Slack 에이전트라면 여기부터 바꾼다

첫 번째 후보는 agent/code-reviewer이고, 여기에는 제 저장소의 github 모듈과 pr-review-loop도 포함돼요. 앞에서 sandbox connector 이름으로 들었던 github와는 다른, 저장소 안의 모듈 이름이에요. PR detail, file list, diff, 기존 review thread, 체크 결과를 조합해도 모든 diff를 모델에 넣을 필요는 없어요. sandbox 안에서 파일 크기와 확장자로 분류한 뒤 리뷰 가치가 낮은 generated file을 제외하고, “검토해야 할 변경 묶음”만 반환할 수 있죠.

두 번째 후보는 slack-collector와 slack-inbox예요. Slack thread context를 모을 때는 메시지 수와 작성자, 시간 범위, 첨부 링크에 따라 분기가 많아요. connector method로 메시지를 가져온 뒤 bot 메시지와 중복 인용, 오래된 context를 줄이고 최종 context pack만 반환하는 방식이 맞죠.

세 번째 후보는 crawler예요. Puppeteer와 Cheerio로 가져온 결과는 원문이 길고 잡음도 많죠. Code Mode가 crawler 자체를 대신할 필요는 없고, 여러 crawl 결과에서 제목·본문 후보·링크를 걸러 모델이 읽을 최소 자료로 줄이는 orchestration layer가 될 수 있어요.

반대로 agent/vacation처럼 자연어 파라미터 추출만 LLM에 맡기고 계산은 결정적인 모듈에서 처리하는 작업에는 맞지 않으니 후보에서 빼는 게 맞아요. agent-run은 실행 lifecycle과 evidence 기록을 맡는 핵심 인프라라, Code Mode로 옮기기보다 실행을 감싸는 바깥 감사 레이어로 남는 편이 자연스럽고요.

## 붙이기 전에 두 가지를 먼저 확인한다

먼저 GitHub PR diff 수집처럼 side effect가 없는 읽기 전용 connector로 검증해야 해요. search, describe, connector method 호출과 최종 result shaping이 한 번에 동작하는지 확인하는 거예요. 비교 기준은 모델 라운드트립 횟수가 아니라, 중간 데이터가 모델 컨텍스트로 얼마나 덜 돌아오는지예요.

그래서 측정 계약을 이렇게 잡아 뒀어요. 세는 값은 PR 리뷰 실행 한 번에서 tool 결과로 모델 컨텍스트에 들어간 입력 토큰 수(단위는 토큰)이고, 재는 자리는 실행 lifecycle과 evidence를 남기는 agent-run이에요. 바꾸기 전에 지금의 direct tool call 경로에서 같은 PR을 리뷰하며 이 값을 먼저 기록해 전 값으로 두고, Code Mode 경로의 값을 같은 자리에서 재서 나란히 놓을 생각이고요. 아직 어느 쪽도 재지 않았으니 이 글에 비교 수치는 없어요.

그다음 requiresApproval: true인 method가 실제로 paused 상태와 pending action으로 멈추는지 확인해야 해요. 실패 경로도 검증 항목이에요. sandbox 오류나 replay 오류로 `status: "error"`가 돌아왔을 때 실행 기록과 Slack 응답이 각각 어떤 상태로 남는지 확인해야 하고, 같은 코드를 두 번 실행했을 때 codemode.step()으로 기록한 작업이 정말 재사용되는지 아니면 createNote 같은 쓰기 method의 side effect가 두 번 일어나는지도 봐야 해요. 이 두 가지 검증이 끝나기 전에는 쓰기 작업이나 운영 자동화에 연결하면 안 돼요.

Code Mode에서 제일 마음에 걸린 건 도구 호출 횟수가 아니라, 모델이 안 봐도 되는 데이터를 걸러 낼 책임이 어디로 가느냐였어요. 아직 문서만 읽은 단계라 제가 겪은 실패 사례는 없고, 대신 붙였을 때 깨질 것으로 보는 지점을 미리 적어 둘게요. 그 책임을 sandbox 코드로 옮기면 이번엔 connector 설계가 새 병목이 될 것 같고, 승인과 replay를 남기려면 호출 인자를 기록해야 하니 실행 로그에 민감정보가 함께 남을 위험도 있어요. 어떤 method를 읽기 전용으로 둘지는 결국 사람이 정해야 하는데, 이게 제일 먼저 밀릴 판단이라고 봐요.

도구 목록이 늘어날수록 그 판단을 미루기가 어려워지니, agent/code-reviewer의 diff 축약처럼 무엇을 버릴지 이미 아는 곳부터 손대는 게 낫겠다 싶어요.

## 참고 자료

Code Mode는 experimental이라 문서 내용이 확인 시점에 따라 달라질 수 있어요. 아래 자료는 글을 올린 뒤 출처를 다시 짚으며 2026년 9월 8일에 직접 열어 확인했어요.

| 제목 | 자료 링크 | 본문에서 받치는 곳 | 확인일 |
| --- | --- | --- | --- |
| Code Mode | [직접 링크](https://developers.cloudflare.com/agents/tools/codemode/) | 「모든 작업에 Code Mode가 필요한 것은 아니다」 절의 experimental·breaking changes 표시 | 2026-09-08 |
| How Code Mode works | [직접 링크](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/) | 「필요한 도구만 찾아서 실행한다」 절의 sandbox 노출 차단 목록과 executor의 역할, 「connector는 평범한 class로 쓴다」 절의 connector가 감싸는 대상과 Workers RPC 경계 | 2026-09-08 |
| Create a durable Code Mode runtime | [직접 링크](https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/) | 「Durable Object와 Vite부터 맞춰야 한다」 절의 wrangler 설정과 facet·`ctx.exports` 문장, 「connector는 평범한 class로 쓴다」 절의 NotesConnector 예시 | 2026-09-08 |
| Code Mode API reference | [직접 링크](https://developers.cloudflare.com/agents/tools/codemode/api-reference/) | 두 타입 블록의 정의, `PendingAction`·`SearchOutput`·`DescribeOutput` 필드, `status: "error"`가 돌아오는 조건 | 2026-09-08 |
| cloudflare/agents 저장소의 codemode 패키지 | [직접 링크](https://github.com/cloudflare/agents/tree/main/packages/codemode) | 「connector는 평범한 class로 쓴다」 절의 name()·instructions()·tools() 구성 | 2026-09-08 |
