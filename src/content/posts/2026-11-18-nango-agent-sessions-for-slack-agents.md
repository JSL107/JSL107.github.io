---
title: "Nango Agent Sessions로 Slack 에이전트 권한을 실행 단위로 제한하기"
description: "Nango Agent Sessions의 권한 경계를 Slack 멀티 에이전트에 적용할 위치와 도입 전 확인할 한계를 살펴본다."
pubDatetime: 2026-11-18T19:47:00+09:00
category: backend
---

Slack 에이전트가 여러 업무 도구에 접근하기 시작하면 모델을 고르는 일만큼 사용자별 credential과 에이전트별 권한 범위도 중요해져요. 이 글은 Nango의 공식 문서, changelog, 공개 GitHub README를 바탕으로 Slack 기반 TypeScript/NestJS 멀티 에이전트의 어디에 Agent Sessions를 적용할 수 있고 어떤 한계가 있는지 살펴본 조사예요. 직접 연결해 성능·장애율·운영 비용을 측정한 결과는 아니에요.

## 도구가 늘면 에이전트 설계가 권한 설계가 된다

Slack 에이전트가 외부 SaaS 하나만 읽는다면 단순해요. GitHub 앱을 만들고 설치 토큰을 받아 백엔드에서 Octokit으로 호출하면 돼요. 하지만 GitHub, Linear, Gmail, Notion, Slack API는 OAuth 흐름과 refresh 규칙이 제각각이고 에이전트마다 필요한 권한도 달라요.

더 까다로운 건 누가 어떤 도구를 볼 수 있게 할지예요. LLM에 큰 tool 목록을 한꺼번에 넘기면 prompt가 무거워지고, tool을 줄이면 정작 필요한 순간에 일을 못 해요. 사용자별 토큰 저장소부터 provider별 클라이언트, refresh 실패 처리, 호출 로그, rate limit 재시도까지 직접 만들다 보면 백엔드가 어느새 통합 플랫폼이 돼요.

모든 도구를 백엔드 API로 감싸면 제어권이 커요. 대신 새 SaaS를 붙일 때마다 OAuth, credential 저장, endpoint별 wrapper, 로그, 재시도 정책을 다시 구현해야 해요. Nango Agent Sessions는 이 반복 작업을 실행마다 제한된 MCP 서버를 발급하는 방식으로 옮겨요.

## `Connection` 위에 실행 단위의 경계를 둔다

Nango의 기존 중심축은 `Connection`이에요. 사용자가 외부 API를 인증하면 `Connection`이 생기고, 그 안에 한 사용자의 한 외부 API credential이 저장돼요. Auth 문서에 따르면 Nango는 OAuth, API key, Basic auth, custom scheme을 다루며 credential 저장·refresh·validation·로그를 제공해요. 여기까지는 토큰 관리를 대신해 주는 역할에 가까워요.

Agent Sessions는 그 위에 에이전트 실행용 경계를 만들어요. 백엔드가 `tenant`, `toolset`, discovery 정책을 담아 세션을 만들면 Nango가 `session_token`, `mcp_url`, `expires_at`을 돌려줘요. 에이전트는 raw credential을 보지 않고 자기 세션의 MCP 서버만 호출해요. 세션은 immutable이라 실행 중에 에이전트가 자기 권한 범위를 넓힐 수 없어요.

공식 예시에서는 세션 생성 요청을 이렇게 보여줘요.

```bash
curl --request POST \
  --url 'https://api.nango.dev/sessions' \
  --header 'Authorization: Bearer *** \
  --header 'Content-Type: application/json' \
  --data '{
    "tenant": {
      "connections": {
        "any": [{ "tags": { "organization_id": "acme", "workspace": "marketing" } }]
      }
    }
  }'
```

Slack 요청을 받은 백엔드는 이미 조직, 워크스페이스, 사용자, 담당 에이전트 종류를 알고 있어요. 이 값들을 `Connection` tag로 맞춰 두면 이번 실행에 사용할 연결만 허용하는 세션을 만들 수 있어요. 에이전트 실행 기록을 시작하기 직전에 `mcp_url`과 `session_token`을 주입하는 식이에요.

## 필요한 도구만 노출하고 찾게 한다

Agent Sessions의 `toolset`은 단순한 통합 목록이 아니에요. 어떤 integration의 어떤 action function을 허용할지 `allow`, `deny`, `*`로 좁힐 수 있어요. 문서에 따르면 `toolset`을 생략했을 때는 `tenant`가 connection을 가진 integration의 모든 tool이 기본으로 열리므로 에이전트별로 명시하는 편이 더 안전해요.

`pinned tool`과 `searchable tool`도 나뉘어요. MCP 서버의 `tools/list`에는 meta tool과 pinned tool만 나타나고, 목록은 한 번에 50개씩 페이지네이션돼요. 나머지 tool은 목록에 바로 나타나지 않아 `nango_tool_search`로 찾아야 해요. 큰 SaaS API 전체를 prompt에 싣지 않으려는 설계예요.

Slack 라우터형 에이전트에서는 이 구분이 중요해요. “지난 PR에서 경력 로그 후보 뽑아줘”라는 요청에 처음부터 Gmail, Notion, Slack 쓰기 도구까지 보여줄 필요는 없어요. 저장소 읽기와 PR 관련 action만 pinned하거나 검색 가능하게 둘 수 있어요. “회의록을 찾아 요약해줘”라는 요청이라면 문서 검색 도구를 찾게 하고 쓰기 도구는 `toolset`에서 제외할 수 있어요.

문서의 세션 생성 JSON을 보면 이런 정책을 어디서 정하는지 한눈에 알 수 있어요.

```json
{
  "tenant": {
    "connections": {
      "any": [
        { "tags": { "endUserId": 74, "organizationId": "7283" }},
        { "tags": { "endUser": 74, "workspaceSlug": "slack-marketing-workspace" }}
      ],
      "pinned": [
        { "integration_id": "notion", "connection_id": "882386f9-efae-48aa-bea1-58a4f6fbc2ff" }
      ]
    }
  },

  "toolset": {
    "notion": { "allow": { "tools": ["read_doc", "upsert_doc"] } },
    "slack": "*"
  },

  "pinned_tools": {
    "notion": ["read_doc"]
  },

  "meta_tools": {
    "nango_tool_search": true,
    "nango_execute": true,
    "nango_proxy": false
  },

  "expires_in": "1h"
}
```

이 예시를 이대리에 대입하면 `endUserId`는 Slack 사용자, `organizationId`는 서비스 안의 조직, `workspaceSlug`는 Slack 워크스페이스에 해당해요. 다만 이 시스템의 실제 tenant 식별자에는 Slack 팀, 내부 조직, 사용자 ID가 섞여 있으니 `Connection` tag 설계를 먼저 고정해야 해요.

## Action function으로 업무 동작을 제한한다

Nango에서 에이전트가 호출하는 tool은 action function이에요. TypeScript 파일로 작성하고 Zod로 input과 output 계약을 정해요. 읽기, 쓰기, 여러 provider 호출을 묶은 workflow, unified API 작업에 쓸 수 있어요. Nango는 실행 과정에서 인증을 주입하고 로그, 재시도, rate limit 대응을 붙여요.

공식 문서의 GitHub issue 생성 action은 이런 형태예요.

```typescript
import { createAction } from 'nango';
import * as z from 'zod';

export default createAction({
    description: 'Creates a GitHub issue',
    version: '1.0.0',
    input: z.object({
        owner: z.string(),
        repo: z.string(),
        title: z.string(),
        body: z.string().optional()
    }),
    output: z.object({
        id: z.number(),
        url: z.string().url()
    }),
    exec: async (nango, input) => {
        const response = await nango.post({
            endpoint: `/repos/${input.owner}/${input.repo}/issues`,
            data: {
                title: input.title,
                body: input.body
            }
        });

        return {
            id: response.data.id,
            url: response.data.html_url
        };
    }
});
```

이 예시는 GitHub 전체 API를 에이전트에 맡기는 대신 issue 생성이라는 업무 동작을 Zod 계약이 있는 tool로 만들어요. Slack 에이전트가 PR 리뷰를 읽거나 업무 로그 초안을 만들거나 지원 기록을 조회하는 작업도 작은 action으로 나눌 수 있어요.

임의의 endpoint를 호출해야 한다면 `nango_proxy`가 있어요. 하지만 문서에서도 이 도구의 기본값은 `false`예요. 켜면 session `toolset`에 포함된 integration의 어떤 path든 접근할 수 있기 때문이에요. 자연어로 들어온 Slack 요청을 처리할 때는 디버깅이나 내부 관리자 용도로 제한하는 편이 안전해요.

## public beta와 운영상의 제한

Nango changelog에는 Agent Sessions가 2026-09-02에 public beta로 올라왔다고 나와 있어요. Nango 자체는 Auth, Proxy, Functions를 갖춘 open-source 통합 플랫폼이지만 Agent Sessions 인터페이스는 계속 확장 중이에요. MCP 호환성, policy 표현, meta tool 동작이 바뀔 가능성을 운영 설계에 반영해야 해요.

제한도 숫자로 명시돼 있어요. action function output은 2 MB를 넘을 수 없어서 더 큰 payload에는 app에서 직접 fetch하거나 proxy를 쓰라고 권해요. async action은 bulk write, bursty 작업, rate limit이 빡빡한 provider에 쓸 수 있지만 완료 시점은 보장되지 않아요. 문서에 따르면 현재 async action은 environment 단위로 순차 처리하므로 큐에 쌓인 개수와 각 action의 실행 시간에 따라 완료 시간이 달라져요.

:::callout ⚠️ red

쓰기 작업에는 별도 기준이 필요해요. Nango 문서는 async execution이나 retry를 쓰기 전에 action logic을 idempotent하게 만들라고 경고해요. 같은 Slack 요청을 재시도했을 때 외부 SaaS에 이슈, 댓글, 메시지가 두 번 생긴다면 도구 계약이 중복 실행을 허용한 셈이에요.

:::

세션 policy도 백엔드가 관리해야 해요. 문서에 따르면 세션 `toolset`은 미리 저장한 named bundle을 고르는 방식이 아니라 세션 생성 요청마다 JSON으로 구성해요. 그래서 “오늘 할 일 정리”, “PR 리뷰”, “업무 로그 작성”처럼 실행 종류에 맞는 policy builder와 테스트가 서비스 안에 필요해요.

## 이대리에서의 적용 범위

이대리에서 먼저 적용할 곳은 에이전트 실행 경계예요. Slack 요청이 들어오면 라우터가 담당 작업을 고르고 실행 기록을 만들며 LLM 라우터가 모델을 호출해요. Agent Sessions를 붙인다면 모델 호출 직전에 이번 실행에 필요한 SaaS `toolset`을 만들고 MCP 서버 정보를 모델 또는 agent runtime에 넘기는 위치가 맞아요.

적용 후보는 외부 SaaS를 사용자 권한으로 읽는 작업이에요. PR 리뷰를 만드는 쪽은 GitHub 읽기 권한을 쓰고, 그날 할 일을 정리하는 쪽은 GitHub나 일정 도구를 읽을 수 있어요. 업무 로그 초안을 만드는 쪽은 PR, 이슈, 일정, 문서 기록을 엮을 가능성이 있어요. 요청한 사용자 또는 팀의 연결을 기준으로 읽는 tenant 모델이 자연스러워요.

내부 DB만 보는 결정론적 작업에서는 가치가 작아요. 휴가 잔여 계산처럼 자연어에서 날짜만 뽑아 내부 규칙으로 계산하거나, 진행 상태를 내부 테이블에서 조회하거나, 내부 코드 기준으로 문서 동기화를 검사하는 작업에는 외부 SaaS credential 문제가 없어요. 이런 곳까지 붙이면 런타임만 복잡해져요.

OAuth 연결 UX도 전제 조건이에요. 사용자가 Slack에서 “내 Gmail 연결해줘”라고 했을 때 Connect link를 열어 인증하는 흐름을 제품 안에 받아들일 준비가 필요해요. Nango에는 `nango_create_connection` meta tool도 있지만 에이전트가 Slack에서 연결 링크를 어떻게 전달할지는 별도로 결정해야 해요.

| 적용 후보 | 맞는 이유 | 보류할 이유 |
| --- | --- | --- |
| PR·이슈 읽기 기반 리뷰 | 사용자/팀 GitHub 권한을 세션으로 제한 가능 | 기존 GitHub 앱 권한만으로 충분하면 중복 |
| 업무 로그·일일 계획 | 여러 SaaS 읽기 권한을 실행별로 묶기 좋음 | `toolset` 정책 조합이 복잡해짐 |
| 내부 DB 조회·계산 | 외부 credential 문제가 없음 | Nango를 끼울 이유가 약함 |
| SaaS 쓰기 자동화 | action function으로 계약화 가능 | idempotency와 승인 UX가 먼저 필요 |

## 읽기 전용 세션부터 확인할 것

첫 실험에는 GitHub PR 상세 조회나 문서 검색처럼 output이 작고 실패해도 외부 상태가 바뀌지 않는 읽기 전용 action 하나가 적당해요. 먼저 `Connection` tag가 정확히 하나의 connection으로 해석되는지, ambiguous connection이 나오면 백엔드가 사용자에게 어떻게 안내하는지, 세션이 만료된 뒤 MCP 서버가 401을 반환하는지 확인해야 해요.

그다음에는 `toolset` 크기를 실험할 수 있어요. 자주 쓰는 읽기 tool 하나만 pinned하고 나머지는 `nango_tool_search`로 찾게 만드는 거예요. Slack 라우터형 에이전트에서는 prompt에 보이는 도구가 행동 반경처럼 작동해요. 이 구성이 실제 응답 품질과 비용에 어떤 영향을 주는지는 아직 측정해야 해요.

### 출처

- https://nango.dev/docs/guides/agent-sessions
- https://nango.dev/docs/getting-started/use-cases/tool-calling
- https://nango.dev/docs/guides/functions/action-functions
- https://nango.dev/docs/guides/auth/auth-guide
- https://nango.dev/docs/guides/auth/connection-tags-configuration-metadata
- https://nango.dev/docs/updates/changelog
- https://github.com/NangoHQ/nango
