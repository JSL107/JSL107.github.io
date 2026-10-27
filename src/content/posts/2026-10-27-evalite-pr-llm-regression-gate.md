---
title: "Evalite로 PR에서 LLM 회귀 잡기"
description: "Evalite로 자연어 라우팅과 PR 리뷰의 회귀를 평가하려면 작은 고정 데이터셋과 안정적인 기준선부터 만들어야 한다."
pubDatetime: 2026-10-27T19:44:00+09:00
category: note
---

Slack으로 LLM 에이전트를 운영하다 보면 명령과 로그는 정상인데 답변이 조금씩 엉뚱한 방향으로 가는 문제를 뒤늦게 발견해요. 이 글은 Evalite 공식 문서, v1 beta 문서, AI SDK 예제, 공식 GitHub 저장소를 읽고 정리한 조사예요. 직접 설치해서 이대리에 붙여 돌린 경험담은 아니에요.

## 기존 테스트가 놓치는 회귀

자연어 요청을 분류할 후보를 하나 추가했더니 애매한 말이 엉뚱한 작업자로 가거나, PR 리뷰 포맷을 다듬었더니 중요한 지적이 요약 아래 묻힐 수 있어요. 기존 테스트로는 JSON schema가 맞는지, 함수가 예외 없이 끝나는지, 저장소에 기록이 남는지 확인할 수 있어요. 하지만 답변이 기대한 의도에 충분히 가까운지, 리뷰가 실제 diff의 문제를 놓치지 않았는지는 pass/fail 하나로 가르기 어려워요. Evalite는 LLM 호출을 TypeScript 코드 안에서 평가할 작업으로 감싸고 입력마다 점수를 남겨요.

## Evalite의 평가 구조

Evalite는 LLM 평가 SaaS보다 `.test.ts` 옆에 `.eval.ts`를 두고 쓰는 테스트 러너에 가까워요. 공식 문서도 `.eval.ts`를 새로운 `.test.ts`처럼 설명하면서 Vitest 위에 만들어졌다는 점을 강조해요. 기존 fixture와 mock, TypeScript 타입을 평가 코드에 재사용할 수 있어요.

`data`로 입력과 기대값을 만들고, `task`로 실제 실행할 일을 감싼 뒤 `scorers`로 출력에 점수를 매겨요. 빠른 시작 예제는 LLM을 호출하는 대신 문자열을 붙여 이 구조를 보여줘요.

```typescript
import { evalite } from "evalite";

import { Levenshtein } from "autoevals";

evalite("My Eval", {
  // An array of test data
  // - TODO: Replace with your test data
  data: [{ input: "Hello", expected: "Hello World!" }],

  // The task to perform
  // - TODO: Replace with your LLM call
  task: async (input) => {
    return input + " World!";
  },

  // The scoring methods for the eval
  scorers: [Levenshtein],
});
```

예제의 Hello 자리에 이대리 사용자의 자연어 발화나 PR diff 일부를 넣을 수 있어요. `task`에는 자연어를 어느 작업으로 보낼지 고르는 함수나 diff로 리뷰 초안을 만드는 함수를 넣으면 돼요. `expected`는 정답 문자열일 수도 있고, 반드시 포함해야 할 판단이나 선택해야 할 작업 종류처럼 잘게 나눈 기대값일 수도 있어요.

공식 사이트에는 v1 beta 안내도 함께 올라와 있어요. v1 빠른 시작은 `pnpm add evalite@beta`를 제시하고 `evalite/scorers`의 `exactMatch`를 쓰는 예제를 보여줘요. 도입할 때는 기존 문서의 `autoevals` 예제를 따를지, beta 문서의 내장 scorer 형태를 따를지 먼저 정해야 해요.

## 낮은 점수의 원인을 보는 방법

`evalite watch`를 실행하면 eval을 돌린 결과가 sqlite 데이터베이스에 저장되고, localhost UI에서 traces, scores, inputs, outputs를 볼 수 있어요. 안내된 저장 위치는 `node_modules/.evalite`예요.

LLM 품질 회귀는 점수만 봐서는 원인을 알기 어려워요. 평균 점수가 82에서 67로 떨어졌다면 어느 입력에서 어떤 중간 호출을 거쳐 어떤 문장이 빠졌는지 봐야 해요. 이대리처럼 Slack 입력, GitHub diff, 이전 실행 기록이 섞이는 시스템이라면 낮은 점수가 모델의 판단 때문인지 입력 스냅샷의 문제인지도 구분해야 하고요.

AI SDK 예제에서는 모델을 `traceAISDKModel`로 감싸 호출 trace를 Evalite에서 볼 수 있게 해요. 이대리의 모델 호출은 CLI provider를 거치므로 예제를 그대로 붙이기는 어려워요. 연결하려면 먼저 CLI 호출 전후의 prompt, stdout, parsed output을 Evalite 결과나 log로 남기는 얇은 어댑터가 필요해요.

## 이대리에서 먼저 평가할 두 곳

휴가 잔여일 계산처럼 결과가 정해지는 로직은 일반 테스트가 더 싸고 정확해요. 주식 후보를 고르거나 장기 회고를 합성하는 기능처럼 입력과 목표가 계속 바뀌는 영역도 첫 eval 대상으로는 부담스러워요. 작은 고정 데이터셋으로 기대 결과를 말할 수 있는 곳부터 시작해야 해요.

첫 후보는 자연어 요청을 어느 작업으로 보낼지 고르는 단계예요. 여기서 잘못 고르면 뒤의 작업자가 일을 잘해도 사용자는 완전히 다른 답을 받아요. “오늘 할 일 정리”, “PR 리뷰 생성”, “업무 로그 초안”처럼 서로 가까운 표현으로 입력 3개를 만들고 기대 label을 붙일 수 있어요. scorer는 exact match면 충분해요. 점수가 흔들리면 prompt나 후보 목록을 바꾼 탓에 라우팅이 깨졌다는 뜻이에요.

두 번째 후보는 PR 리뷰예요. 같은 diff를 봐도 문장은 달라질 수 있으니 exact match는 맞지 않아요. 위험한 변경을 지적했는지, 영향 범위를 설명했는지, 근거 없는 스타일 코멘트를 늘리지 않았는지처럼 기대하는 구조를 나눠 볼 수 있어요. scorer로는 문자열 포함 검사, JSON 구조 검사, 별도의 judge 호출을 쓸 수 있어요. judge에 LLM을 쓰면 평가에도 비용과 변동성이 생기므로 첫 PR 게이트부터 무겁게 넣지는 않는 편이 좋아요.

## PR 게이트와 남는 한계

Evalite는 CI에서 한 번 실행하고 종료하는 모드를 제공해요. 가장 단순한 게이트는 평균 점수가 threshold보다 낮을 때 exit code 1로 빌드를 실패시키는 방식이에요.

```bash
evalite --threshold=70
```

중요한 건 “70이 좋은가”보다 “이 평가 묶음의 평균으로 PR을 막아도 될 만큼 결과가 안정적인가”예요. 입력이 세 개뿐이고 scorer도 문자열 유사도 하나라면 threshold는 품질 안전장치보다 알림에 가까워요. 그래도 PR 단계에서 요청이 엉뚱한 작업자로 가는 회귀를 막는 출발점은 될 수 있어요.

`evalite export`는 최근 실행 결과를 정적 HTML 번들로 내보내요. 문서의 GitHub Actions 예제는 이 번들을 artifact로 업로드해요.

```yaml
- name: Run evaluations
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  run: npx evalite --threshold=70

- name: Export UI
  run: npx evalite export --output=./ui-export

- name: Upload static UI
  uses: actions/upload-artifact@v3
  with:
    name: evalite-ui
    path: ui-export
```

이대리의 기존 게이트는 lint, unit test, build처럼 결과가 분명한 실패를 잡는 쪽이에요. Evalite를 붙인다면 핵심 회귀 3~10개를 별도 job으로 두는 편이 안전해요. 실패했을 때 HTML artifact를 열어 어떤 입력에서 문제가 생겼는지 확인하는 흐름도 필요해요.

Evalite는 운영 중 모든 대화 로그를 수집하거나 대규모 데이터셋과 장기 트렌드를 조직 단위로 관리하는 플랫폼을 대체하지 않아요. 개발자 로컬과 PR 단계에서 쓰는 안전망으로 보는 편이 맞아요.

성숙도도 확인해야 해요. 공식 사이트는 v1 beta를 안내하고, 빠른 시작 문서의 troubleshooting에는 `better-sqlite3` 바인딩 파일을 찾지 못하는 오류가 나와요. 해결책으로 `pnpm rebuild better-sqlite3`, `pnpm approve-builds`를 안내하지만 CI 이미지나 로컬 Node 버전에 따라 네이티브 바인딩 문제가 도입 비용이 될 수 있어요.

## 설치 전 만들 기준선

먼저 평가할 입력 3개와 기대 결과 3개를 써 봐야 해요. 자연어 라우팅이라면 서로 헷갈릴 만한 표현을, PR 리뷰라면 실제 diff에서 반드시 잡아야 한다고 말할 수 있는 항목을 고르면 돼요. 이 표를 만들 수 없다면 아직 평가 기준이 없는 거예요.

그다음 변경 전후에 같은 입력과 scorer를 써서 실행해 보고 threshold가 의미 있는지 확인해야 해요. 세 케이스 모두 답이 정해진 label이라면 100점에 가까운 기준이 맞을 수 있어요. 생성형 리뷰처럼 출력이 흔들린다면 평균 70 하나로 PR을 막기보다 처음에는 HTML artifact를 남겨 사람이 확인하는 편이 나아요.

출처

- https://www.evalite.dev
- https://www.evalite.dev/what-is-evalite
- https://www.evalite.dev/quickstart/
- https://www.evalite.dev/guides/ci/
- https://www.evalite.dev/examples/ai-sdk
- https://v1.evalite.dev
- https://v1.evalite.dev/guides/quickstart/
- https://github.com/mattpocock/evalite
