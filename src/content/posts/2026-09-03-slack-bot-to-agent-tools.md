---
title: "Slack 봇 기능, 어디까지 skill 이고 어디부터 MCP server 인가"
description: "Slack 슬래시 명령으로 만든 업무 에이전트를 ChatGPT·Codex plugin 으로 옮길 때 기능을 skill-only, MCP server tool, MCP server + UI 로 가르는 선을 OpenAI 공개 문서에서 뽑아 정리한다. 실제 이관과 측정은 아직 하지 않았다."
pubDatetime: 2026-09-03T19:05:00+09:00
category: backend
---

Slack 봇으로 업무 에이전트를 만들 때는 처음 흐름이 단순해요. /today를 치면 오늘 할 일을 만들고, /review-pr을 치면 PR diff를 읽고, /worklog를 치면 보고서 초안이 나오죠. 사용자는 Slack에 머물고, 백엔드는 명령 이름에 맞는 유스케이스를 실행해요.

기능이 늘어나면 고민할 지점도 달라져요. 코드 리뷰는 Codex 안에서 바로 부르는 편이 자연스럽고, 반복 작업 절차는 ChatGPT의 skill만으로 충분할 수 있어요. 계정 데이터를 조회하거나 상태를 바꾸려면 서버 검증과 인증이 필요해요. 이제 “Slack 봇 기능 추가”가 아니라 기능을 skill-only, server tool, UI tool로 다시 나눠야 해요.

이 선을 잘못 그으면 값을 조용히 치러요. 인증이 필요한 조회를 skill-only 쪽에 두면 서버가 요청을 검증하는 단계 자체가 사라지고, 반대로 절차 지침만으로 끝날 작업에 MCP server를 세우면 인증과 배포를 계속 운영해야 하죠. 갈래를 정하는 일이 곧 무엇을 검증할지 정하는 일이에요.

이 글은 Slack 슬래시 명령으로 사내 도구를 만들어 두고 그걸 ChatGPT나 Codex 쪽으로 옮길지 저울질하는 백엔드 개발자를 위해 썼어요. 읽고 나면 자기 기능 목록을 세 갈래로 나누고 각 갈래에서 무엇을 포기하는지까지 말할 수 있어요. 범위는 딱 거기까지예요. 여기 적은 기준은 OpenAI 공개 문서를 읽고 세운 것이고, 실제 이관도 성능 측정도 아직 하지 않았어요. 참고한 문서의 제목과 URL은 글 끝에 모아 뒀어요.

## Slack 명령이 아니라 모델 클라이언트의 도구가 된다

Slack에서는 /review-pr handler가 코드 리뷰를 실행했어요. 옮기고 나면 호출 주체가 바뀌어요. ChatGPT나 Codex가 도구 이름과 설명, parameter schema, annotation을 읽고 지금 필요한 도구를 고르거든요. metadata는 문서라기보다 라우팅 모델이 읽는 제품 카피에 가까운 셈이죠.

그 도구를 담아 배포하는 단위가 plugin이에요. Plugin architecture 문서는 plugin을 “ChatGPT와 Codex에서 사람들이 발견하고 설치하고 공유하고 배포하는 패키지”로 정의하고, 그 안에 skill만 담을 수도, 외부 시스템을 잇는 MCP server를 담을 수도, 둘 다 담을 수도 있다고 해요. 같은 문서에서 skill은 “SKILL.md 파일 하나와 필요할 때 딸려 오는 스크립트, 참고 자료, 템플릿, 에셋을 담은 폴더”예요. MCP는 Model Context Protocol의 약자로, LLM 클라이언트가 외부 도구와 데이터 소스에 연결되는 프로토콜이고요.

이름 하나만 미리 정리할게요. 문서 사이트에는 Apps SDK와 Plugins 두 이름이 함께 남아 있어요. `/apps-sdk` 경로로 들어가도 Plugins 문서가 열리지만, 두 이름이 같은 것을 가리킨다고 직접 밝힌 문장은 제가 확인한 문서 범위에서 찾지 못했어요. 그래서 아래에서는 문서가 지금 쓰는 표기인 Plugins로 통일해요.

| 형태            | 맞는 경우                                    | 포기하는 것                                                                                                    |
| --------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| skill-only      | 절차 지침과 기존 도구만으로 끝나는 반복 작업 | 문서가 MCP server를 붙이는 조건으로 든 것들, 즉 live data 접근과 인증, 서버 쪽 검증, 통제된 action              |
| MCP server tool | live data, 인증, 서버 검증, 통제된 action    | 화면. 결과가 structuredContent와 모델 응답으로만 나가서 비교·편집·확인은 대화 텍스트에 기대야 해요              |
| MCP server + UI | 비교, 편집, 확인, 탐색처럼 시각적 상호작용   | UI에만 있는 기능. 도구는 component 없이도 워크플로가 끝나야 하고, iframe은 strict CSP(Content Security Policy, 브라우저가 허용한 것 말고는 실행·연결을 막는 정책) 아래라 특권 API를 못 써요 |

## 도구는 유저 목표 하나에 하나씩 작아야 한다

형태를 골랐다면 다음 질문은 그 안을 도구 몇 개로 쪼갤지예요. 도구는 사용자가 하려는 일 하나에 하나씩 두는 편이 좋고, 여러 mode를 품은 거대한 도구는 피하는 게 나아요. “Build an MCP server” 문서가 정확히 그렇게 권해요. 먼저 use-case inventory, 그러니까 이 plugin이 지원할 사용 사례를 빠짐없이 적은 목록을 만들고, distinct user action(서로 구별되는 사용자 행동)마다 도구를 하나씩 두라고요. list_projects, get_project, update_project처럼 작게 나누는 방식이에요.

각 도구에는 action 중심의 이름과 설명, input/output schema, 이 도구가 읽기만 하는지 되돌릴 수 없는지를 클라이언트에 알려 주는 safety annotation이 붙고, 권한을 확인한 뒤 실제 작업을 실행하는 handler까지 있어야 해요.

아래는 문서의 list_projects 예시를 그대로 옮긴 것이에요. 내용은 손대지 않았고 줄바꿈만 줄였어요. `z`는 zod, 즉 스키마를 선언하고 런타임에 값을 검증하는 라이브러리고, `server`는 그 앞에서 만들어 둔 MCP server 인스턴스, `listProjects`는 예시에 정의가 없는 서비스 쪽 조회 함수 자리예요. 이 페이지는 패키지 버전도 Node 버전도 적어 두지 않았고 저도 실행해 보지 않았으니, 최소 재현 조건은 뒤에 나오는 quickstart 쪽 숫자를 보세요.

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

결과는 사람이 읽는 content와 모델이 후속 호출에 사용하는 structuredContent로 나뉘어요. 여기에 자리가 하나 더 있는데, 위 코드에는 나오지 않는 `_meta`예요. 문서는 `_meta`를 “모델에게는 감춰지는 클라이언트용 데이터”로 설명해요. 감춰진다는 말이 안전하다는 뜻은 아니에요. 문서도 `_meta`를 authorization이나 보안 저장소의 대체물로 여기지 말라고 못 박거든요.

schema가 있어도 모델 입력을 그대로 믿어서는 안 돼요. 문서의 표현으로는 모든 도구 입력을 신뢰할 수 없는 것으로 취급하고, 사용자에게 접근 권한이 있는지를 모델이 판단하게 두지 말고 서버가 요청마다 authorize하라는 거예요.

## UI는 본체가 아니라 선택적 표시 계층이다

도구 경계를 그렇게 잡고 나면 화면은 그다음 질문이 돼요. 그리고 그 답은 “꼭 만들 필요는 없다”에 가까워요. Plugin architecture 문서는 “Custom UI is not required for an MCP server”, 그러니까 MCP server에 별도 UI가 필수는 아니라고 못 박고, “Add UI to your MCP server” 문서도 component 없이 워크플로가 끝나도록 도구를 유지하라고 해요. 그래야 component를 렌더링하지 않는 클라이언트에서도 계속 쓸 수 있으니까요. UI는 사용자가 구조화된 정보를 비교하거나 편집하고, 최종 확인해야 할 때 붙여요.

새 UI를 만든다면 ChatGPT 전용 확장보다 MCP Apps standard가 먼저예요. MCP가 도구 호출 프로토콜이라면 MCP Apps standard는 그 위에 얹힌 UI 규약으로, MCP server가 도구와 UI resource를 어떻게 잇고 iframe이 host와 어떻게 통신하는지를 정한 공개 표준이에요. ChatGPT가 이 표준을 구현하고 있고요. 문서에 따르면 UI resource는 `_meta.ui.resourceUri`로 연결하고, iframe 안 component는 JSON-RPC over postMessage, 즉 브라우저의 postMessage로 주고받는 JSON-RPC 호출로 host와 통신해요. window.openai는 이 표준이 덮지 못하는 기능이 필요할 때만 얹는 확장이라, 호스트 이름을 보고 분기하지 말고 필요한 기능이 있는지를 먼저 확인하는 feature detection으로 붙이고 가능하면 대체 경로를 함께 두라고 권해요.

“MCP server and UI quickstart”의 todo 예시를 보면 도구가 UI resource를 가리키는 방식이 한눈에 들어와요. 아래도 문서의 코드를 그대로 옮긴 것이에요. `registerAppTool`은 quickstart가 설치하게 하는 `@modelcontextprotocol/ext-apps` 패키지가 제공하는 함수고, `addTodoInputSchema`, `todoOutputSchema`, `replyWithTodos`, `nextId`, `todos`는 quickstart가 같은 파일 위쪽에서 직접 만든 예시용 값과 헬퍼예요. `todos`는 메모리에 든 배열, `replyWithTodos`는 content와 structuredContent를 함께 돌려주는 함수죠.

재현하려면 `"type": "module"`로 둔 Node 프로젝트에 `npm install @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod`가 필요해요. quickstart가 적어 둔 버전은 `@modelcontextprotocol/sdk` ^1.20.2, `@modelcontextprotocol/ext-apps` ^1.0.1, `zod` ^3.25.76이에요. Node 버전은 문서에 없고 저도 확인하지 못했어요.

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

도구를 나누고 화면까지 정했다면, 남는 일은 모델이 그 도구를 제때 고르게 만드는 것과 잘못 골랐을 때 다치지 않게 하는 것이에요.

metadata는 한 번 쓰고 끝내는 설명문이 아니라 계속 고쳐 가며 운영하는 대상이에요. Optimize Metadata 가이드가 그렇게 보는 이유는 단순해요. ChatGPT와 Codex가 이 metadata를 읽고 tool call 여부를 판단하거든요. 가이드는 이름에 domain과 action을 함께 드러내고(`calendar.create_event`처럼), description은 “Use this when…”으로 시작하며 쓰면 안 되는 경우도 적기를 권해요. 조회 전용 도구에는 `readOnlyHint: true`를, 쓰기 도구에는 되돌릴 수 없는 작업인지 알리는 `destructiveHint`와 외부 세계에 영향을 주는지 알리는 `openWorldHint`를 정확히 붙여야 하죠.

검증 방법으로 가이드가 권하는 건 golden prompt set이에요. 제품이나 데이터 소스를 직접 언급하는 direct prompt, 도구 이름 없이 원하는 결과만 말하는 indirect prompt, 내장 도구나 다른 도구가 처리해야 해서 내 도구가 호출되면 안 되는 negative prompt로 나눠 라벨을 붙여요.

그다음은 기록과 판정이에요. 개발자는 ChatGPT 설정의 Security and login에서 Developer mode, 즉 개발 중인 MCP server를 직접 등록해 시험할 수 있게 하는 모드를 켜고 서버를 등록한 뒤, 프롬프트마다 어떤 도구가 선택됐고 어떤 arguments가 넘어갔으며 component가 렌더링됐는지를 기록해요. 판정 순서는 recall보다 precision이 먼저예요. 가이드는 marginal recall, 그러니까 호출돼야 할 프롬프트를 조금 더 잡아내는 개선을 쫓기 전에 negative prompt에서 high precision, 즉 호출되면 안 되는 자리에서 호출되지 않는 정확도를 먼저 확보하라고 해요.

보안은 slash command 때보다 더 엄격하게 잡아야 해요. Security & Privacy 가이드가 세우는 원칙은 셋이에요. 필요한 scope와 저장소 접근, 네트워크 권한만 요청하는 least privilege(최소 권한), 계정을 연결하거나 쓰기 권한을 주는 순간을 사용자가 분명히 알게 하는 explicit user consent(명시적 사용자 동의), prompt injection과 악의적 입력이 서버까지 닿는다고 가정하고 층층이 막는 defense in depth(다층 방어)예요.

실행 규칙은 이 원칙을 서버 코드로 내린 것들이에요. 서버를 만드는 쪽이 모델이 만든 입력도 untrusted input으로 보고 서버에서 검증하고, irreversible operation 앞에서는 human confirmation을 요구하고, 민감한 작업에는 PII(이름·연락처처럼 개인을 식별할 수 있는 정보)를 지운 audit log를 남겨요. component props에 secret이나 token을 넣지 않는 것도 같은 목록에 들어가요.

## 내 시스템에 대입하면 세 갈래로 나뉜다

여기까지가 문서에서 읽은 기준이고, 이제 제 것에 대 볼 차례예요. 제가 굴리는 건 Slack을 입구로 쓰는 멀티 에이전트 백엔드로, NestJS 모듈 하나가 에이전트 하나 또는 연동 대상 하나를 맡고 슬래시 명령이나 cron이 그 모듈의 유스케이스를 부르는 구조예요. 모듈은 대체로 세 축으로 갈려요. 글이나 문서를 만들어 내는 쪽, 외부 시스템에서 근거를 읽어 오는 쪽, 밖으로 무언가를 내보내는 쪽이죠.

절차와 문체, 검증 규칙이 핵심인 모듈부터 볼게요. 블로그 초안을 쓰고 노션에 올리는 agent/blog, AI 티 나는 한글을 사람 문체로 고치는 humanize, 저장소 문서와 코드가 어긋났는지 훑는 docs-audit은 skill-only에 가까워요. 이런 모듈은 서버보다 SKILL.md, references, templates의 품질을 먼저 챙겨야 해요.

PR diff를 읽고 리뷰를 쓰는 agent/code-reviewer, 오늘 할 일을 계획하는 agent/pm, 업무 회고를 만드는 agent/work-reviewer, PR과 issue를 가져오는 github는 read-only MCP tool 후보로 볼 수 있어요. PR, issue, plan, worklog의 근거를 읽어 구조화된 결과로 돌려줄 수 있기 때문이에요. list_assigned_work_items에는 “Use this when the user wants to review assigned issues and pull requests before planning today’s work.”, 그러니까 “오늘 할 일을 계획하기 전에 배정된 이슈와 PR을 훑고 싶을 때 쓰라”는 설명을 붙일 수 있어요.

지원 현황을 추가하고 조회하고 갱신하는 agent/job-application은 non-destructive write와 UI가 함께 맞닿아 있어요. 지원 상태 갱신은 사용자 기록을 바꾸므로 서버가 상태 전이를 검증해야 하고, 목록 비교나 편집에는 UI가 도움이 될 수 있어요. 알림을 보내는 notification, Slack으로 메시지를 주고받는 slack, 출퇴근과 주간 플레이북을 cron으로 돌리는 autopilot처럼 외부 전송이나 발행으로 이어질 수 있는 모듈은 open-world action이에요. 이런 모듈에는 확인 prompt와 audit log부터 갖춰야 하죠.

| 모듈                                  | 우선 형태              | 이유                              |
| ------------------------------------- | ---------------------- | --------------------------------- |
| agent/blog, humanize, docs-audit      | skill-only             | 절차와 산출물 규칙이 핵심         |
| agent/code-reviewer, agent/pm, github | read-only MCP tool     | 외부 데이터를 읽어 구조화 가능    |
| agent/job-application                 | write tool + 선택적 UI | 상태 변경과 목록 검토가 함께 필요 |
| notification, slack, autopilot        | open-world action      | 외부 전송 위험이 있어 확인 필요   |

이 표가 보여주는 건 하나뿐이에요. 앞에서 읽은 기준을 실제 모듈 이름에 대 보면 어디서 갈리는지가 드러난다는 것. 옮긴 뒤의 결과는 아직 아무것도 보여주지 않고, 모듈 경계가 이 시스템과 다르게 잡힌 곳이라면 표를 그대로 옮길 수 없어요. 이름이 같아도 밖으로 내보내는 경로가 하나 붙어 있으면 갈래가 바뀌거든요.

## 옮기는 순서도 도구 경계에서 시작한다

옮기는 순서 역시 화면이 아니라 도구 경계에서 출발해요. 제가 잡아 둔 순서는 이래요. 먼저 read-only 조회 하나, non-destructive write 하나, open-world action 하나를 골라 세 갈래를 각각 한 번씩 지나게 해요. 그다음 metadata 초안을 쓰고 direct, indirect, negative prompt를 만들어 어떤 도구가 선택되고 어떤 arguments가 넘어갔는지 기록해요. 그러고 나서 UI 없는 MCP server부터 세우고, stable name/version, schema, structuredContent, authorization, audit log를 고정한 뒤에야 UI를 붙일지 판단해요.

리드에서 든 세 명령도 이 선을 그으면 자리가 정해져요. /today, /review-pr, /worklog는 각각 plan, PR, worklog의 근거를 읽어 구조화된 결과로 돌려주는 일이라, 절차 지침만으로 끝나는 skill-only가 아니라 셋 다 read-only MCP tool 후보 쪽으로 갔어요.

여기까지가 계획이고, 실제로 굴려 본 건 아직 없어요. 이관도 측정도 하지 않았으니 이 글에는 성능 수치도 성공 사례도 없어요. 대신 무엇을 통과로 볼지는 미리 적어 둘게요.

측정 범위는 방금 고른 도구 세 개예요. 검증 환경은 ChatGPT의 Developer mode에 그 세 도구를 담은 MCP server를 등록한 상태고, 입력은 direct, indirect, negative로 라벨을 붙인 golden prompt set이에요. 1차 통과 조건은 하나로 잡아요. negative prompt에서 오호출이 한 번도 나오지 않을 것. 가이드가 marginal recall보다 negative prompt의 precision을 먼저 보라고 한 순서를 그대로 따른 거예요. 그다음 direct prompt에서 의도한 도구가 선택되는지, indirect prompt에서 arguments가 맞게 채워지는지를 차례로 봐요.

분류가 틀렸다고 판단할 신호도 미리 정해 둬요. skill-only로 둔 모듈에서 서버 검증이나 인증이 필요한 요청이 반복해 나오면 MCP server tool로 옮기라는 신호고, 반대로 read-only tool로 만든 도구가 golden prompt 어디에서도 선택되지 않으면 애초에 도구로 나눌 일이 아니었다는 신호예요. open-world action으로 분류한 도구에서 확인 prompt 없이 외부 전송이 나간다면 그건 분류가 아니라 구현을 되돌릴 신호고요.

경계 조건은 아직 계약만 있고 확인한 건 없어요. 같은 도구를 연속으로 호출했을 때 중복 write가 생기는지, 중간에 실패했을 때 audit log에 무엇이 남는지, 권한이 없을 때 서버가 거절하는지 세 가지를 각각 한 케이스씩 넣어 볼 생각이고, 셋 다 미확인 상태예요. 통과 기준은 “거절하거나 같은 결과를 돌려주고, 무슨 일이 있었는지 로그에 남는다”로 잡아요.

Plugins의 핵심은 화면이 아니에요. 모델이 안전하게 호출할 수 있는 작업 경계를 배포하는 데 있거든요.

## 참고 자료

이 글의 기준은 전부 아래 여섯 개 문서에서 뽑았어요. 여섯 개 모두 글을 올린 뒤 출처를 다시 짚으며 2026-09-08에 직접 열어 제목과 인용 문장을 확인했어요.

- [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins) — plugin과 skill의 정의, skill only / MCP server only / 둘 다 / MCP server with UI 선택 표, “Custom UI is not required for an MCP server”. 첫 절의 세 형태 표와 UI가 선택 사항이라는 주장을 받쳐요.
- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server) — use-case inventory, distinct action마다 도구 하나, list_projects 예시, content / structuredContent / `_meta`의 역할, 모든 입력을 신뢰하지 말고 서버에서 authorize하라는 지침. 도구 분할과 첫 코드블록의 근거예요.
- [Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui) — MCP Apps standard 우선, `_meta.ui.resourceUri`, JSON-RPC over postMessage, window.openai를 feature detection으로 얹으라는 권고, component 없이도 도구가 동작해야 한다는 원칙. UI 절 전체를 받쳐요.
- [MCP server and UI quickstart](https://developers.openai.com/plugins/build/app-quickstart) — todo 예시와 `registerAppTool`, `npm install @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod`, 패키지 버전 `^1.20.2` / `^1.0.1` / `^3.25.76`. 두 번째 코드블록과 최소 재현 조건의 출처예요.
- [Optimize Metadata](https://developers.openai.com/plugins/guides/optimize-metadata) — 이름에 domain과 action을 함께 쓰라는 규칙, “Use this when…” 설명, hint 세 가지, direct·indirect·negative로 나눈 golden prompt set, Developer mode 등록 경로, negative prompt의 precision을 marginal recall보다 먼저 보라는 순서. metadata 절과 마지막 절의 통과 기준을 받쳐요.
- [Security & Privacy](https://developers.openai.com/plugins/guides/security-privacy) — least privilege, explicit user consent, defense in depth, 모델이 만든 입력의 서버 검증, 되돌릴 수 없는 작업의 사람 확인, PII를 지운 audit log, component props에 secret을 넣지 말라는 지침. 보안 두 문단의 근거예요. iframe이 strict CSP 아래에서 `window.alert`, `window.prompt`, `window.confirm`, `navigator.clipboard` 같은 특권 브라우저 API를 쓰지 못한다는 문장은 같은 문서의 [`/apps-sdk` 경로 판](https://developers.openai.com/apps-sdk/guides/security-privacy)에서 확인했고, 첫 절 표의 “포기하는 것”에 쓰였어요.
