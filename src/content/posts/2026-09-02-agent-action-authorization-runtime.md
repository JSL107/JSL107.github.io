---
title: "에이전트의 행동을 통제하는 실행 전 권한 경계"
description: "Arcade.dev Actions Runtime을 통해 사용자별 OAuth 권한, 도구 실행, 감사 로그를 에이전트의 행동 경계로 분리하는 방법을 살펴본다."
pubDatetime: 2026-09-02T19:09:00+09:00
category: backend
---

PR을 열면 리뷰 코멘트 두 개가 나란히 붙어 있는데, 아이콘도 계정도 제 것으로 똑같아요. 하나는 제가 달았고 하나는 봇이 제 PAT로 달았어요.

이쯤 되면 모자란 게 토큰이 아니라 경계예요.

## bot token으로 버티던 구간이 끝날 때

그 두 코멘트가 같아 보이기 전까지는 bot token 하나로 아무 불편이 없었어요. 멘션을 받아 스레드에 답하고, GitHub PR을 읽어 요약한 뒤 다시 Slack에 올리는 일까지는 그걸로 다 되니까요. 권한 모델도 단순해서, Slack 앱과 GitHub 앱이나 토큰에 부여한 권한, 서버 환경변수에 넣어 둔 키가 그대로 에이전트의 행동 범위가 돼요.

문제는 에이전트가 실제 작업을 "수행"하기 시작할 때 생겨요.

지금 `/review-pr`는 PR을 읽어 리뷰 초안을 Slack에 뿌리는 데서 멈춰요. 그 초안을 사람이 복사해 붙이는 대신 봇이 GitHub 코멘트로 직접 달게 만드는 순간, 같은 기능인데 권한 성격이 완전히 달라져요. bot token이나 서버 공용 토큰으로 처리하면 구현은 빠르지만 권한의 경계가 흐려지거든요.

이 행동을 봇이 한 것인지, 사용자가 위임한 것인지 구분하기 어려워요. 사용자가 권한을 철회했을 때 다음 실행을 막을 수 있는지도 확인해야 하죠. 실행 전에 필요한 scope를 확인하고, 나중에는 감사 로그에서 어떤 사용자 권한으로 어떤 도구를 실행했는지 추적할 수 있어야 해요.

미리 밝혀 두면, 아래 내용은 전부 문서와 공식 템플릿을 읽고 정리한 것이지 계정을 붙여 tool call을 돌려본 기록이 아니에요.

Arcade.dev Actions Runtime이 노리는 자리가 정확히 여기예요. 에이전트가 외부 SaaS에서 행동하기 직전에 OAuth, 토큰, 권한 확인, 실행, 감사 경계를 다시 거치게 하는 실행 계층이거든요. 읽기와 요약에 집중하는 에이전트에는 과해 보일 수 있어요. 사용자별 권한으로 Gmail, Slack, GitHub 같은 서비스를 실제로 조작하기 시작하면 설계의 중심이 되죠.

## Arcade는 실행 직전에 권한을 묻는다

Arcade가 파는 건 도구 목록이 아니라 실행 직전에 권한을 한 번 더 묻는 자리예요. 회사가 내건 "enterprise-ready actions runtime for AI agents"라는 문구도 그 자리를 가리키고요.

Authorization을 강제하는 Enforce, 에이전트용 도구 실행을 맡는 Execute, 그리고 레지스트리·버전·가시성·OpenTelemetry audit logs 같은 운영 관리를 담은 Govern, 이렇게 세 축이에요. OAuth 2.0, API keys, user tokens를 모두 다루고, 도구마다 필요한 OAuth scope를 확인해요.

기존 방식과 비교하면 차이가 더 또렷하게 보여요. 직접 만든 tool function은 애플리케이션 코드 안에 함수와 권한 판단이 뒤섞이기 쉬워요. MCP 서버는 모델이나 클라이언트가 호출할 표준 도구면을 제공하지만, 사용자별 OAuth 위임이나 토큰 보관, per-action authorization, 감사 정책까지 저절로 생기지는 않아요.

Arcade는 이 실행면을 모델 프레임워크 밖으로 꺼내요. 도구 호출이 들어오면 "이 사용자에게 이 액션을 수행할 권한이 있는가"를 런타임에서 먼저 묻고요.

Arcade의 핵심은 실행 직전에 도구마다 요구 권한을 따로 확인한다는 데 있어요. Gmail.SendEmail을 부르려면 https://www.googleapis.com/auth/gmail.send scope가 있어야 하고, GoogleSearch.Search처럼 사용자별 authorization이 아예 필요 없는 도구도 있거든요. 에이전트가 "이메일 보내기"를 호출하면 Arcade는 먼저 해당 사용자에게 필요한 grant가 있는지 살펴보고, 없다면 OAuth authorization flow를 진행해요.

### Vercel AI SDK 예제는 authorization을 도구 뒤로 밀어넣는다

이대리는 NestJS 위에 있어서 Vercel AI SDK 가이드를 그대로 옮길 수는 없어요. 다만 도구 정의와 authorization을 어디에서 갈라놓아야 하는지는 이 예제가 제일 또렷하게 보여줘요. Next.js 챗봇을 만들면서 Arcade를 도구 접근과 authorization 계층으로 연결하고, 필요한 패키지도 분명하게 알려주거든요.

```bash
pnpm add ai @ai-sdk/openai @ai-sdk/react @arcadeai/arcadejs zod
pnpm dlx ai-elements@latest
```

환경변수 중 설계를 가르는 값은 ARCADE_USER_ID 하나예요. 앱 내부 사용자 식별자라 이메일, UUID, 내부 DB user ID처럼 안정적인 값이면 되고, Arcade는 이 값을 기준으로 사용자별 tool authorization을 추적해요.

```plain text
ARCADE_API_KEY={arcade_api_key}
ARCADE_USER_ID={arcade_user_id}
OPENAI_API_KEY=your_openai_api_key
```

권한 안내를 모델이 아니라 실행 계층에 맡기기로 하면 도구 설정 방식도 따라 갈려요. 설정 단위를 서버로 잡을지 도구 하나로 잡을지가 곧 권한 폭을 정해요. 묶음과 낱개를 섞을 수 있어서 Slack은 MCP 서버 전체를 가져오고, Gmail은 Gmail_ListEmails, Gmail_SendEmail, Gmail_WhoAmI 셋만 추가하면 돼요.

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

여기서부터는 타입 이야기가 되는데, 가져온 도구가 Zod tool로 한 번 감싸이면서 실행과 authorization이 같은 껍데기 안으로 들어와요. toZodToolSet은 Arcade tool definition을 Zod tool set으로 바꿔줘요. executeOrAuthorizeZodTool helper를 붙이면 실행과 authorization 처리도 함께 다룰 수 있죠.

```typescript
const zodTools = toZodToolSet({
  tools: allTools,
  client: arcade,
  userId,
  executeFactory: executeOrAuthorizeZodTool,
});
```

묶어 놓고 나면 다음 질문은 권한이 없을 때 무엇을 돌려주느냐예요. 같은 문제를 코드로 풀어 둔 자리가 공식 템플릿 저장소에 있는데, lib/arcade/server.ts에서는 도구 실행 중 PermissionDeniedError가 발생하면 tools.authorize를 호출해 authorization response를 돌려줘요. PermissionDeniedError가 실패로 끝나지 않고 authorization response로 바뀌는 셈이에요.

```typescript
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

권한 요청만 따로 받는 authorization endpoint도 마련돼 있는데, 이대리로 옮기면 preview-gate 버튼이 눌린 뒤 Slack이 authorization URL을 되돌려 주는 자리가 여기에 해당해요. 공식 템플릿의 app/(chat)/api/tools/auth/route.ts는 로그인된 session.user.id와 toolName을 받아 Arcade의 tools.authorize를 호출해요.

```typescript
const authResponse = await arcadeServer.client.tools.authorize({
  tool_name: formattedToolName,
  user_id: session.user.id,
});

return NextResponse.json(authResponse);
```

코드를 여기까지 따라오면 우리 쪽 배치도 그대로 겹쳐져요. IntentClassifierUsecase가 도구를 고르고, slack 핸들러가 slackUserId로 현재 사용자를 식별하는 자리가 각각 모델과 애플리케이션 몫이에요. Arcade는 그 사용자에게 해당 tool action을 수행할 authorization이 있는지 확인해요. 권한이 있으면 실행하고, 없으면 authorization 흐름을 반환하죠.

### 7,500개보다 중요한 건 실행 직전의 확인 한 번이다

도구가 몇 개인지는 설계에서 가장 덜 중요한 숫자예요.

Arcade가 내건 7,500+ agent-optimized tools와 81 MCP servers도 그 점에서는 마찬가지고요. 도구가 늘어날수록 실행 기록 하나에 사용자, scope, action이 함께 남아 있어야 하니까요.

프로덕션 에이전트 인증에서 static API key, shared service account, DIY OAuth는 결국 같은 지점에서 무너져요. agent, user, task-specific authorization context는 셋을 따로 보면 의미가 없고, 런타임에서 한꺼번에 평가해야 뜻이 생기거든요.

사용자가 어떤 SaaS 권한을 갖고 있어도 에이전트가 그 권한을 모두 마음대로 써도 된다는 뜻은 아니에요. 에이전트의 역할과 사용자의 위임, 현재 작업 맥락이 겹치는 범위만 실행 가능한 권한으로 삼아야 해요.

Vercel AI SDK 예제에서도 같은 관점이 보여요. 사용자가 화면에서 고른 toolkit만 selectedToolkits로 좁혀 가져오는 것부터가 그 관점이에요. getToolsByToolkits({ userId: session.user.id, toolkits: selectedToolkits })에는 사용자 식별자도 함께 넘겨요. 이후 streamText에는 Arcade tools와 자체 도구가 같이 들어가죠.

```typescript
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

팀마다 답이 갈리는 이유는 하나예요.

런타임 자체가 폐쇄형이라는 점이 이 판단에서 가장 무거운 조건이에요. 공식 SDK와 도구, 문서는 볼 수 있어도 실제 tool call을 집행하는 런타임을 조직이 얼마나 직접 통제해야 하는지에 따라 판단은 달라져요.

보안팀이 VPC, self-host, audit export, SIEM 연동 수준을 요구한다면 공식 문서의 주장만 봐서는 부족해요. 실제 계약과 배포 옵션을 따로 확인해야 하죠.

Scalekit의 비교 글은 Arcade가 per-user delegation, MCP-native runtime, tool evaluation framework에서 강점이 있다고 봐요. 아직 검증 중인 쪽은 런타임이 닫혀 있다는 점이에요. 조직 단위 자격증명 계층이나 SIEM으로 빼내는 감사 로그, 대규모 엔터프라이즈 운영 레퍼런스는 그다음 문제고요.

경쟁사 글이라 그대로 결론을 내릴 수는 없지만, 도입 체크리스트로는 쓸 만해요. 공식 문서가 "SIEM policies"와 "OpenTelemetry audit logs"를 내세운다면, 조직이 원하는 export, retention, tenant-level policy를 실제로 지원하는지 확인해야 해요.

### 도구 호출이 끝나도 orchestration은 남는다

도구 호출만으로 끝나지 않는 시스템에는 별도 계층이 필요해요.

Arcade가 맡는 범위는 action runtime에서 끊기고, 그 바깥은 전부 우리 몫으로 남아요. 장기 동기화와 webhook 기반 이벤트 수집, 도메인별 승인 워크플로우, 내부 DB 트랜잭션 정합성은 여전히 애플리케이션의 책임이에요.

GitHub 코멘트를 남긴 뒤 내부 agent-run 상태와 Slack 응답까지 함께 정리하려면 실행과 조율을 갈라 놓아야 해요. 이렇게 나눈다면 Arcade는 외부 action을 실행하는 포트까지만 맡고, 전체 유스케이스 orchestration은 NestJS application layer에 남게 돼요.

단일 사용자 개인 자동화라 OAuth와 audit 경계가 지나치게 무거운 경우에는 도입 비용이 이득보다 클 수 있어요.

이대리가 정확히 그 경우예요. 사용자가 저 하나라 "사용자별 위임"이 아직 값을 못 하고, 지금 얻는 건 위임이 아니라 실행 기록의 결이에요. 지원하지 않는 내부 SaaS가 대부분이거나 외부 런타임 의존을 허용할 수 없는 경우도 마찬가지예요. 이미 조직 표준 IdP·토큰 vault·policy engine·MCP gateway를 직접 운영하는 경우에도 잘 맞지 않을 수 있죠.

## 내 시스템에 붙인다면 ToolExecutionPort부터 생긴다

Slack 기반 멀티 에이전트 시스템에 대입해 보면 Arcade가 모든 모듈에 닿는 것은 아니에요. 먼저 연결될 곳은 model-router, agent-run, slack, github, notion, 그리고 실행형 에이전트들이에요.

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
  }): Promise<{
    status: ToolExecutionStatus;
    result?: unknown;
    authorizationUrl?: string;
    reason?: string;
  }>;
}
```

### preview-gate가 못 묻는 것을 채운다

제 시스템에는 이미 preview-gate가 외부 부작용을 ✅ 버튼 뒤에 세워 두고 있어요. ToolExecutionPort는 그 게이트가 못 묻는 것, 누구의 권한으로 나가는 행동인가를 채우는 층이에요. agent/code-reviewer가 PR 리뷰를 "작성"하거나 agent/work-reviewer가 Slack에 보고서를 "전송"할 때 적용돼요. agent/blog가 초안을 외부 문서 시스템에 "저장"하는 순간도 같은 경계를 거쳐요.

agent-run에는 실행을 시도한 에이전트와 빌려 쓴 사용자 권한, 부르려던 toolName을 함께 남겨요. authorization이 없다면 authorization_required 상태로 Slack에 연결 링크를 돌려줘요. 실패 기록도 모델 실패와 도구 실패로 나눠 남겨요.

붙일 곳을 정하는 일은 안 붙일 곳을 정하고 나서야 끝나요. agent/be-test, agent/be-schema, agent/be-sre처럼 로컬 코드 분석이나 내부 생성 작업이 중심인 모듈은 Arcade의 1차 대상이 아니에요. 이 모듈에는 외부 SaaS 권한보다 sandbox와 repo 접근 경계, 테스트 실행 로그가 더 중요하거든요.

### 그래서 지금은 인터페이스만 세워 둔다

안 붙이기로 정하고 나서야 이 글에서 건진 게 뭔지 알았어요. Arcade가 아니라 "LLM이 생각한 결과를 외부 서비스의 사용자 계정으로 실행하는 자리"라는 이름 하나였어요.

그래서 지금 당장 Arcade를 붙이지는 않으려고 해요. 이대리에서 사용자 권한으로 외부에 쓰는 일이 아직 몇 갈래 안 되니, ToolExecutionPort 인터페이스만 먼저 세워 두고 그 뒤는 기존 preview-gate로 막아 두는 편이 지금 규모에 맞거든요.

이 인터페이스 뒤가 붐비기 시작하는 날이 Arcade를 다시 꺼내 볼 날이에요.

## 참고한 출처

- https://docs.arcade.dev/en/get-started/about-arcade
- https://docs.arcade.dev/get-started/agent-frameworks/vercelai
- https://docs.arcade.dev/en/resources/tools
- https://docs.arcade.dev/en/build/tool-calling/custom-apps/get-tool-definitions
- https://github.com/ArcadeAI/arcade-vercel-ai-template
- https://www.arcade.dev/blog/best-ai-agent-authentication-platforms
- https://www.scalekit.com/blog/arcade-alternatives
