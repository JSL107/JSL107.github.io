---
title: "MCP 서버에 토큰을 묶어야 하는 이유"
description: "Remote MCP Authorization의 토큰 경계와 도구별 권한 정책을 이대리의 외부 도구 호출 흐름에 대입해 살펴본다."
pubDatetime: 2026-11-11T19:47:00+09:00
category: backend
---

Slack에서 “이 PR 리뷰해줘”라고 하면 에이전트가 GitHub의 diff를 가져와 리뷰 초안을 만들어요. 사내 문서와 일정, 배포, 고객 데이터까지 연결한다면 각 도구 서버를 어떤 토큰으로 호출해야 할까요? 이 글은 Remote MCP Authorization 문서와 TypeScript SDK README, Descope·Permit.io의 해설을 바탕으로 HTTP 기반 MCP 서버의 권한 경계를 정리한 글이에요. 실제 서버를 연결해 검증한 운영기는 아니에요.

## 에이전트에게 도구를 붙이면 토큰은 금방 떠돌기 시작한다

에이전트 시스템의 권한 문제는 처음엔 별로 커 보이지 않아요. 슬래시 명령 하나로 특정 API 하나만 읽을 때는 서버에 토큰을 넣어두고 에이전트가 필요할 때 꺼내 쓰면 충분해 보이죠. 그런데 외부 도구가 늘고 사용자마다 권한이 달라지는 데다, “읽기”가 “쓰기”, “보내기”, “배포”로 넓어지면 이야기가 달라져요.

이때 흔히 택하는 지름길이 토큰 재사용이에요. 사용자가 GitHub에 동의했다는 이유로 GitHub access token을 MCP 서버에 그대로 보내거나, MCP 클라이언트가 받은 토큰을 MCP 서버가 upstream API에 다시 넘기는 방식이죠. 편하긴 하지만 그 토큰이 GitHub용인지, MCP 서버용인지, 특정 도구 서버 하나만을 위한 것인지 구분하기 어려워져요.

Remote MCP Authorization은 바로 이 문제를 다뤄요. “사용자가 로그인했는가”에 그치지 않고 “이 클라이언트가 이 사용자 대신 이 MCP 서버라는 resource에 접근할 수 있는가”를 묻는 거예요. 로그인은 인증 서버가 처리하고 MCP 서버는 토큰이 자신에게 발급됐는지 검증하는 resource server가 돼요.

## MCP 서버는 보호 리소스가 된다

2025-06-18 MCP Authorization 문서에서 눈여겨볼 변화는 역할을 나눴다는 점이에요. HTTP 기반 MCP 서버는 OAuth 2.1 resource server로 동작하고 authorization server는 사용자 로그인과 동의, 토큰 발급을 맡아요. MCP client는 사용자 대신 MCP 서버에 접근하는 OAuth client가 돼요.

단순히 이름만 달라진 게 아니에요. MCP 서버가 직접 “로그인 서버” 역할까지 맡으면 서버마다 인증 흐름이 달라져요. MCP 서버를 protected resource로 두면 맡을 일이 분명해져요. issuer, audience 또는 resource binding, scope, expiry, revocation 가능 여부를 검증하고 자신을 위해 발급되지 않은 토큰은 거절하는 거예요.

클라이언트가 인증 서버를 추측할 필요는 없어요. MCP 서버가 `/.well-known/oauth-protected-resource`에 자신이 신뢰하는 authorization server 목록을 공개하거든요. Permit.io 글에는 이런 예시가 나와요.

```json
{
  "resource": "https://mcp.example.com",
  "authorization_servers": [
    "https://auth.example.com"
  ],
  "scopes_supported": [
    "mcp.tools.read",
    "mcp.tools.write",
    "mcp.tools.admin"
  ],
  "bearer_methods_supported": ["header"],
  "resource_name": "Example MCP Server"
}
```

이 예시를 제 시스템에 대입해 보면, PR 리뷰나 일정 등록 기능을 MCP 서버로 외부에 공개할 때 각 도구 서버의 canonical URI가 resource가 돼요. Slack 사용자나 워크스페이스 ID는 토큰이 누구의 것인지 추적하는 내부 식별자예요. resource에 Slack workspace를 넣으면 방향이 틀어져요. 토큰은 Slack이 아니라 MCP 서버를 대상으로 해야 하니까요.

## 인증 흐름은 서버 발견에서 시작한다

Remote MCP Authorization의 흐름은 MCP endpoint 호출부터 시작해요. 인증 정보가 없으면 서버는 `401 Unauthorized`와 함께 resource metadata의 위치를 알려줘요. 클라이언트는 그 문서를 읽고, 거기에 적힌 authorization server의 metadata를 다시 읽어요. 그래야 authorization endpoint와 token endpoint, dynamic registration 지원 여부를 알 수 있어요.

여기서 중요한 게 `resource` 파라미터예요. MCP client는 authorization request와 token request에 모두 `resource`를 넣어야 해요. 값은 토큰을 사용할 MCP 서버의 canonical URI이고 authorization server가 이 파라미터를 지원하지 않더라도 client는 보내야 해요. 서버 A용 토큰을 서버 B가 받아들이지 못하게 하는 경계예요.

Permit.io 글에는 authorization request가 다음과 같이 나와요.

```plain text
GET /oauth/authorize?
  response_type=code&
  client_id=mcp-client-123&
  redirect_uri=http%3A%2F%2F127.0.0.1%3A39123%2Foauth%2Fcallback&
  scope=mcp.tools.read%20mcp.tools.write&
  state=af0ifjsldkj&
  code_challenge=Z9E...&
  code_challenge_method=S256&
  resource=https%3A%2F%2Fmcp.example.com
```

토큰을 교환할 때도 같은 `resource`를 넣어요.

```plain text
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=SplxlOBeZQQYbYS6WxSbIA&
redirect_uri=http%3A%2F%2F127.0.0.1%3A39123%2Foauth%2Fcallback&
client_id=mcp-client-123&
code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk&
resource=https%3A%2F%2Fmcp.example.com
```

제 시스템에서 이 두 요청이 들어갈 자리는 Slack 명령을 받는 입구가 아니라, 실제 외부 도구 서버를 호출하기 직전의 client transport 계층이에요. 사용자의 Slack ID와 workspace ID는 “누가 요청했는가”를 남기는 감사 키이고, `AgentRun` 같은 실행 단위는 “이 호출이 어떤 작업의 일부였는가”를 남기는 상관관계 키예요. OAuth의 `resource`는 “어느 MCP 서버용 토큰인가”를 나타내고요. 셋을 섞으면 감사 기록도 권한 경계도 흐려져요.

## OAuth는 도구 실행 권한의 끝이 아니다

resource-bound OAuth를 붙여도 지금 `delete`, `send`, `deploy`, `create_issue` 같은 개별 도구 호출을 허용할지는 따로 정책으로 정해야 해요. OAuth는 MCP 서버에 들어오는 세션이 올바른 사용자 위임을 받았는지 검증해요.

예를 들어 `mcp.tools.write` scope가 있어도 모든 쓰기 도구를 똑같이 취급할 수는 없어요. 메시지를 보내는 도구와 운영 리소스를 삭제하는 도구는 실패했을 때 치러야 할 비용이 다르니까요. 그래서 MCP 서버 내부에는 RBAC 또는 ABAC가 필요해요. RBAC는 역할을 기준으로 권한을 정하고 ABAC는 사용자·리소스·요청 맥락 같은 속성을 함께 살펴요. OAuth token validation이 문 앞에서 신원을 확인한다면 tool-level policy는 안에 들어와서 어떤 행동을 할 수 있는지 정하는 규칙이에요.

사용자가 “정리해줘”라고 했을 때 에이전트가 어떤 도구를 고를지에는 모델의 판단이 들어가요. 프롬프트에 “위험한 작업은 하지 마”라고 적는 것만으로는 부족해요. authorization layer는 모델 바깥에 두고, 실패했을 때는 `401`과 `403`을 구분해야 해요. 토큰이 없거나 유효하지 않으면 `401`, 토큰은 유효하지만 scope나 정책이 부족하면 `403`이에요.

| 선택지 | 얻는 것 | 잃는 것 |
| --- | --- | --- |
| 서버 고정 토큰 | 구현이 빠르고 초기 연결이 쉽다 | 사용자별 감사와 권한 분리가 어렵다 |
| upstream 토큰 전달 | 기존 OAuth 동의를 재사용한다 | 토큰 audience가 흐려지고 confused deputy 위험이 커진다 |
| resource-bound OAuth | MCP 서버별 토큰 경계와 표준 discovery를 얻는다 | authorization server, metadata, token validation 구현 부담이 생긴다 |
| tool-level policy 추가 | 위험한 도구를 세밀하게 통제한다 | 정책 모델과 감사 로그 설계가 필요하다 |

## 적용 범위와 이대리의 연결 지점

TypeScript 쪽은 공식 MCP TypeScript SDK가 v2 안정 라인으로 전환됐고 README에 따르면 2026-07-28 MCP spec을 구현해요. 서버와 클라이언트 패키지가 나뉘어 있고 Node.js HTTP, Express, Fastify, Hono용 middleware도 별도 패키지로 제공돼요. NestJS 개발자에게도 참고할 만한 구조예요. MCP 기능 자체와 웹 프레임워크 adapter를 섞지 말라는 뜻에 가까워요.

공식 authorization 문서가 다루는 범위는 HTTP 기반 transport예요. stdio transport는 이 OAuth flow를 따르지 않고 환경에서 credential을 가져오는 방식에 가까워요. 로컬에서만 쓰는 개인 도구나 단일 사용자 개발 보조 도구, 서버 간 사전 신뢰가 분명한 내부 batch에는 이 모델이 과할 수 있어요.

여러 MCP client가 붙고 사용자별 권한이 다르거나 외부 조직과 사내 여러 팀의 도구 서버를 연결해야 한다면 먼저 토큰이 어느 resource에 묶였는지 살펴야 해요. SDK와 middleware는 이 흐름을 구현하는 재료일 뿐, issuer/audience/scope 검증과 tool policy를 대신 설계해주지는 않아요.

제가 운영하는 이대리는 Slack 기반 LLM 멀티 에이전트 시스템이에요. 이 주제와 직접 맞닿는 곳은 Slack 메시지를 받는 입구, 자연어 요청을 작업으로 보내는 라우터, 에이전트 실행 기록, 외부 이벤트를 받는 webhook이에요. PR 리뷰를 만들거나 그날 할 일을 정리하고 업무 로그를 만드는 기능도 외부 도구를 읽거나 쓸 수 있어서 간접적으로 관련돼요.

도입할 자리는 실행 단위와 외부 도구 호출 사이예요. Slack `userId`와 `workspaceId`는 “누가 어느 공간에서 요청했나”를 설명하는 감사 속성이고 resource는 `https://github-mcp.example.com`처럼 토큰이 향하는 MCP 서버예요. `AgentRun` 같은 실행 기록에는 `userId`, `workspaceId`, selected tool, resource URI, granted scopes, authorization result를 함께 남기는 게 자연스러워요.

내부 메모리 정리나 로컬 세션 분석, 정해진 시간에 도는 개인 cron처럼 외부 HTTP MCP 서버를 거치지 않는 기능은 Remote MCP Authorization의 직접 대상이 아니에요. 적용하려면 먼저 그 기능이 원격 MCP 서버로 노출되는지, 아니면 원격 MCP 서버를 client로 호출하는지 확인해야 해요.

## 다음 확인은 discovery와 audit schema다

먼저 MCP authorization 문서의 discovery 흐름을 실제 client 입장에서 따라가야 해요. `401`의 `WWW-Authenticate`에서 resource metadata URL을 찾고, `authorization_servers`를 읽은 다음 RFC 8414 metadata를 통해 token endpoint까지 도달하는 흐름이에요. 이 과정에서 client가 authorization server를 하드코딩하지 않는지도 확인해야 해요.

실행 기록에 남길 audit schema도 정해야 해요. “Slack 사용자와 워크스페이스가 만든 실행 단위에서, 어떤 MCP resource를 대상으로, 어떤 scope의 토큰 검증을 통과했고 어떤 tool policy 결과로 호출됐는가”를 기록하는 형태예요. Slack 입구에서 신원과 요청 맥락을 만들고, 라우터에서 의도를 고르고, 외부 도구 호출 계층에서 resource-bound token을 요구해요. 실행 기록에는 그 결과를 나중에 감사할 수 있도록 남겨요.

### 참고 자료

- https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- https://github.com/modelcontextprotocol/typescript-sdk
- https://www.descope.com/blog/post/mcp-auth-spec
- https://www.permit.io/blog/oauth-on-mcp
