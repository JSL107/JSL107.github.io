---
title: "Write Action을 여는 에이전트의 권한 체인 설계"
description: "에이전트가 외부 시스템을 변경할 때 user → agent → tool 호출 체인의 권한과 감사 맥락을 보존하는 방법을 정리한다."
pubDatetime: 2026-08-24T19:08:00+09:00
category: backend
---

Slack 기반 에이전트가 read-only 도구를 넘어 외부 시스템까지 바꾸기 시작하면 봇 토큰만으로는 부족해요. user → agent → tool로 이어지는 권한 체인을 설계해야 하죠.

에이전트는 독립된 실행 주체로 식별해요. 각 행위에 필요한 위임 범위와 감사 맥락도 끝까지 보존해야 합니다.

## Write action이 만드는 새로운 문제

/today가 오늘 할 일을 정리하고, /review-pr이 PR diff를 읽고, /worklog가 업무 로그 초안을 만드는 단계는 대부분 read-only 흐름이에요. 실패해도 잘못된 답변 하나가 남을 뿐, 외부 시스템의 상태가 직접 바뀌지는 않아요.

하지만 에이전트가 GitHub issue에 라벨을 붙이고 PR에 코멘트를 남기기 시작하면 상황이 달라져요. Prisma schema 변경 제안을 바탕으로 migration 성격의 작업을 만들거나 crawler job을 등록하고, 백엔드 워커에게 구현을 위임할 때도 마찬가지예요. 외부 상태를 바꾸니까요.

사고가 나면 토큰 문자열이 아니라 호출 체인을 확인해야 해요. 최초 사용자는 누구였는지, 어떤 Slack interaction이 시작점이었는지 살펴야 하죠. 어느 에이전트가 중간에서 판단했는지도 알아야 해요.

어떤 권한이 축소되어 전달됐는지 확인해야 해요. 어떤 도구 호출이 왜 거절됐는지도 남아 있어야 합니다.

멀티 에이전트 시스템에서 에이전트를 단순한 LLM 호출 함수로 두면 경계가 흐려져요. 독립 식별자와 권한, 승인 이력, 감사 책임을 지닌 workload로 다루면 write action을 열 때 최소 권한과 추적 가능성을 함께 확보할 수 있어요.

## Bot token과 shared key로는 체인이 남지 않는다

기존 시스템은 Slack bot token이나 GitHub app token 같은 서비스 단위 credential을 써요. 모든 작업을 이 credential로 처리하죠.

사용자가 승인한 OAuth token을 worker queue나 DB에 저장했다가 나중에 쓰기도 해요. 내부 API를 shared secret이나 service account로 묶고, 백엔드에서 온 요청이면 그대로 신뢰하기도 합니다.

호출 체인이 짧을 때는 편해요. 하지만 Slack command가 backend agent를 부르고 agent가 model-router를 거쳐 LLM과 github 모듈, Prisma adapter, crawler worker를 호출하면 중요한 정보가 사라져요.

단순 bearer token만 전달하면 downstream 서비스는 요청의 성격을 판단하기 어려워요. 이 요청이 agent/code-reviewer가 사용자 A의 PR 리뷰 요청 범위 안에서 만든 GitHub comment인지 알기 어렵거든요. 로그에 bot 또는 backend만 남으면 나중에 권한을 줄이거나 거절 사유를 설명하기도 힘들어요.

IETF의 AI Agent Authentication and Authorization draft는 AI agent를 LLM과 도구, 서비스, 리소스를 반복 호출하는 workload로 봐요. 여기에 WIMSE, OAuth 2.0 계열, OpenID Shared Signals Framework 같은 기존 표준을 적용하는 방향을 설명해요. 에이전트에는 안정적인 identifier와 credential을 주고, 사용자를 대신할 때는 delegation context도 보존해야 합니다.

권한 모델은 “사용자가 승인했으니 worker가 아무 때나 쓴다”에서 벗어나야 해요. “이 agent identity가 사용자 또는 시스템으로부터 받은 특정 위임 범위 안에서 이번 행위를 수행한다”로 바뀌어야 하잖아요.

## 에이전트를 IAM의 대상으로 다루기

AI agent auth draft는 Agent Identity Management System, 곧 AIMS라는 개념 모델을 둬요. AIMS는 제품 이름이 아니에요. agent identifier, agent credential, attestation, credential provisioning, authentication, authorization, observability and remediation, policy, compliance를 아우르며 에이전트 workload의 identity와 permission을 관리하는 기능 묶음이에요.

내부 시스템 언어로 풀면 agent-registry는 agent identifier와 display metadata를 맡아요. agent-run에는 특정 실행의 actor, trigger, approval, evidence, tool call audit을 묶어요. 실행 단위로 기록하는 셈이죠.

model-router는 어떤 agent type이 어떤 provider를 호출했는지 남겨요. github, slack, crawler는 resource server 또는 tool adapter 역할을 해요. AIMS가 별도 서버를 당장 도입하라는 뜻은 아니에요. 도메인 모델에 “에이전트도 인증·인가 대상”이라는 축을 추가하라는 요구에 가까워요.

Microsoft Entra Agent ID는 agent identity를 일반 사용자나 app registration과 구분해요. agent identity는 특별한 service principal이에요. 자체 credential은 없고, agent identity blueprint가 대신 token을 얻어요.

accountable human 또는 group을 뜻하는 sponsor도 둬요. 권한 면에서는 Global Administrator, Privileged Role Administrator, User Administrator 같은 고위험 directory role을 차단하고 custom role이나 role-assignable group membership도 제한합니다.

에이전트에는 별도의 수명주기가 필요해요. sponsor, 권한 제한, 조건부 접근, 감사도 갖춰야 해요. 이런 원칙은 벤더 기능을 그대로 사용하지 않더라도 가져올 수 있습니다.

## Delegation chaining은 맥락을 다시 표현한다

OAuth Identity and Authorization Chaining draft는 여러 trust domain을 지나는 요청에서 identity와 authorization 정보를 보존하는 메커니즘을 다뤄요. 요청이 domain A의 authorization server에서 시작해 domain B의 protected resource에 도달한다면, domain B도 원래 사용자가 누구였고 어떤 authorization이 부여됐는지 알아야 해요. 어떤 중간 resource server를 거쳤는지도 확인할 수 있어야 하죠.

draft의 기본 흐름은 OAuth 2.0 Token Exchange(RFC 8693)와 JWT bearer assertion grant(RFC 7523)를 조합해요. domain A에서 받은 토큰을 domain A의 authorization server에 교환해요. 그 결과 domain B authorization server를 대상으로 하는 JWT authorization grant를 받아 domain B에 제시하고 access token을 얻어요.

access token 하나를 계속 릴레이하지 않아요. trust boundary를 넘을 때마다 검증 가능한 grant로 맥락을 다시 표현하는 방식입니다.

문서의 token exchange 요청 예시는 다음과 같아요.

```plain text
POST /auth/token HTTP/1.1
Host: as.a.org
Content-Type: application/x-www-form-urlencoded

grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange
&resource=https%3A%2F%2Fas.b.org%2Fauth
&subject_token=ey...
&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token
```

domain A가 JWT authorization grant를 발급했다는 응답은 이런 형태예요.

```plain text
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-cache, no-store

{
  "access_token": "***",
  "token_type":"N_A",
  "issued_token_type":"urn:ietf:params:oauth:token-type:jwt",
  "expires_in":60
}
```

resource는 대상 authorization server를 뜻해요. subject_token은 근거가 된 token이고, issued_token_type은 결과물의 유형이에요. expires_in은 수명을 명시해요.

Slack → backend → GitHub 체인에 그대로 복사할 API는 아니에요. 다만 중간 호출마다 맥락을 새로 포장하고 검증한다는 설계 방향은 적용할 수 있죠.

## Transaction token으로 한 번의 행위를 묶기

Transaction Tokens draft는 한 trust domain 안에서 call chain 전체에 user identity, workload identity, authorization context, request context를 전파하는 짧은 수명의 signed JWT를 설명해요. 특정 transaction에 묶인 JWT예요.

Txn-Token은 OAuth access token이나 authentication credential이 아니에요. trust domain 내부의 downstream workload가 후속 호출을 authorize하는 데 사용해요. draft에 따르면 각 trust domain에는 정확히 하나의 logical Transaction Token Service가 있어야 합니다.

이 개념을 적용하면 worker queue의 payload에 장기 refresh token을 넣지 않아도 돼요. 대신 “이번 PR 리뷰 요청”, “이번 crawler job”, “이번 schema 변경 제안”에 필요한 맥락만 짧게 묶을 수 있어요. 문서의 Txn-Token payload 예시는 다음과 같습니다.

```json
{
  "iat": 1686536226,
  "aud": "trust-domain.example",
  "exp": 1686536586,
  "txn": "97053963-771d-49cc-a4e3-20aad399c312",
  "sub": "d084sdrt234fsaw34tr23t",
  "req_wl": "apigateway.trust-domain.example",
  "rctx": {
    "req_ip": "69.151.72.123",
    "authn": "face"
  },
  "scope" : "trade.stocks",
  "tctx": {
    "action": "BUY",
    "ticker": "MSFT",
    "quantity": "100",
    "customer_type": {
      "geo": "US",
      "level": "VIP"
    }
  }
}
```

aud는 trust domain이에요. txn은 transaction identifier, sub는 subject, req_wl은 Txn-Token을 요청한 workload를 뜻해요. rctx는 request context, scope는 authorization scope, tctx는 transaction context예요.

agent 시스템에서는 txn을 AgentRun.id 또는 별도 approval transaction id로 둘 수 있어요. req_wl은 slack gateway나 agent/cto dispatcher가 될 수 있죠. scope는 github.pr.comment, github.issue.label, crawler.job.create처럼 좁게 정의할 수 있어요.

문서의 token endpoint 요청도 같은 방향을 보여줘요.

```plain text
POST /txn-token-service/token_endpoint HTTP/1.1
Host: txn-token-service.trust-domain.example
Content-Type: application/x-www-form-urlencoded

grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange
&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Atxn_token
&audience=trust-domain.example
&scope=trade.stocks
&subject_token=eyJhbG...tpZC...kdXjwhw
&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token
&request_context=...
&request_details=...
```

핵심은 이번 요청의 context를 token 발급 시점에 함께 넣는 거예요. LLM이 중간에 도구를 선택한다면 모델의 판단만 기록해서는 부족해요. 그 판단이 어떤 승인과 범위 안에서 실행됐는지 token 또는 audit record에 남겨야 하거든요.

## 내부 모델은 표준보다 먼저 준비할 수 있다

OAuth 2.0 Token Exchange인 RFC 8693은 이미 RFC예요. AI agent auth draft, identity chaining draft, transaction token draft는 아직 Internet-Draft 단계예요.

Transaction Tokens는 OAuth WG 문서로 진행 중이라 draft가 바뀔 수 있어요. 특정 구현체에 내부 모델을 강하게 결합하면 이후 변화에 끌려갈 수 있죠. 지금은 특정 라이브러리를 고르기보다 내부 도메인 모델을 이 문제의식에 맞춰야 합니다.

read-only 명령만 있고 호출 체인이 짧으며 외부 write action과 장기 worker가 없다면 agent identity 체계를 과하게 만들 필요는 없어요. 개인용 로컬 스크립트나 단일 프로세스 자동화에 AIMS 전체를 흉내 내면 운영 비용만 늘어요.

OAuth trust domain을 제대로 나누지 않은 채 identity chaining이라는 이름만 붙일 수도 있어요. 그러면 기존 bearer token relay에 로그 필드 몇 개를 더한 수준에 그칠 수 있습니다.

write action, 장기 worker, 다중 에이전트 위임, 외부 SaaS 호출, 사용자별 승인 범위가 함께 등장하면 미리 모델을 잡아야 해요. 처음부터 완성형 token service를 만들 필요는 없죠.

AgentRun에 actor와 delegation field를 남기는 것부터 시작할 수 있어요. tool call audit을 분리하고 scope vocabulary를 좁게 정의하는 일도 먼저 할 수 있습니다.

## AgentRun을 권한 체인의 진실 원장으로 만들기

Slack 기반 LLM 멀티 에이전트 시스템에서 먼저 바뀌어야 할 모듈은 agent-registry, agent-run, be-chain, slack, github예요.

agent-registry는 agent/code-reviewer, agent/cto, agent/be, agent/be-schema, agent/issue-labeler, agent/be-fix를 같은 봇으로 취급하면 안 돼요. 서로 다른 권한 경계로 관리해야 해요. PR에 코멘트를 남기는 agent와 schema 변경 제안을 만드는 agent를 같은 credential로 묶어서도 안 됩니다.

agent-run은 실행 단위의 진실 원장이 되어야 해요. begin → run → finish 라이프사이클과 evidence record에 더해 actorUserId, agentIdentity, delegatedScopes, approvalId, toolCallAuditId가 필요해요.

actorUserId는 Slack command 또는 natural language mention을 시작한 사람이에요. agentIdentity는 판단과 도구 호출을 수행한 agent workload예요. delegatedScopes에는 이번 실행에서 허용된 범위를 담아요.

approvalId는 사람이 승인한 write action의 근거예요. toolCallAuditId는 GitHub, Prisma, crawler, CLI provider 호출의 세부 기록으로 연결됩니다.

be-chain과 agent/cto에서는 CTO agent가 PM 작업을 BE worker로 분배해요. agent/be는 구현 계획을 만들고, agent/be-diff-generator나 agent/be-test는 후속 산출물을 만들어요.

최초 Slack 사용자와 마지막 worker 사이의 중간 actor를 단일 run log로 뭉개면 누가 무엇을 위임했는지 사라져요. 그래서 parent-child AgentRun 관계와 delegated scope가 필요합니다.

slack과 github는 trust boundary에 가까워요. Slack은 사용자 intent와 interaction context가 들어오는 입구예요. GitHub는 실제 write action이 일어나는 외부 resource server예요.

agent/code-reviewer, agent/issue-labeler, pr-review-loop, webhook에서는 자동 트리거와 사용자 트리거가 섞일 수 있어요. webhook 자동 트리거는 actorUserId가 없거나 system actor일 수 있어요. Slack command에는 명시적인 사용자 actor가 있어요.

이 차이는 모델에 남겨야 해요. 그래야 GitHub write 권한도 서로 다르게 줄 수 있습니다.

scope vocabulary는 좁게 잡아야 해요. write:github처럼 넓은 범위로 두면 안 돼요. github.pr.comment, github.issue.label, crawler.job.create, prisma.schema.propose처럼 실제 tool adapter가 검사할 수 있는 단위로 나눠야 user → agent → tool의 각 호출에 이번 실행에 필요한 권한만 전달할 수 있어요.

에이전트 권한 체인의 출발점은 복잡한 token service가 아니에요. 사용자를 시작점으로, 에이전트를 독립된 actor로, 도구 호출을 검증 가능한 행위로 구분해 기록하는 일이 먼저예요. 그래야 write action을 최소 권한으로 열고, 위임과 거절의 이유도 나중에 설명할 수 있습니다.
