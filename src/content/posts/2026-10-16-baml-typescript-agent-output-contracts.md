---
title: "BAML로 TypeScript 에이전트의 출력 계약 분리하기"
description: "BAML이 TypeScript 기반 Slack 에이전트의 프롬프트·출력 타입·파싱 계약을 어떻게 분리할 수 있는지와 현실적인 도입 범위를 살펴본다."
pubDatetime: 2026-10-16T09:00:00+09:00
category: backend
---

Slack 에이전트가 하나뿐이라면 프롬프트 문자열과 파서 함수 하나씩으로도 버틸 수 있어요. 응답이 JSON처럼 오기를 기대하다가 실패하면 정규식으로 조금 보정하고, 테스트도 “이 예시 문자열을 넣으면 이 타입이 나온다” 정도로 만들면 돼요. 문제는 에이전트가 늘어난 뒤부터 생겨요. PM 에이전트는 DailyPlan을 만들고, Work Reviewer는 업무 로그를 만들고, Code Reviewer는 PR 리뷰를 만들어요. 저마다 프롬프트와 출력 타입, 실패 처리가 조금씩 다르다 보니 어느 순간 “이 타입은 코드에 있는데 프롬프트는 아직 옛날 약속을 말하고 있는” 상태가 돼요.

이 글은 BAML 공식 문서, TypeScript 설치 문서, baml_client 문서, 공식 GitHub 저장소와 홈페이지를 읽고 정리했어요. 직접 프로젝트에 설치해 운영해 본 후기는 아니에요. 그래서 “바로 도입하면 된다”기보다는 “어디의 계약을 떼어낼 수 있고, 어디는 아직 조심해야 하는가”에 초점을 맞췄어요.

## 프롬프트가 많아질수록 진짜 문제는 모델 호출이 아니라 계약이 된다

LLM 기능을 처음 붙일 때 가장 먼저 눈에 들어오는 건 모델 호출 코드예요. 어떤 SDK를 쓸지, 어떤 모델 이름을 넣을지, timeout을 얼마로 둘지 같은 선택부터 보이죠. 정작 유지보수 비용은 다른 곳에서 커져요. 입력에 무엇을 넣어야 하는지, 출력은 어떤 모양이어야 하는지, 모델이 형식을 깨면 어떻게 복구할지, 프롬프트를 바꿀 때 타입과 테스트도 함께 바뀌었는지 계속 확인해야 하거든요.

TypeScript 백엔드에서는 보통 Zod, JSON Schema, 수동 parser, DTO 테스트로 이 문제를 막아요. 익숙하면서도 강력한 방식이지만 계약이 앱 코드 곳곳에 흩어져요. 프롬프트는 prompt.ts에, 출력 타입은 type.ts에, parser는 output-parser.ts에 있고 재시도 정책은 model provider 주변에 있어요. 테스트도 별도 spec 파일에 들어가요. 하나씩 보면 잘 정리돼 있어도 전체 계약은 한눈에 들어오지 않아요.

BAML은 바로 이 경계를 겨냥해요. “LLM을 호출하는 더 편한 SDK”라기보다는 “LLM function 계약을 별도 파일에 선언하고, 그 계약으로 언어별 클라이언트를 생성하는 도구”에 가까워요. OpenAPI가 HTTP API의 요청과 응답 계약을 앱 코드 밖에 두듯이, BAML은 LLM 호출의 입력과 출력, 프롬프트, 테스트 가능성을 .baml 파일 쪽으로 옮겨요.

## BAML은 앱 코드 안의 파서가 아니라 별도 계약 파일을 만든다

BAML의 기본 단위는 함수예요. .baml 파일에 function X(input) -> Output 형태로 LLM 호출을 선언한 뒤, TypeScript 코드에서는 생성된 baml_client로 그 함수를 호출해요. 공식 소개 문서는 날씨 질의에서 도시와 시간을 뽑아내는 함수를 예시로 들어요.

```plain text
class WeatherAPI {
  city string @description("the user's city")
  timeOfDay string @description("As an ISO8601 timestamp")
}

function UseTool(user_message: string) -> WeatherAPI {
  client "openai-responses/gpt-5-mini"
  prompt #"
    Extract.... {# we will explain the rest in the guides #}
  "#
}
```

이 예시에서 중요한 건 날씨가 아니에요. WeatherAPI라는 출력 구조와 UseTool이라는 LLM 호출이 같은 계약 파일에 들어 있다는 점이에요. 이 시스템에 대입하면 WeatherAPI 자리에는 DailyPlan, WorklogDraft, PullRequestReview 같은 도메인 출력 타입이 들어가고, UseTool 자리는 /today, /worklog, /review-pr의 내부 LLM 호출 하나에 해당해요.

기존 방식과의 차이도 여기서 생겨요. Zod나 JSON Schema를 앱 코드 안에서 쓰면 “모델 응답을 받은 뒤 검증하는 코드”가 돼요. BAML은 그보다 앞에서 “이 LLM 호출은 애초에 이런 입력을 받고 이런 출력을 돌려주는 함수다”라고 선언하고, 그 선언으로 TypeScript 클라이언트와 타입을 만들어요. 파서가 사라진다기보다는 파싱과 보정 책임이 생성 클라이언트 쪽으로 옮겨가는 셈이에요.

## TypeScript에서는 baml_client가 애플리케이션과 계약 사이를 잇는다

TypeScript에 도입하는 과정은 비교적 간단해요. npm 패키지를 설치하고 기존 프로젝트에서 초기화 명령을 실행한 다음, baml_src의 .baml 파일로 baml_client를 생성해요. 공식 TypeScript 설치 문서도 다음 명령을 기본 경로로 안내해요.

```bash
npm install @boundaryml/baml
npx baml-cli init
npx baml-cli generate
```

생성된 baml_client는 애플리케이션 코드에서 import해 사용해요. 공식 예시는 ExtractResume 함수로 이 흐름을 보여줘요.

```typescript
import { b } from "./baml_client"
import type { Resume } from "./baml_client/types"

async function Example(raw_resume: string): Promise<Resume> {
  const response = await b.ExtractResume(raw_resume);
  return response;
}

async function ExampleStream(raw_resume: string): Promise<Resume> {
  const stream = b.stream.ExtractResume(raw_resume);
  for await (const msg of stream) {
    console.log(msg)
  }

  return await stream.getFinalResponse();
}
```

이 코드에서 애플리케이션은 JSON 문자열을 직접 다루지 않아요. b.ExtractResume(...)은 완성된 Resume을 반환하고, streaming 호출은 중간 partial 메시지를 순회한 뒤 최종 응답을 받아요. Slack 에이전트 시스템이라면 이 호출은 application layer의 usecase 안에 자리 잡게 돼요. 예를 들어 GenerateDailyPlanUsecase가 지금 model router를 호출한 뒤 parser를 거친다면, 실험 단계에서는 parser 하나를 BAML 함수 호출로 바꿔 볼 수 있어요.

빌드 연동도 중요해요. 생성 클라이언트를 쓰면 언제나 “소스 계약”과 “생성물”을 동기화해야 하거든요. 공식 문서는 build 전에 generate를 실행하는 예시를 제시해요.

```json
{
  "scripts": {
    "baml-generate": "baml-cli generate",
    "build": "npm run baml-generate && tsc --build"
  }
}
```

NestJS 프로젝트라면 이 줄을 그대로 복사하기보다 기존 pnpm build, pnpm lint:check, pnpm test 흐름에 맞춰야 해요. 생성물을 커밋할지, CI에서 매번 재생성만 할지, PR diff에 생성 코드가 함께 올라오면 리뷰할지 무시할지부터 정해야 해요. BAML을 도입하며 처음 치르는 비용은 LLM이 아니라 저장소 운영 규칙에서 생겨요.

## BAML의 장점은 운영 장애보다 개발 루프에서 먼저 보인다

BAML을 쓰면 프롬프트와 타입을 가까이 둘 수 있다는 장점이 바로 드러나요. 모델 응답을 검증하는 코드를 아무리 잘 짜도 프롬프트가 타입을 정확히 설명하지 않으면 계약은 흔들려요. BAML은 함수 정의 안에서 client, prompt, input, output을 함께 다루기 때문에 “이 호출이 무엇을 약속하는지”를 작은 파일 하나로 읽을 수 있어요.

개발 도구도 이 방향에 맞춰져 있어요. VSCode/Cursor 확장은 문법 하이라이팅, testing playground, prompt preview, 저장 시 generate 실행 같은 기능을 제공해요. 운영 중 자동 복구를 돕는다기보다 개발할 때 빠르게 피드백을 받도록 해주는 기능이에요. 프롬프트를 고쳤을 때 실제 요청이 어떻게 보이는지 미리 확인하고, 테스트를 돌린 뒤 생성 타입이 바뀌었는지 살펴보는 흐름이에요.

baml_client 문서에 따르면 생성 클라이언트는 LLM endpoint 호출, 출력 파싱, 깨진 JSON 보정, 타입 있는 객체 반환, 에러 처리를 맡아요. TypeScript 코드에서 수동 parser를 줄일 수 있다는 뜻이지만 에러 처리의 경계도 달라져요. 기존에는 DailyPlanOutputParser가 던진 예외를 application layer가 잡았다면, BAML을 도입한 뒤에는 생성 클라이언트의 실패를 어떤 도메인 예외로 감쌀지 다시 정해야 해요.

| 구분 | 기존 수동 parser 중심 | BAML 함수 중심 |
| --- | --- | --- |
| 계약 위치 | TypeScript 코드 여러 파일 | .baml 함수 파일 |
| 타입 사용 | DTO, interface, Zod 등 | 생성된 baml_client/types |
| 프롬프트 확인 | 코드/문자열 직접 확인 | editor preview/playground 흐름 |
| 빌드 이슈 | 일반 TS 컴파일 중심 | generate와 생성물 동기화 추가 |
| 도입 단위 | 함수/유틸 단위 | LLM 호출 계약 단위 |

## 지금은 v0 문서와 v1 베타 포지셔닝을 분리해서 읽어야 한다

BAML을 검토할 때 가장 주의해야 할 점은 서로 다른 세대의 문서가 섞여 있다는 거예요. docs.boundaryml.com의 baml_client markdown에는 이 사이트가 BAML v0 legacy DSL을 문서화하고 있으며, BAML v1은 별도의 public beta 언어라는 notice가 붙어 있어요. 홈페이지와 GitHub README는 “programming language for agents”라는 더 큰 포지션을 내세워요.

이 차이는 사소하지 않아요. TypeScript 프로젝트에 당장 붙일 때 필요한 건 v0 스타일의 .baml 함수, baml_src, baml_client, baml-cli generate 흐름이에요. 홈페이지의 v1 설명은 no any, typed errors, green threads, observability, agent-first tooling 같은 더 넓은 언어 비전까지 담고 있어요. 둘을 섞어 읽으면 “지금 TypeScript 백엔드에 설치하면 이 모든 언어 기능을 바로 쓰는가”라는 오해가 생겨요.

도입을 검토할 때는 먼저 버전을 고정해야 해요. @boundaryml/baml 버전, generator block의 runtime version, CLI 설치 경로를 명시해야 해요. 생성 클라이언트를 커밋한다면 PR에서 버전 변경과 생성 diff를 함께 보고, 커밋하지 않는다면 CI가 generate를 실행한 뒤 타입 체크까지 통과해야 해요. 어느 쪽을 택하든 “내 로컬에서는 생성돼 있었다”는 상태를 허용하면 계약 레이어가 오히려 새로운 드리프트 원인이 돼요.

:::callout ⚠️ red

BAML을 “새 에이전트 프레임워크”로 들여오면 기존 model-router, agent-run, provider 추상화와 책임이 겹쳐요. 이 시스템에서는 우선 출력 계약 하나를 떼어내는 도구로 보는 편이 맞아요.

:::

## 이 시스템에서는 /today나 /worklog 하나부터 떼어내는 편이 맞다

이 시스템에서 BAML과 가장 직접적으로 맞닿는 모듈은 model-router, agent-run, agent/pm, agent/work-reviewer, agent/code-reviewer예요. model-router는 AgentType에 따라 모델 provider를 고르고, agent-run은 실행 라이프사이클과 evidence를 남겨요. BAML을 도입하더라도 이 둘을 곧바로 대체할 이유는 크지 않아요. 이미 시스템 레벨에서 실행 추적과 라우팅을 맡고 있기 때문이에요.

각 agent의 output parser는 좋은 후보예요. agent/pm의 DailyPlan, agent/work-reviewer의 Worklog, agent/code-reviewer의 PR review는 모두 “LLM에게 자유 텍스트를 주고 구조화된 결과를 기대하는” 호출이라 BAML의 함수 모델과 잘 맞아요. 특히 /today에는 사용자 입력, GitHub assigned task, 전일 plan이 섞이고 최종 출력은 Slack formatter가 읽을 수 있는 구조여야 해요. 프롬프트와 출력 타입이 어긋나면 사용자가 바로 알아차려요.

모든 모듈을 연결할 필요는 없어요. agent/delay-report처럼 결정론적 조회가 핵심인 모듈은 BAML을 먼저 적용할 이유가 적어요. agent/vacation처럼 자연어 파라미터 추출에만 LLM을 쓰는 곳은 후보가 될 수 있지만 계산 자체는 기존 도메인 로직에 남겨야 해요. crawler, prisma, market-data, backtest처럼 LLM 출력 계약이 핵심이 아닌 모듈까지 억지로 연결할 필요는 없어요.

## 도입한다면 프레임워크 교체가 아니라 계약 실험으로 시작해야 한다

첫 실험의 목표는 “BAML을 전체 에이전트 런타임으로 쓴다”가 아니라 “기존 parser 하나를 BAML 함수로 표현할 수 있는지 본다”여야 해요. 예를 들어 agent/pm의 출력 타입을 .baml class로 옮기고 prompt에 DailyPlan 생성 규칙을 넣은 뒤, TypeScript usecase에는 b.GenerateDailyPlan(...) 같은 생성 클라이언트 호출만 남길 수 있어요. 이때 AgentRunService.execute와 ModelRouterUsecase까지 동시에 바꾸면 무엇이 좋아졌는지 따로 확인하기 어려워요.

CI 규칙도 실험에 포함해야 해요. 기존 프로젝트가 코드 변경 후 pnpm lint:check, pnpm test, pnpm build를 요구한다면 BAML generate를 이 셋 중 어디에 넣을지 정해야 해요. build 전에 generate를 넣으면 동기화하기는 쉬워지지만 build 시간이 늘어나고, 생성물이 매번 바뀌는지도 확인해야 해요. generate 전용 check를 만들면 더 명확한 대신 관리할 명령이 하나 늘어요.

이 단계에서는 두 가지만 확인하면 충분해요. BAML 함수로 바꿨을 때 수동 parser 코드와 테스트가 실제로 줄어드는지, 실패했을 때 도메인 예외와 Slack 응답 포맷이 더 명확해지는지를 보면 돼요. 둘 중 어느 하나도 좋아지지 않는다면 BAML은 아직 이 시스템의 병목을 해결하지 못한 거예요.

## 다음에 확인할 것은 생성물 정책과 모델 라우팅의 경계다

다음 조사에서는 작은 브랜치를 직접 만들어 agent/pm 또는 agent/work-reviewer의 출력 계약 하나를 BAML로 옮겨 봐야 해요. 설치 자체보다 중요한 건 diff가 어떤 모양으로 나오는지예요. .baml 파일이 얼마나 읽기 쉬운지, 생성된 baml_client가 리뷰할 수 있는 크기인지, 기존 테스트는 어떻게 바뀌는지 확인해야 해요.

모델 라우팅과 BAML client 사이의 책임 경계도 살펴봐야 해요. BAML 함수 안에도 client가 있고 기존 시스템에도 model-router가 있으니, 둘 다 모델을 선택하면 책임이 겹쳐요. 실험에서는 BAML의 client 선언을 최소화한 채 기존 라우터 정책을 어떻게 반영할 수 있는지 확인해야 해요. 이 부분을 정리하지 못하면 BAML은 계약 레이어가 아니라 두 번째 라우터가 돼요.

:::toggle 📚 출처

- https://docs.boundaryml.com/guide/introduction/what-is-baml
- https://docs.boundaryml.com/guide/installation-language/typescript
- https://docs.boundaryml.com/guide/introduction/baml_client.md
- https://github.com/BoundaryML/baml
- https://boundaryml.com
- https://boundaryml.com/quickstart

:::
