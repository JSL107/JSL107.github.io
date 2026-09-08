---
title: "에이전트의 행동을 통제하는 실행 전 권한 경계"
description: "Arcade.dev Actions Runtime을 통해 사용자별 OAuth 권한, 도구 실행, 감사 로그를 에이전트의 행동 경계로 분리하는 방법을 살펴본다."
pubDatetime: 2026-09-02T19:09:00+09:00
category: backend
---

PR을 열면 리뷰 코멘트 두 개가 나란히 붙어 있는데, 아이콘도 계정도 제 것으로 똑같아요. 하나는 제가 달았고 하나는 봇이 제 PAT(personal access token, 개인 계정으로 발급한 액세스 토큰)로 달았어요.

이쯤 되면 모자란 게 토큰이 아니라 경계예요.

## bot token으로 버티던 구간이 끝날 때

그 두 코멘트가 같아 보이기 전까지는 bot token 하나로 아무 불편이 없었어요. 멘션을 받아 스레드에 답하고, GitHub PR을 읽어 요약한 뒤 다시 Slack에 올리는 일까지는 그걸로 다 되니까요. 권한 모델도 단순해서, Slack 앱과 GitHub 앱이나 토큰에 부여한 권한, 서버 환경변수에 넣어 둔 키가 그대로 에이전트의 행동 범위가 돼요.

문제는 에이전트가 실제 작업을 "수행"하기 시작할 때 생겨요.

지금 `/review-pr`는 PR을 읽어 리뷰 초안을 Slack에 뿌리는 데서 멈춰요. 그 초안을 사람이 복사해 붙이는 대신 봇이 GitHub 코멘트로 직접 달게 만드는 순간, 같은 기능인데 권한 성격이 완전히 달라져요. bot token이나 서버 공용 토큰으로 처리하면 구현은 빠르지만 권한의 경계가 흐려지거든요.

이 행동을 봇이 한 것인지, 사용자가 위임한 것인지 구분하기 어려워요. 사용자가 권한을 철회했을 때 다음 실행을 막을 수 있는지도 확인해야 하죠. 실행 전에 필요한 scope(OAuth가 권한을 쪼개 놓은 단위, 이 토큰으로 어떤 API를 어디까지 쓸 수 있는지)를 확인하고, 나중에는 감사 로그에서 어떤 사용자 권한으로 어떤 도구를 실행했는지 추적할 수 있어야 해요.

미리 밝혀 두면, 아래 내용은 전부 문서와 공식 템플릿을 읽고 정리한 것이지 계정을 붙여 tool call을 돌려본 기록이 아니에요.

Arcade.dev Actions Runtime이 노리는 자리가 정확히 여기예요. 에이전트가 외부 SaaS에서 행동하기 직전에 OAuth, 토큰, 권한 확인, 실행, 감사 경계를 다시 거치게 하는 실행 계층이거든요. 읽기와 요약에 집중하는 에이전트에는 과해 보일 수 있어요. 사용자별 권한으로 Gmail, Slack, GitHub 같은 서비스를 실제로 조작하기 시작하면 설계의 중심이 되죠.

## Arcade는 실행 직전에 권한을 묻는다

회사가 내건 문구는 "enterprise-ready actions runtime for AI agents"예요. 도구 목록이 아니라 실행면을 판다는 선언이죠.

공식 문서는 이 실행면을 세 축으로 나눠 놓았어요. Enforce는 authorization을 강제해요. Execute는 에이전트용 도구 실행을 맡고요. Govern은 레지스트리·버전·가시성·OpenTelemetry(실행 기록을 표준 형식으로 내보내는 관측 규격) audit logs 같은 운영 관리를 담아요. 세 축 위에서 OAuth 2.0, API keys, user tokens를 모두 다루고, 도구마다 필요한 OAuth scope를 확인해요.

기존 방식과 비교하면 차이가 더 또렷하게 보여요. 직접 만든 tool function은 애플리케이션 코드 안에 함수와 권한 판단이 뒤섞이기 쉬워요. MCP(Model Context Protocol, 모델이나 클라이언트가 외부 도구를 부를 방식을 맞춰 둔 개방 규격) 서버는 표준 도구면을 제공하지만, 사용자별 OAuth 위임이나 토큰 보관, per-action authorization, 감사 정책까지 저절로 생기지는 않아요. Arcade는 이 실행면을 모델 프레임워크 밖으로 꺼내서, 도구 호출이 들어오면 "이 사용자에게 이 액션을 수행할 권한이 있는가"를 런타임에서 먼저 물어요.

그러니 Arcade는 MCP를 대체하는 게 아니라 그 위에 권한 계층을 얹는 쪽이에요. 뒤에 나오는 81 MCP servers는 Arcade가 카탈로그로 묶어 내놓은 쪽을 센 수치이고, 조직이나 벤더가 이미 굴리는 원격 MCP 서버는 "카탈로그에 없으면 등록하라"는 별도 경로로 들어와 같은 방식으로 통제받아요. 다만 카탈로그 쪽 서버가 Arcade 인프라에서 도는 것인지 외부 연결을 묶어 센 것인지는 문서가 구분해 적지 않아 확인하지 못했어요.

Arcade의 핵심은 실행 직전에 도구마다 요구 권한을 따로 확인한다는 데 있어요. Gmail.SendEmail을 부르려면 https://www.googleapis.com/auth/gmail.send scope가 있어야 하고, GoogleSearch.Search처럼 사용자별 authorization이 아예 필요 없는 도구도 있거든요. 에이전트가 "이메일 보내기"를 호출하면 Arcade는 먼저 해당 사용자에게 필요한 grant가 있는지 살펴보고, 없다면 OAuth authorization flow를 진행해요.

### Vercel AI SDK 예제는 authorization을 도구 뒤로 밀어넣는다

제가 굴리는 Slack 기반 멀티 에이전트 시스템인 이대리는 NestJS 위에 있어서 Vercel AI SDK 가이드를 그대로 옮길 수는 없어요. 다만 도구 정의와 authorization을 어디에서 갈라놓아야 하는지는 이 예제가 제일 또렷하게 보여줘요. Next.js 챗봇을 만들면서 Arcade를 도구 접근과 authorization 계층으로 연결하고, 필요한 패키지도 분명하게 알려주거든요.

```bash
pnpm add ai @ai-sdk/openai @ai-sdk/react @arcadeai/arcadejs zod
pnpm dlx ai-elements@latest
```

가이드의 설치 명령에는 버전이 붙어 있지 않아요. 같은 조합을 실제로 고정해 둔 곳은 공식 템플릿이라, 아래 값은 그 저장소 main 브랜치의 `3ea812f1` 커밋(2025-06-13) `package.json`에서 확인한 거예요. `@arcadeai/arcadejs` ^1.2.1, `ai` 4.3.6, `@ai-sdk/openai` ^1.3.9, `@ai-sdk/react` ^1.2.9, `zod` ^3.24.2, `next` 15.3.0-canary.31이고 `packageManager`는 pnpm@9.15.9예요. 이 조합이 가이드 예제가 실제로 돌던 버전과 같은지는 가이드 쪽에 표기가 없어 확인하지 못했어요.

환경변수 중 설계를 가르는 값은 ARCADE_USER_ID 하나예요. 앱 내부 사용자 식별자라 이메일, UUID, 내부 DB user ID처럼 안정적인 값이면 되고, Arcade는 이 값을 기준으로 사용자별 tool authorization을 추적해요.

```plain text
ARCADE_API_KEY={arcade_api_key}
ARCADE_USER_ID={arcade_user_id}
OPENAI_API_KEY=your_openai_api_key
```

권한 안내를 모델이 아니라 실행 계층에 맡기기로 하면 도구 설정 방식도 따라 갈려요. 설정 단위를 서버로 잡을지 도구 하나로 잡을지가 곧 권한 폭을 정해요. 묶음과 낱개를 섞을 수 있어서 Slack은 MCP 서버 전체를 가져오고, Gmail은 Gmail_ListEmails, Gmail_SendEmail, Gmail_WhoAmI 셋만 추가하면 돼요.

앞에서 점을 찍어 쓴 Gmail.SendEmail과 여기 밑줄로 적힌 Gmail_SendEmail은 같은 도구의 다른 표기예요. 모델에 넘기는 함수 이름 자리에는 점을 쓸 수 없어 밑줄로 바꿔 적고, Arcade 쪽 정식 이름이 점 표기거든요.

모델에는 "권한이 필요하면 수동으로 안내하지 말고 도구를 호출하라"고 지시해요. authorization 처리를 도구 실행 계층에서 맡기 때문이에요.

```typescript
const config = {
  // Get all tools from these MCP servers
  mcpServers: ["Slack"],

  // Add specific individual tools
  individualTools: ["Gmail_ListEmails", "Gmail_SendEmail", "Gmail_WhoAmI"],

  // Maximum tools to fetch per MCP server
  toolLimit: 30,

  // System prompt defining the assistant's behavior
  systemPrompt: `You are a helpful assistant that can access Gmail and Slack.
Always use the available tools to fulfill user requests. Do not tell users to authorize manually - just call the tool and the system will handle authorization if needed.

For Gmail:
- To find sent emails, use the query parameter with "in:sent"
- To find received emails, use "in:inbox" or no query

After completing any action (sending emails, Slack messages, etc.), always confirm what you did with specific details.

IMPORTANT: When calling tools, if an argument is optional, do not set it. Never pass null for optional parameters.`,
};
```

### 실행과 권한 요청이 같은 포트 뒤에 묶인다

toZodToolSet은 Arcade tool definition을 Zod tool set으로 바꿔줘요. executeOrAuthorizeZodTool helper를 붙이면 실행과 authorization 처리도 함께 다룰 수 있죠. 두 함수 다 `@arcadeai/arcadejs/lib/index`에서 가져와요.

```typescript
import {
  toZodToolSet,
  executeOrAuthorizeZodTool,
} from "@arcadeai/arcadejs/lib/index";

const zodTools = toZodToolSet({
  tools: allTools,
  client: arcade,
  userId,
  executeFactory: executeOrAuthorizeZodTool,
});
```

묶어 놓고 나면 다음 질문은 권한이 없을 때 무엇을 돌려주느냐예요. 같은 문제를 코드로 풀어 둔 자리가 공식 템플릿 저장소에 있는데, lib/arcade/server.ts에서는 도구 실행 중 PermissionDeniedError가 발생하면 tools.authorize를 호출해 authorization response를 돌려줘요. PermissionDeniedError가 실패로 끝나지 않고 authorization response로 바뀌는 셈이에요. 아래 두 블록에 나오는 formattedToolName은 같은 파일이 lib/arcade/utils.ts에서 가져온 formatOpenAIToolNameToArcadeToolName을 거친 값인데, 이 함수가 하는 일이 `toolName.replaceAll("_", ".")` 한 줄, 그러니까 방금 말한 밑줄을 점으로 바꾸는 변환이에요.

```typescript
import { Arcade, PermissionDeniedError } from "@arcadeai/arcadejs";
// this.client 는 Arcade 인스턴스이고, 아래 두 블록은 같은 함수의 try 와 catch 예요.

const result = await this.client.tools.execute({
  tool_name: formattedToolName,
  input: args,
  user_id: userId,
});

return { result };
```

```typescript
if (error instanceof PermissionDeniedError) {
  const authInfo = await this.client.tools.authorize({
    tool_name: formattedToolName,
    user_id: userId,
  });

  return { authResponse: authInfo };
}
```

권한 요청만 따로 받는 authorization endpoint도 마련돼 있어요. 이대리로 옮기면 외부 부작용을 ✅ 버튼 승인 뒤에 세워 둔 게이트인 preview-gate가 눌린 뒤 Slack이 authorization URL을 되돌려 주는 자리가 여기에 해당해요. 공식 템플릿의 app/(chat)/api/tools/auth/route.ts는 로그인된 session.user.id와 toolName을 받아 Arcade의 tools.authorize를 호출해요.

```typescript
import { NextResponse } from "next/server";

const authResponse = await arcadeServer.client.tools.authorize({
  tool_name: formattedToolName,
  user_id: session.user.id,
});

return NextResponse.json(authResponse);
```

코드를 여기까지 따라오면 이대리의 배치도 그대로 겹쳐져요. IntentClassifierUsecase가 도구를 고르고, slack 핸들러가 slackUserId로 현재 사용자를 식별하는 자리가 각각 모델과 애플리케이션 몫이에요. Arcade는 그 사용자에게 해당 tool action을 수행할 authorization이 있는지 확인해요. 권한이 있으면 실행하고, 없으면 authorization 흐름을 반환하죠.

### 7,500개보다 중요한 건 실행 직전의 확인 한 번이다

Arcade가 내건 7,500+ agent-optimized tools와 81 MCP servers는 이 글을 쓴 2026년 9월 초에 공식 문서에서 확인한 공개 수치예요. 그런데 도구가 늘어날수록 정작 중요해지는 건 개수가 아니라, 실행 기록 하나에 사용자와 scope와 action이 함께 남아 있느냐예요.

Arcade 자사 블로그는 프로덕션 에이전트 인증에서 static API key, shared service account, DIY OAuth가 결국 같은 지점에서 무너진다고 봐요. agent, user, task-specific authorization context 셋을 따로 보면 의미가 없고, 런타임에서 한꺼번에 평가해야 뜻이 생긴다는 이야기죠. 다만 벤더가 자기 제품을 설명하는 글이니, 이 진단이 곧 제품의 필요로 이어지도록 쓰였다는 점은 감안하고 읽어야 해요.

사용자가 어떤 SaaS 권한을 갖고 있어도 에이전트가 그 권한을 모두 마음대로 써도 된다는 뜻은 아니에요. 에이전트의 역할과 사용자의 위임, 현재 작업 맥락이 겹치는 범위만 실행 가능한 권한으로 삼아야 해요.

Vercel AI SDK 예제에서도 같은 관점이 보여요. 사용자가 화면에서 고른 toolkit만 selectedToolkits로 좁혀 가져오는 것부터가 그 관점이에요. getToolsByToolkits({ userId: session.user.id, toolkits: selectedToolkits })에는 사용자 식별자도 함께 넘겨요. 이후 streamText에는 Arcade tools와 자체 도구가 같이 들어가죠.

```typescript
import { streamText } from "ai";

const arcadeTools =
  (await arcadeServer?.getToolsByToolkits({
    userId: session.user.id,
    toolkits: selectedToolkits,
  })) ?? {};

const result = streamText({
  model: myProvider.languageModel(selectedChatModel),
  system: systemPrompt({ selectedChatModel }),
  messages,
  maxSteps: 5,
  tools: {
    ...arcadeTools,
    getWeather,
    createDocument: createDocument({ session, dataStream }),
    updateDocument: updateDocument({ session, dataStream }),
  },
});
```

이 예시는 "Arcade가 모든 것을 대체한다"는 뜻이 아니라, 이대리로 치면 agent-run 기록과 preview-gate 카드는 안에 남고 GitHub 코멘트·Slack DM만 밖으로 나간다는 뜻이에요. 기존 agent framework의 tool calling 슬롯에 Arcade가 권한 있는 외부 도구 묶음으로 들어가는 모습이고요. 직접 나눠 본 건 아니라 단정은 못 하지만, 지금 구조에서라면 이 분할을 제일 먼저 시도해 볼 것 같아요.

## 재 보면 걸리는 건 런타임 소유권이다

매력이 분명한 도구일수록 안 맞는 조건을 먼저 세어 두는 편이 빠르고, 여기서 걸리는 건 런타임 소유권과 책임 범위 둘이에요.

### 런타임을 남에게 맡기면 감사 로그도 남의 것이 된다

런타임 소유권에서 팀마다 답이 갈리는 이유는 런타임 자체가 폐쇄형이라는 점 하나예요. 공식 SDK와 도구, 문서는 볼 수 있어도 실제 tool call을 집행하는 런타임을 조직이 얼마나 직접 통제해야 하는지에 따라 판단은 달라져요.

보안팀이 VPC(회사 전용으로 격리해 쓰는 클라우드 네트워크 구간), self-host, audit export, SIEM(여러 시스템의 로그를 한곳에 모아 보안 이벤트를 감시하는 시스템) 연동 수준을 요구한다면 공식 문서의 주장만 봐서는 부족해요. 실제 계약과 배포 옵션을 따로 물어야 하는데, 무엇을 어떤 값으로 볼지는 뒤의 확인 절차에 모아 뒀어요.

Scalekit의 비교 글은 Arcade가 per-user delegation, MCP-native runtime, tool evaluation framework에서 강점이 있다고 봐요. 아직 검증 중인 쪽은 런타임이 닫혀 있다는 점이에요. 조직 단위 자격증명 계층이나 SIEM으로 빼내는 감사 로그, 대규모 엔터프라이즈 운영 레퍼런스는 그다음 문제고요.

경쟁사 글이라 그대로 결론을 내릴 수는 없지만, 도입 체크리스트로는 쓸 만해요. 공식 문서가 "SIEM policies"와 "OpenTelemetry audit logs"를 내세우는 만큼, 조직이 원하는 export, retention, tenant-level policy를 실제로 지원하는지도 같은 절차에 함께 넣어 뒀어요.

### 도구 호출이 끝나도 orchestration은 남는다

Arcade가 맡는 범위는 action runtime에서 끊기고, 그 바깥은 전부 이대리 몫으로 남아요. 장기 동기화와 webhook 기반 이벤트 수집, 도메인별 승인 워크플로우, 내부 DB 트랜잭션 정합성은 여전히 애플리케이션의 책임이에요.

GitHub 코멘트를 남긴 뒤 내부 agent-run 상태와 Slack 응답까지 함께 정리하려면 실행과 조율을 갈라 놓아야 해요. 이렇게 나눈다면 Arcade는 외부 action을 실행하는 포트까지만 맡고, 전체 유스케이스 orchestration은 NestJS application layer에 남게 돼요.

단일 사용자 개인 자동화라 OAuth와 audit 경계가 지나치게 무거운 경우에는 도입 비용이 이득보다 클 수 있어요.

이대리가 정확히 그 경우예요. 사용자가 저 하나라 "사용자별 위임"이 아직 값을 못 하고, 지금 얻는 건 위임이 아니라 실행 기록의 결이에요.

이대리와 다른 이유로 안 맞는 자리도 있어요. 지원하지 않는 내부 SaaS가 대부분이거나 외부 런타임 의존을 허용할 수 없는 경우가 그렇고요. 이미 조직 표준 IdP(직원 계정을 인증하고 신원을 발급하는 identity provider)·토큰 vault·policy engine·MCP gateway를 직접 운영하는 경우에도 잘 맞지 않을 수 있어요.

## 이대리에 붙인다면 ToolExecutionPort부터 생긴다

이대리에 대입해 보면 Arcade가 모든 모듈에 닿는 것은 아니에요. 먼저 연결될 곳은 model-router, agent-run, slack, github, notion, 그리고 실행형 에이전트들이에요.

agent/pm, agent/work-reviewer, agent/code-reviewer처럼 읽기·요약·리뷰가 중심인 모듈은 당장 Arcade 없이도 동작해요. 이들이 코멘트를 직접 달고, Slack DM을 보내고, 문서를 고쳐 쓰고, GitHub issue 상태까지 바꾸기 시작하면 별도 실행 포트가 필요해요.

현재 구조에서는 ModelRouterUsecase.route가 모델 응답을 만드는 역할에 머물고, 그 뒤에 ToolExecutionPort를 두는 편이 나아요.

agent-run은 실행 전후 상태와 evidence를 기록하고, slack은 사용자 식별과 authorization URL 안내를 맡아요. github나 notion 같은 외부 시스템은 직접 토큰으로 호출하기보다 Arcade-backed adapter 뒤에서 실행하는 그림이 되는데, 지금 쓰는 owner PAT를 어떤 scope로 갈아 끼워야 하는지는 카탈로그를 열어 보기 전에는 못 정해요.

내부 인터페이스는 다음과 같은 형태로 시작할 수 있어요. 이 코드는 Arcade 공식 예제가 아니에요. 문서에서 확인한 user_id, tool_name, input, authorization response 흐름을 시스템 경계에 맞게 옮긴 설계예요.

```typescript
export type ToolExecutionStatus =
  | "executed"
  | "authorization_required"
  | "denied"
  | "failed";

export interface ToolExecutionPort {
  execute(input: {
    userId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    agentRunId: string;
    toolCallId: string;
  }): Promise<{
    status: ToolExecutionStatus;
    result?: unknown;
    authorizationUrl?: string;
    reason?: string;
  }>;
}
```

### preview-gate가 못 묻는 것을 채운다

이대리에는 이미 preview-gate가 서 있으니, ToolExecutionPort는 그 게이트가 못 묻는 것, 누구의 권한으로 나가는 행동인가를 채우는 층이 돼요. agent/code-reviewer가 PR 리뷰를 "작성"하거나 agent/work-reviewer가 Slack에 보고서를 "전송"할 때 적용돼요. agent/blog가 초안을 외부 문서 시스템에 "저장"하는 순간도 같은 경계를 거쳐요.

agent-run에는 실행을 시도한 에이전트와 빌려 쓴 사용자 권한, 부르려던 toolName을 함께 남겨요. authorization이 없다면 authorization_required 상태로 Slack에 연결 링크를 돌려줘요. 실패 기록도 모델 실패와 도구 실패로 나눠 남겨요.

인터페이스 입력에 toolCallId를 둔 건 재실행 규칙 때문이에요. authorization_required로 멈춘 호출은 agentRunId와 toolCallId 한 쌍을 키로 원장에 남고, 사용자가 승인 링크를 누르면 그 키가 가리키는 한 건만 딱 한 번 다시 트리거해요. 같은 키가 이미 executed나 denied로 닫혀 있으면 도구를 다시 부르지 않고 남아 있는 결과를 그대로 돌려주고요. 승인 한 번이 실행 두 번이 되지 않게 막는 자리가 여기예요.

붙일 곳을 정하는 일은 안 붙일 곳을 정하고 나서야 끝나요. agent/be-test, agent/be-schema, agent/be-sre처럼 로컬 코드 분석이나 내부 생성 작업이 중심인 모듈은 Arcade의 1차 대상이 아니에요. 이 모듈에는 외부 SaaS 권한보다 sandbox와 repo 접근 경계, 테스트 실행 로그가 더 중요하거든요.

### 확인 절차는 붙이기 전에 적어 둔다

글 곳곳에서 "확인해야 한다"고만 적고 넘어간 것들을 한자리에 모아 뒀어요. 아직 계정을 붙여 돌려 본 게 없으니 아래는 전부 결과가 아니라 계약이에요. 무엇을, 어디서, 어떤 값으로 볼지만 미리 정해 둔 거고, 어느 항목도 실행하지 않았어요.

- **권한 철회 후 재호출**: Arcade 개발자 계정에 테스트 사용자 하나를 두고, 로컬 개발 환경에서 Gmail 위임을 준 뒤 곧바로 회수한 상태로 같은 도구를 다시 불러요. 볼 값은 반환 status가 executed인지 authorization_required인지 denied인지, 그리고 그 status가 agent-run에 실제로 남는지 두 가지예요. 공식 문서는 권한이 없으면 authorization flow로 넘어간다고만 적어 두어서, 한 번 줬다가 회수한 사용자가 같은 도구를 부르면 무엇이 돌아오는지는 확인하지 못했어요.
- **같은 실행 중복**: 같은 로컬 환경에서 동일한 agentRunId·toolCallId 쌍으로 execute를 두 번 넣어요. 볼 값은 밖으로 나간 부작용 개수, 그러니까 대상 PR에 실제로 달린 GitHub 코멘트 수가 1로 유지되는지예요.
- **승인 후 재시작**: authorization_required로 멈춘 상태에서 서버를 재시작한 뒤 승인 링크를 눌러요. 볼 값은 대기 중이던 호출이 같은 키로 한 번만 이어 붙는지, 두 번 나가는지, 아니면 아예 유실되는지예요. 재시작으로 메모리 상태가 날아가는 구간이라 원장에만 의존해야 하는데, 이 경로는 아직 확인하지 못했어요.
- **런타임 소유권**: 문서가 아니라 벤더에게 직접 물어요. 볼 값은 self-host 가능 여부, audit export의 형식과 retention 기간, tenant-level policy 지원 범위이고, 근거는 공식 문서 문구가 아니라 계약 문구로 받아요.
- **scope 갈아 끼우기**: Arcade 카탈로그에서 GitHub 코멘트 작성 도구가 요구하는 scope를 열어 봐요. 볼 값은 그 scope 목록과 지금 쓰는 owner PAT의 권한 폭 차이예요.

### 그래서 지금은 인터페이스만 세워 둔다

안 붙이기로 정하고 나서야 이 글에서 건진 게 뭔지 알았어요. Arcade가 아니라 "LLM이 생각한 결과를 외부 서비스의 사용자 계정으로 실행하는 자리"라는 이름 하나였어요. 판단 순서로 보면 model-router부터 agent/blog까지 붙일 자리를 다 찾아 놓고, 그러고 나서 사용자가 저 하나라는 조건 앞에서 접은 셈이에요.

그래서 지금 당장 Arcade를 붙이지는 않으려고 해요. 이대리에서 사용자 권한으로 외부에 쓰는 일이 아직 몇 갈래 안 되니, ToolExecutionPort 인터페이스만 먼저 세워 두고 그 뒤는 기존 preview-gate로 막아 두는 편이 지금 규모에 맞거든요.

나중에 다시 꺼낼 때 현행 방식과 도입안을 견줄 값도 하나로 정해 뒀어요. 밖으로 나간 부작용 한 건마다 agent-run에 사용자 식별자와 toolName, 그리고 그 실행이 누구의 권한으로 나갔는지가 함께 남은 비율을, preview-gate + owner PAT 방식일 때와 ToolExecutionPort 방식일 때 같은 기간으로 재요. 다만 이 비교는 기록의 결만 재요. 권한 자체가 실제로 좁아졌는지, 잘못 나간 실행이 줄었는지는 이 값으로 알 수 없어요.

도입부에서 세운 확인 항목 셋을 같은 순서로 되짚으면 이래요. 봇이 한 행동인지 사용자가 위임한 행동인지는 execute 입력의 userId와 agent-run 기록으로 갈라져요. 권한을 철회한 사용자가 같은 도구를 다시 부르면 무엇이 돌아오는지는 위 확인 절차의 첫 항목으로 남겨 뒀고, 아직 확인하지 못한 채예요. 실행 전 scope 확인과 감사 추적은 Arcade가 도구마다 필요한 scope를 실행 직전에 보고 OpenTelemetry audit logs를 남긴다는 문서 주장까지만 확인했고, 그 로그를 조직 밖으로 어떻게 빼는지는 계약 확인 항목으로 넘겼어요.

이 인터페이스 뒤가 붐비기 시작하는 날이 Arcade를 다시 꺼내 볼 날이에요.

## 참고한 출처

아래 링크는 모두 2026년 9월 2일에 열어 확인했고, 각 줄에 그 자료가 본문에서 무엇을 받치는지 함께 적었어요. 벤더 자사 자료와 경쟁사 자료는 그 성격을 앞에 표시했어요.

- [About Arcade: the enterprise-ready actions runtime for AI agents](https://docs.arcade.dev/en/get-started/about-arcade) — 벤더 공식 문서. Enforce·Execute·Govern 세 축, 7,500+ agent-optimized tools와 81 MCP servers 수치, OpenTelemetry audit logs, 카탈로그에 없는 원격 MCP 서버를 등록해 같은 방식으로 통제한다는 설명이 여기서 나왔어요.
- [Build an AI Chatbot with Arcade and Vercel AI SDK](https://docs.arcade.dev/get-started/agent-frameworks/vercelai) — 벤더 공식 문서. 설치 패키지 목록, ARCADE_USER_ID 환경변수의 뜻, mcpServers·individualTools·toolLimit 설정, toZodToolSet과 executeOrAuthorizeZodTool 코드의 출처예요. 이 페이지에는 패키지 버전이 고정돼 있지 않아요.
- [Tools](https://docs.arcade.dev/en/resources/tools) — 벤더 공식 문서. 도구 카탈로그로 들어가는 입구 페이지라 본문에 그대로 대응하는 문장은 없어요. 본문의 Gmail.SendEmail scope 예시처럼 도구별 요구 scope는 이 페이지가 아니라 여기서 한 단계 더 들어간 카탈로그에서 봐야 해요.
- [Get Formatted Tool Definitions](https://docs.arcade.dev/en/build/tool-calling/custom-apps/get-tool-definitions) — 벤더 공식 문서. toZodToolSet이 Arcade tool definition을 Zod 스키마로 바꾼다는 설명과 executeOrAuthorizeZodTool의 authorization 처리를 확인한 자리예요.
- [ArcadeAI/arcade-vercel-ai-template](https://github.com/ArcadeAI/arcade-vercel-ai-template) — 벤더가 공개한 공식 템플릿. lib/arcade/server.ts의 PermissionDeniedError 처리, app/(chat)/api/tools/auth/route.ts의 tools.authorize 호출, lib/arcade/utils.ts의 밑줄→점 이름 변환, 그리고 본문에 적은 패키지 버전이 모두 여기서 나왔어요. 기준은 main 브랜치의 3ea812f1 커밋(2025-06-13)이에요.
- [Best AI Agent Authentication and Authorization Platforms for Enterprise in 2026](https://www.arcade.dev/blog/best-ai-agent-authentication-platforms) — Arcade 자사 블로그(2026-07-10). static API key·shared service account·DIY OAuth가 같은 지점에서 무너진다는 진단과, agent·user·task-specific authorization context를 런타임에서 함께 평가해야 한다는 주장의 출처예요.
- [Arcade.dev Alternatives for AI Agent Tool Calling (2026)](https://www.scalekit.com/blog/arcade-alternatives) — 경쟁사 Scalekit의 비교 글(2026-04-29). per-user delegation·MCP-native runtime·tool evaluation framework를 강점으로, 닫힌 런타임과 조직 단위 자격증명·감사 인프라를 약점으로 꼽은 판단이 여기서 나왔어요.
