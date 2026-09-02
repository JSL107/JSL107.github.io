---
title: "에이전트의 행동을 통제하는 실행 전 권한 경계"
description: "Arcade.dev Actions Runtime을 통해 사용자별 OAuth 권한, 도구 실행, 감사 로그를 에이전트의 행동 경계로 분리하는 방법을 살펴본다."
pubDatetime: 2026-09-02T19:09:00+09:00
category: backend
---

Slack 기반 에이전트가 정보를 읽고 요약하는 데서 나아가 사용자의 권한으로 외부 서비스를 조작한다면, bot token만으로는 부족해요. 이 글에서는 그때 필요한 실행 전 권한 경계와 Arcade.dev Actions Runtime의 역할을 다뤄요.

### Slack bot token으로 충분하지 않아지는 순간

Slack 기반 에이전트를 처음 만들 때는 bot token 하나만으로도 제법 많은 일을 해요. 멘션을 받아 스레드에 답하고, GitHub PR을 읽어 요약한 뒤 다시 Slack에 올릴 수 있죠. 여기까지는 "봇이 정보를 읽고 정리한다"에 가까워요. 권한 모델도 단순해요. Slack 앱과 GitHub 앱이나 토큰에 부여한 권한, 서버 환경변수에 넣어 둔 키가 그대로 에이전트의 행동 범위가 되니까요.

문제는 에이전트가 실제 작업을 "수행"하기 시작할 때 생겨요. 사용자가 "이 PR 리뷰 코멘트에 답장 초안 달아줘", "회의 요약을 문서에 저장해줘", "내 이름으로 담당자에게 Slack DM 보내줘"라고 요청하는 경우를 생각해 볼게요. bot token이나 서버 공용 토큰으로 처리하면 구현은 빠르지만 권한의 경계가 흐려져요.

이 행동을 봇이 한 것인지, 사용자가 위임한 것인지 구분하기 어려워요. 사용자가 권한을 철회했을 때 다음 실행을 막을 수 있는지도 확인해야 하죠. 실행 전에 필요한 scope를 확인하고, 나중에는 감사 로그에서 어떤 사용자 권한으로 어떤 도구를 실행했는지 추적할 수 있어야 해요.

Arcade.dev Actions Runtime을 살펴볼 이유가 바로 여기에 있어요. 단순히 "도구가 많이 있는 카탈로그"라기보다, 에이전트가 외부 SaaS에서 행동하기 직전에 OAuth, 토큰, 권한 확인, 실행, 감사 경계를 다시 거치게 하는 실행 계층에 가까워요. 읽기와 요약에 집중하는 에이전트에는 과해 보일 수 있어요. 사용자별 권한으로 Gmail, Slack, GitHub 같은 서비스를 실제로 조작하기 시작하면 설계의 중심이 되죠.

### Arcade는 도구 목록이 아니라 행동 실행면에 가깝다

공식 문서는 Arcade를 "enterprise-ready actions runtime for AI agents"라고 설명해요. 핵심은 Authorization을 강제하는 Enforce, 에이전트용 도구 실행을 맡는 Execute, 레지스트리·버전·가시성·OpenTelemetry audit logs 같은 운영 관리를 담은 Govern, 이렇게 세 축이에요. 공식 소개 페이지에 따르면 Arcade는 OAuth 2.0, API keys, user tokens를 다루고 도구마다 필요한 OAuth scope를 확인해요.

기존 방식과 비교하면 차이가 더 또렷하게 보여요. 직접 만든 tool function은 애플리케이션 코드 안에 함수와 권한 판단이 뒤섞이기 쉬워요. MCP 서버는 모델이나 클라이언트가 호출할 표준 도구면을 제공하지만, 사용자별 OAuth 위임이나 토큰 보관, per-action authorization, 감사 정책까지 저절로 생기지는 않아요. Arcade는 이 실행면을 모델 프레임워크 밖으로 꺼내고, 도구 호출이 들어오면 "이 사용자에게 이 액션을 수행할 권한이 있는가"를 런타임에서 확인하는 쪽에 가까워요.

공식 문서는 Gmail.SendEmail 같은 도구에 https://www.googleapis.com/auth/gmail.send scope가 필요하다고 예를 들어요. GoogleSearch.Search처럼 사용자별 authorization이 필요 없는 도구도 있어요. 모든 도구를 똑같이 다루지 않고, 실행 직전에 각 도구가 요구하는 권한을 확인한다는 점이 중요하죠. 에이전트가 "이메일 보내기"를 호출하면 Arcade는 먼저 해당 사용자에게 필요한 grant가 있는지 살펴보고, 없다면 OAuth authorization flow를 진행해요.

### Vercel AI SDK 예제로 보는 연결 방식

TypeScript 개발자가 전체 구조를 잡을 때는 공식 Vercel AI SDK 가이드가 읽기 편해요. 이 가이드는 Next.js 챗봇을 만들면서 Arcade를 도구 접근과 authorization 계층으로 연결하고, 필요한 패키지도 분명하게 알려줘요.

```bash
pnpm add ai @ai-sdk/openai @ai-sdk/react @arcadeai/arcadejs zod
pnpm dlx ai-elements@latest
```

환경변수 예시는 단순하고, 그중 눈여겨볼 값은 ARCADE_USER_ID예요. 공식 가이드는 이를 앱 내부 사용자 식별자라고 설명해요. 이메일, UUID, 내부 DB user ID처럼 안정적인 값을 넣을 수 있고, Arcade는 이 값을 기준으로 사용자별 tool authorization을 추적하거든요.

```plain text
ARCADE_API_KEY={arcade_api_key}
ARCADE_USER_ID={arcade_user_id}
OPENAI_API_KEY=your_openai_api_key
```

도구는 MCP 서버 단위와 개별 도구 단위를 섞어서 설정할 수 있어요. 공식 가이드에서는 Slack MCP 서버 전체를 가져오고, Gmail에서는 Gmail_ListEmails, Gmail_SendEmail, Gmail_WhoAmI만 추가해요. 모델에는 "권한이 필요하면 수동으로 안내하지 말고 도구를 호출하라"고 지시해요. authorization 처리를 도구 실행 계층에서 맡기 때문이에요.

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

Arcade JS에서는 도구를 가져와 Zod tool로 바꾸는 흐름을 보여줘요. 공식 문서에 따르면 toZodToolSet으로 Arcade tool definition을 Zod tool set으로 바꿀 수 있어요. executeOrAuthorizeZodTool helper를 붙이면 실행과 authorization 처리도 함께 다룰 수 있죠.

```typescript
const zodTools = toZodToolSet({
  tools: allTools,
  client: arcade,
  userId,
  executeFactory: executeOrAuthorizeZodTool,
});
```

공식 템플릿 저장소의 구현도 같은 문제를 다뤄요. lib/arcade/server.ts에서는 도구 실행 중 PermissionDeniedError가 발생하면 tools.authorize를 호출해 authorization response를 돌려줘요. 실행과 권한 요청을 같은 포트 뒤에 묶었다는 점이 핵심이에요.

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

별도 authorization endpoint도 마련돼 있어요. 공식 템플릿의 app/(chat)/api/tools/auth/route.ts는 로그인된 session.user.id와 toolName을 받아 Arcade의 tools.authorize를 호출해요.

```typescript
const authResponse = await arcadeServer.client.tools.authorize({
  tool_name: formattedToolName,
  user_id: session.user.id,
});

return NextResponse.json(authResponse);
```

구조가 전하는 메시지는 분명해요. 모델은 도구를 호출하고, 애플리케이션은 현재 사용자를 식별해요. Arcade는 그 사용자에게 해당 tool action을 수행할 authorization이 있는지 확인해요. 권한이 있으면 실행하고, 없으면 authorization 흐름을 반환하죠.

### 도구 수보다 중요한 실행 전 권한 교차점

Arcade 공식 소개에는 7,500+ agent-optimized tools와 81 MCP servers가 나와요. 숫자도 인상적이지만 실제 설계에서는 도구 수보다 권한 경계가 더 중요해요. 도구가 늘어날수록 "어떤 사용자가 어떤 scope로 어떤 action을 실행했는가"를 일관되게 다뤄야 하니까요.

Arcade의 블로그 글은 프로덕션 에이전트 인증에서 static API key, shared service account, DIY OAuth가 무너지는 지점을 짚어요. 특히 "agent, user, task-specific authorization context"를 런타임에서 함께 평가해야 한다고 강조해요.

사용자가 어떤 SaaS 권한을 갖고 있어도 에이전트가 그 권한을 모두 마음대로 써도 된다는 뜻은 아니에요. 에이전트의 역할과 사용자의 위임, 현재 작업 맥락이 겹치는 범위만 실행 가능한 권한으로 삼아야 해요.

Vercel AI SDK 예제에서도 같은 관점이 보여요. selectedToolkits로 사용자가 선택한 toolkit만 가져와요. getToolsByToolkits({ userId: session.user.id, toolkits: selectedToolkits })에는 사용자 식별자도 함께 넘겨요. 이후 streamText에는 Arcade tools와 자체 도구가 같이 들어가죠.

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

이 예시는 "Arcade가 모든 것을 대체한다"는 뜻이 아니에요. 기존 agent framework의 tool calling 슬롯에 Arcade가 권한 있는 외부 도구 묶음으로 들어가는 모습을 보여줘요. 내부 문서 생성 도구는 애플리케이션 코드에 남기고, Gmail·Slack 같은 외부 SaaS 도구는 Arcade에서 가져와요. 실제 시스템에서도 이 정도로 나누는 편이 가장 현실적이에요.

### 폐쇄형 런타임과 운영 검증의 한계

Arcade의 매력은 분명하지만 모든 팀에 곧바로 맞는 답은 아니에요. 런타임 자체에는 폐쇄형 성격이 있어요. 공식 SDK와 도구, 문서는 볼 수 있어도 실제 tool call을 집행하는 런타임을 조직이 얼마나 직접 통제해야 하는지에 따라 판단은 달라져요.

보안팀이 VPC, self-host, audit export, SIEM 연동 수준을 요구한다면 공식 문서의 주장만 봐서는 부족해요. 실제 계약과 배포 옵션을 따로 확인해야 하죠.

Scalekit의 비교 글은 Arcade가 per-user delegation, MCP-native runtime, tool evaluation framework에서 강점이 있다고 봐요. closed-source runtime, org-level credential hierarchy, SIEM-exportable audit logs, 대규모 엔터프라이즈 운영 레퍼런스는 아직 검증 중인 영역으로 평가해요.

경쟁사 글이라 그대로 결론을 내릴 수는 없지만, 도입 체크리스트로는 쓸 만해요. 공식 문서가 "SIEM policies"와 "OpenTelemetry audit logs"를 내세운다면, 조직이 원하는 export, retention, tenant-level policy를 실제로 지원하는지 확인해야 해요.

도구 호출만으로 끝나지 않는 시스템에는 별도 계층이 필요해요. Arcade는 action runtime에 가까워요. 장기 동기화와 webhook 기반 이벤트 수집, 도메인별 승인 워크플로우, 내부 DB 트랜잭션 정합성은 여전히 애플리케이션의 책임이에요.

GitHub 코멘트를 남긴 뒤 내부 agent-run 상태와 Slack 응답까지 함께 정리하는 경우를 생각해 볼게요. Arcade는 외부 action을 실행하는 포트가 되고, 전체 유스케이스 orchestration은 NestJS application layer에 남아요.

단일 사용자 개인 자동화라 OAuth와 audit 경계가 지나치게 무거운 경우에는 도입 비용이 이득보다 클 수 있어요. 지원하지 않는 내부 SaaS가 대부분이거나 외부 런타임 의존을 허용할 수 없는 경우도 마찬가지예요. 이미 조직 표준 IdP·토큰 vault·policy engine·MCP gateway를 직접 운영하는 경우에도 잘 맞지 않을 수 있죠.

### 내 시스템에 붙인다면 ToolExecutionPort부터 생긴다

Slack 기반 멀티 에이전트 시스템에 대입해 보면 Arcade가 모든 모듈에 닿는 것은 아니에요. 먼저 연결될 곳은 model-router, agent-run, slack, github, notion, 그리고 실행형 에이전트들이에요.

agent/pm, agent/work-reviewer, agent/code-reviewer처럼 읽기·요약·리뷰가 중심인 모듈은 당장 Arcade 없이도 동작해요. 이들이 "실제 코멘트 작성", "Slack DM 발송", "문서 업데이트", "GitHub issue 상태 변경"까지 맡기 시작하면 별도 실행 포트가 필요해요.

현재 구조에서는 ModelRouterUsecase.route가 모델 응답을 만드는 역할에 머물고, 그 뒤에 ToolExecutionPort를 두는 편이 나아요. agent-run은 실행 전후 상태와 evidence를 기록하고, slack은 사용자 식별과 authorization URL 안내를 맡아요. github나 notion 같은 외부 시스템은 직접 토큰으로 호출하기보다 Arcade-backed adapter 뒤에서 실행할 수 있어요.

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

이 포트를 두면 외부 작업의 경계를 하나로 통일할 수 있어요. agent/code-reviewer가 PR 리뷰를 "작성"하거나 agent/work-reviewer가 Slack에 보고서를 "전송"할 때 적용돼요. agent/blog가 초안을 외부 문서 시스템에 "저장"하는 순간도 같은 경계를 거쳐요.

agent-run에는 어떤 에이전트가 어떤 사용자 권한으로 어떤 toolName을 실행하려 했는지 기록해요. authorization이 없다면 authorization_required 상태로 Slack에 연결 링크를 돌려줘요. 실패 기록도 모델 실패와 도구 실패로 나눠 남겨요.

agent/be-test, agent/be-schema, agent/be-sre처럼 로컬 코드 분석이나 내부 생성 작업이 중심인 모듈은 Arcade의 1차 대상이 아니에요. 이 모듈에는 외부 SaaS 권한보다 sandbox와 repo 접근 경계, 테스트 실행 로그가 더 중요하거든요.

Arcade를 붙일 곳은 결국 "LLM이 생각한 결과를 외부 서비스의 사용자 계정으로 실행하는 경계"예요. 에이전트가 행동하기 시작할 때 필요한 것은 더 많은 도구가 아니에요. 사용자와 작업 맥락에 맞는 권한만 실행하도록 통제하고, 그 결과를 추적할 수 있는 런타임이 필요해요.

### 참고한 출처

- https://docs.arcade.dev/en/get-started/about-arcade
- https://docs.arcade.dev/get-started/agent-frameworks/vercelai
- https://docs.arcade.dev/en/resources/tools
- https://docs.arcade.dev/en/build/tool-calling/custom-apps/get-tool-definitions
- https://github.com/ArcadeAI/arcade-vercel-ai-template
- https://www.arcade.dev/blog/best-ai-agent-authentication-platforms
- https://www.scalekit.com/blog/arcade-alternatives
