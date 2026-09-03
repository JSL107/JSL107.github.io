---
title: "Slack 봇 기능을 ChatGPT와 Codex 도구로 옮기는 기준"
description: "Slack 기반 업무 에이전트를 ChatGPT와 Codex로 옮길 때 기능을 skill-only, MCP server tool, UI로 구분하는 기준을 정리한다."
pubDatetime: 2026-09-03T19:05:00+09:00
category: backend
---

Slack 봇으로 업무 에이전트를 만들 때는 처음 흐름이 단순해요. /today를 치면 오늘 할 일을 만들고, /review-pr을 치면 PR diff를 읽어요. /worklog를 치면 보고서 초안이 나오죠. 사용자는 Slack에 머물고, 백엔드는 명령 이름에 맞는 유스케이스를 실행해요.

기능이 늘어나면 고민할 지점도 달라져요. 코드 리뷰는 Codex 안에서 바로 부르는 편이 자연스럽고, 반복 작업 절차는 ChatGPT의 skill만으로 충분할 수 있어요. 계정 데이터를 조회하거나 상태를 바꾸려면 서버 검증과 인증이 필요해요. 이제 “Slack 봇 기능 추가”가 아니라 기능을 skill-only, server tool, UI tool로 다시 나눠야 해요.

## Slack 명령이 아니라 모델 클라이언트의 도구가 된다

OpenAI 문서에서 plugin은 ChatGPT와 Codex가 발견하고 설치하며, 공유하고 배포하는 패키지 단위예요. SKILL.md와 참고 자료만 담은 skill-only 형태일 수도 있고, 외부 시스템을 잇는 MCP server를 포함할 수도 있어요. MCP는 Model Context Protocol의 약자로, LLM 클라이언트가 외부 도구와 데이터 소스에 연결되는 프로토콜이에요.

Slack slash command와는 호출 주체가 달라요. Slack에서는 /review-pr handler가 코드 리뷰를 실행해요. Apps SDK/Plugins에서는 ChatGPT나 Codex가 도구 이름과 설명, parameter schema, annotation을 읽고 지금 필요한 도구를 골라요. metadata는 문서라기보다 라우팅 모델이 읽는 제품 카피에 가까운 셈이죠.

| 형태 | 맞는 경우 |
| --- | --- |
| skill-only | 절차 지침과 기존 도구만으로 끝나는 반복 작업 |
| MCP server tool | live data, 인증, 서버 검증, 통제된 action이 필요한 작업 |
| MCP server + UI | 비교, 편집, 확인, 탐색처럼 시각적 상호작용이 필요한 작업 |

## 도구는 유저 목표 하나에 하나씩 작아야 한다

“Build an MCP Server” 문서는 use-case inventory부터 만들고, distinct user action마다 도구를 하나씩 두라고 해요. list_projects, get_project, update_project처럼 작게 나누고 여러 mode를 품은 거대한 도구는 피하는 방식이에요. 각 도구에는 action 중심의 이름과 설명, input/output schema, safety annotation이 필요해요. 권한을 확인하고 실행하는 handler도 있어야 해요.

공식 예시에서도 이 구조를 확인할 수 있어요. 결과는 사람이 읽는 content와 모델이 후속 호출에 사용하는 structuredContent로 나뉘어요.

```typescript
server.registerTool(
  "list_projects",
  {
    title: "List projects",
    description: "Use this when the user wants to find or review projects in their Acme workspace.",
    inputSchema: { status: z.enum(["active", "archived"]).optional() },
    outputSchema: {
      projects: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  async ({ status }) => {
    const projects = await listProjects({ status });
    return {
      structuredContent: { projects },
      content: [{ type: "text", text: `Found ${projects.length} projects.` }],
    };
  }
);
```

schema가 있어도 모델 입력을 그대로 믿어서는 안 돼요. handler가 요청을 authorize한 뒤 실제 작업을 수행해야 해요. _meta에는 client-specific data를 담을 수 있지만 모델에게 보이지 않을 뿐이에요. 문서도 _meta가 보안 저장소나 권한 검사를 대신하지 못한다고 명시하거든요.

## UI는 본체가 아니라 선택적 표시 계층이다

Apps SDK를 처음 접하면 iframe UI부터 눈에 들어와요. 문서가 앞세우는 원칙은 tools first예요. MCP tool은 UI 없이도 동작해야 ChatGPT, Codex, headless 환경에서 계속 쓸 수 있어요. UI는 사용자가 구조화된 정보를 비교하거나 편집하고, 최종 확인해야 할 때 붙여요.

ChatGPT UI 문서는 새 UI를 만들 때 MCP Apps standard를 먼저 쓰라고 해요. UI resource는 _meta.ui.resourceUri로 연결하고, iframe 안 component는 JSON-RPC over postMessage로 host와 통신해요. window.openai는 shared standard에 없는 기능이 필요할 때 feature detection으로 덧붙이는 확장이에요.

quickstart의 todo 예시를 보면 도구가 UI resource를 가리키는 방식을 알 수 있어요.

```javascript
registerAppTool(
  server,
  "add_todo",
  {
    title: "Add todo",
    description: "Creates a todo item with the given title.",
    inputSchema: addTodoInputSchema,
    outputSchema: todoOutputSchema,
    _meta: { ui: { resourceUri: "ui://widget/todo.html" } },
  },
  async (args) => {
    const title = args?.title?.trim?.() ?? "";
    if (!title) return replyWithTodos("Missing title.");
    const todo = { id: `todo-${nextId++}`, title, completed: false };
    todos = [...todos, todo];
    return replyWithTodos(`Added "${todo.title}".`);
  }
);
```

UI를 붙이는 기준은 “보기 좋은가”가 아니라 “대화 텍스트만으로는 검토·편집·확인이 불편한가”예요. 단순 조회나 요약이라면 structured result와 모델 응답만으로 충분할 때가 많아요.

## metadata와 보안은 운영 대상이다

Optimize Metadata 가이드는 ChatGPT와 Codex가 metadata를 읽고 tool call 여부를 판단한다고 설명해요. 이름에는 domain과 action이 함께 드러나야 하고, description은 “Use this when...”으로 시작하며 금지 사례도 적기를 권해요. read-only 도구에는 readOnlyHint: true를 붙여요. write 도구의 destructiveHint와 openWorldHint도 정확히 써야 하죠.

문서가 권하는 검증 방법은 golden prompt set이에요. 제품이나 데이터 소스를 직접 언급하는 direct prompt, 결과만 말하는 indirect prompt, 호출되면 안 되는 negative prompt를 나눠 라벨링해요. Developer mode에서 MCP server를 등록한 뒤 선택된 도구와 arguments, component 렌더링 여부를 기록해요. marginal recall을 높이기보다 negative prompt에서 high precision을 먼저 노리라고 해요.

보안은 slash command보다 더 엄격하게 다뤄야 해요. Security & Privacy 가이드는 least privilege, explicit user consent, defense in depth를 원칙으로 삼아요. 모델이 만든 입력도 untrusted input으로 보고 검증해야 해요. irreversible operation에는 human confirmation을 요구하고, 민감한 작업에는 audit log를 남겨야 하죠. component props에 secret이나 token을 넣지 않는 것도 기본이에요.

## 내 시스템에 대입하면 세 갈래로 나뉜다

Slack 기반 멀티 에이전트 시스템의 모든 모듈을 plugin tool로 옮길 필요는 없어요. agent/blog, humanize, docs-audit처럼 절차와 문체, 검증 규칙이 핵심인 모듈은 skill-only에 가까워요. 이런 모듈은 서버보다 SKILL.md, references, templates의 품질을 먼저 챙겨야 해요.

agent/code-reviewer, agent/pm, agent/work-reviewer, github는 read-only MCP tool 후보로 볼 수 있어요. PR, issue, plan, worklog의 근거를 읽어 구조화된 결과로 돌려줄 수 있기 때문이에요. list_assigned_work_items에는 “Use this when the user wants to review assigned issues and pull requests before planning today’s work.” 같은 설명을 붙일 수 있어요.

agent/job-application은 non-destructive write와 UI가 함께 맞닿아 있어요. 지원 상태 갱신은 사용자 기록을 바꾸므로 서버가 상태 전이를 검증해야 하고, 목록 비교나 편집에는 UI가 도움이 될 수 있어요. notification, slack, autopilot처럼 외부 전송이나 발행으로 이어질 수 있는 모듈은 open-world action이에요. 이런 모듈은 확인 prompt와 audit log부터 갖춰야 해요.

| 모듈 | 우선 형태 | 이유 |
| --- | --- | --- |
| agent/blog, humanize, docs-audit | skill-only | 절차와 산출물 규칙이 핵심 |
| agent/code-reviewer, agent/pm, github | read-only MCP tool | 외부 데이터를 읽어 구조화 가능 |
| agent/job-application | write tool + 선택적 UI | 상태 변경과 목록 검토가 함께 필요 |
| notification, slack, autopilot | open-world action | 외부 전송 위험이 있어 확인 필요 |

## 옮기는 순서도 도구 경계에서 시작한다

먼저 read-only 조회 하나, non-destructive write 하나, open-world action 하나를 골라요. metadata 초안은 실제 prompt로 검증하고, direct, indirect, negative prompt를 만든 뒤 선택된 도구와 arguments를 기록해요.

그다음에는 UI 없는 MCP server부터 세워요. stable name/version, schema, structuredContent, authorization, audit log를 고정한 뒤에야 UI를 붙일지 판단할 수 있어요. Apps SDK/Plugins의 핵심은 화면이 아니에요. 모델이 안전하게 호출할 수 있는 작업 경계를 배포하는 데 있거든요.
