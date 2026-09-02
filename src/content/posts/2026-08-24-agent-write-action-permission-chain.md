---
title: "Write Action을 여는 에이전트의 권한 체인 설계"
description: "에이전트가 외부 시스템을 변경할 때 user → agent → tool 호출 체인의 권한과 감사 맥락을 보존하는 방법을 정리한다."
pubDatetime: 2026-08-24T19:08:00+09:00
category: backend
---
Slack 기반 에이전트가 read-only 도구를 넘어 외부 시스템까지 바꾸기 시작하면 봇 토큰만으로는 부족해요. user → agent → tool로 이어지는 권한 체인을 설계해야 하죠. 에이전트를 독립된 실행 주체로 식별하고, 각 행위에 필요한 위임 범위와 감사 맥락도 끝까지 보존해야 합니다.

## Write action이 만드는 새로운 문제

/today는 오늘 할 일을 정리하고 /review-pr은 PR diff를 읽으며 /worklog는 업무 로그 초안을 만드는데, 이 단계들은 대부분 read-only 흐름이에요. 실패해도 잘못된 답변 하나가 남을 뿐, 외부 시스템의 상태가 직접 바뀌지는 않아요.

에이전트가 GitHub issue에 라벨을 붙이고 PR에 코멘트를 남기면 상황이 달라져요. Prisma schema 변경 제안을 바탕으로 migration 성격의 작업을 만들 때나, crawler job을 등록하고 백엔드 워커에게 구현을 위임하는 경우도 마찬가지고요. 모두 외부 상태를 바꾸는 일이니까요.

사고가 나면 토큰 문자열이 아니라 호출 체인을 확인해야 해요. 최초 사용자가 누구였고 어떤 Slack interaction에서 시작됐는지, 중간에서 어느 에이전트가 판단했고 어떤 권한이 축소되어 전달됐는지를 살펴야 해요. 어떤 도구 호출이 왜 거절됐는지도 기록에 남아 있어야 하고요.

멀티 에이전트 시스템에서 에이전트를 단순한 LLM 호출 함수로 두면 경계가 흐려져요. 독립 식별자와 권한, 승인 이력, 감사 책임을 지닌 workload로 다뤄야 해요. 그래야 write action을 열 때 최소 권한과 추적 가능성을 함께 확보할 수 있어요.

## Bot token과 shared key로는 체인이 남지 않는다

기존 시스템은 Slack bot token이나 GitHub app token 같은 서비스 단위 credential로 모든 작업을 처리해요. 사용자가 승인한 OAuth token을 worker queue나 DB에 저장해 두었다가 나중에 쓰기도 해요. 내부 API를 shared secret이나 service account로 묶어, 백엔드에서 온 요청이라는 이유만으로 그대로 신뢰하기도 해요.

호출 체인이 짧을 때는 편해요. 하지만 Slack command가 backend agent를 부르고, agent가 model-router를 거치면 얘기가 달라져요. 여기서 LLM과 github 모듈, Prisma adapter, crawler worker까지 호출하면 중요한 정보가 사라지거든요.

단순 bearer token만 넘기면 downstream 서비스는 요청의 성격을 판단하기 어려워요. agent/code-reviewer가 사용자 A의 PR 리뷰 요청 범위에서 만든 GitHub comment인지 알 수 없거든요. 로그에 bot 또는 backend만 남으면 나중에 권한을 줄이기도, 거절 사유를 설명하기도 힘들어져요.

IETF의 AI Agent Authentication and Authorization draft는 AI agent를 LLM과 도구, 서비스, 리소스를 반복해서 호출하는 workload로 봐요. 여기에 WIMSE와 OAuth 2.0 계열, OpenID Shared Signals Framework를 적용하는 방향이에요. 에이전트에는 안정적인 identifier와 credential을 주고, 사용자를 대신할 때는 delegation context도 보존해야 한다는 거죠.

권한 모델은 “사용자가 승인했으니 worker가 아무 때나 쓴다”에서 “이 agent identity가 받은 특정 위임 범위에서 이번 행위를 수행한다”로 바뀌어야 해요. 그 위임은 사용자 또는 시스템에서 받은 것이어야 하잖아요.

## 에이전트를 IAM의 대상으로 다루기

AI agent auth draft는 Agent Identity Management System, 줄여서 AIMS라는 개념 모델을 둬요. AIMS는 제품 이름이 아니에요.

agent identifier와 agent credential, attestation, credential provisioning을 포함해요. authentication, authorization, observability and remediation도 들어가고요. policy와 compliance까지 아우르며 에이전트 workload의 identity와 permission을 관리해요.

내부 시스템 언어로 풀면 agent-registry는 agent identifier와 display metadata를 맡아요. agent-run에는 특정 실행의 actor, trigger, approval, evidence에 tool call audit까지 묶어 실행 단위로 기록해요. model-router는 어떤 agent type이 어느 provider를 호출했는지 남겨요. github와 slack, crawler는 resource server 또는 tool adapter 역할을 하고요.

AIMS가 당장 별도 서버를 도입하라는 뜻은 아니에요. 도메인 모델에 “에이전트도 인증·인가 대상”이라는 축을 더하라는 요구에 가까워요.

### Entra Agent ID 는 이걸 제품으로 구현했다

Microsoft Entra Agent ID는 agent identity를 일반 사용자나 app registration과 구분해요. agent identity는 자체 credential이 없는 특별한 service principal이고, agent identity blueprint가 대신 token을 얻어요. accountable human 또는 group을 뜻하는 sponsor도 두고요.

권한 면에서는 Global Administrator와 Privileged Role Administrator를 차단해요. User Administrator 같은 고위험 directory role과 custom role, role-assignable group membership도 제한하고요. 에이전트에는 sponsor와 권한 제한, 조건부 접근, 감사까지 갖춘 별도의 수명주기가 필요하다는 거죠. 벤더 기능을 그대로 쓰지 않더라도 이런 원칙은 가져올 수 있어요.

## Delegation chaining은 맥락을 다시 표현한다

OAuth Identity and Authorization Chaining draft는 여러 trust domain을 지나는 요청에서 identity와 authorization 정보를 보존하는 메커니즘이에요.

요청이 domain A의 authorization server에서 시작한다고 해볼게요. domain B의 protected resource에 도달해도 원래 사용자가 누구였는지, 어떤 authorization을 받았고 어느 중간 resource server를 거쳤는지를 알 수 있어야 해요.

draft의 기본 흐름은 OAuth 2.0 Token Exchange(RFC 8693)에 JWT bearer assertion grant(RFC 7523)를 조합해요. 먼저 domain A에서 받은 토큰을 domain A의 authorization server에서 교환해요.

그 결과 domain B authorization server를 대상으로 한 JWT authorization grant를 받아요. 이를 domain B에 제시해 access token을 얻고요. access token 하나를 계속 릴레이하는 게 아니라, trust boundary를 넘을 때마다 맥락을 검증 가능한 grant로 다시 표현하는 방식이에요.

```plain text
POST /auth/token HTTP/1.1
Host: as.a.org
Content-Type: application/x-www-form-urlencoded

grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange
&resource=https%3A%2F%2Fas.b.org%2Fauth
&subject_token=ey...
&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token
```

domain A가 발급한 JWT authorization grant의 응답은 이런 형태예요.

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

resource는 대상 authorization server를, subject_token은 근거가 된 token을 뜻하고, issued_token_type은 결과물의 유형, expires_in은 수명을 나타내요. Slack → backend → GitHub 체인에 그대로 복사할 API는 아니지만, 중간 호출마다 맥락을 새로 포장하고 검증하는 설계 방향은 적용할 수 있죠.

## Transaction token으로 한 번의 행위를 묶기

Transaction Tokens draft는 call chain 전체에 필요한 정보를 전파하는 signed JWT예요. user identity와 workload identity, authorization context, request context를 담아요. 한 trust domain 안에서 쓰며 수명이 짧고 특정 transaction에 묶여 있고요.

Txn-Token은 OAuth access token이나 authentication credential이 아니에요. trust domain 내부의 downstream workload가 후속 호출을 authorize할 때 쓰죠. draft에 따르면 각 trust domain에는 정확히 하나의 logical Transaction Token Service가 있어야 해요.

이 개념을 적용하면 worker queue의 payload에 장기 refresh token을 넣지 않아도 돼요.

### 토큰 안에는 무엇이 들어가나

대신 “이번 PR 리뷰 요청”이나 “이번 crawler job”, “이번 schema 변경 제안”에 필요한 맥락만 짧게 묶어요.

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

aud는 trust domain이고 txn은 transaction identifier예요. sub는 subject, req_wl은 Txn-Token을 요청한 workload를 뜻해요. rctx는 request context, scope는 authorization scope, tctx는 transaction context예요.

agent 시스템에서는 txn을 AgentRun.id 또는 별도 approval transaction id로 둘 수 있어요.

req_wl은 slack gateway나 agent/cto dispatcher가 될 수 있고, scope는 github.pr.comment나 github.issue.label처럼 좁게 정의할 수 있어요. crawler.job.create와 prisma.schema.propose도 같은 방식으로 나눌 수 있죠.

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

이번 요청의 context를 token 발급 시점에 함께 넣는 게 핵심이에요. LLM이 중간에 도구를 고른다면 모델의 판단만 기록해서는 부족하고, 그 판단이 어떤 승인과 범위에서 실행됐는지 token 또는 audit record에 남겨야 하거든요.

## 내부 모델은 표준보다 먼저 준비할 수 있다

OAuth 2.0 Token Exchange인 RFC 8693은 이미 RFC예요. AI agent auth draft와 identity chaining draft, transaction token draft는 아직 Internet-Draft 단계고요. Transaction Tokens는 OAuth WG 문서로 진행 중이라 draft가 바뀔 수 있고요.

특정 구현체에 내부 모델을 강하게 결합하면 이후 변화에 끌려갈 수 있어요. 지금은 특정 라이브러리를 고르기보다 내부 도메인 모델부터 이 문제의식에 맞춰야 해요.

read-only 명령만 있고 호출 체인이 짧다면, 또 외부 write action과 장기 worker가 없다면 agent identity 체계를 과하게 만들 필요는 없어요. 개인용 로컬 스크립트나 단일 프로세스 자동화에서 AIMS 전체를 흉내 내면 운영 비용만 늘어요.

OAuth trust domain을 제대로 나누지 않고 identity chaining이라는 이름만 붙이면, 기존 bearer token relay에 로그 필드 몇 개만 더한 수준에 그칠 수 있죠.

write action과 장기 worker, 다중 에이전트 위임이 함께 등장하고 외부 SaaS 호출과 사용자별 승인 범위까지 있다면 미리 모델을 잡아야 해요. 처음부터 완성형 token service를 만들 필요는 없어요.

AgentRun에 actor와 delegation field를 남기는 것부터 시작할 수 있어요. tool call audit을 분리하고 scope vocabulary를 좁게 정의하는 일도 먼저 할 수 있고요.

## AgentRun을 권한 체인의 진실 원장으로 만들기

Slack 기반 LLM 멀티 에이전트 시스템에서 먼저 바꿀 모듈은 다섯 곳이에요. agent-registry, agent-run, be-chain, slack, github예요.

agent-registry는 agent/code-reviewer와 agent/cto, agent/be, agent/be-schema, agent/issue-labeler, agent/be-fix를 같은 봇으로 취급하면 안 되고 각각 다른 권한 경계로 관리해야 해요. PR에 코멘트를 남기는 agent와 schema 변경 제안을 만드는 agent도 구분해야 해요. 둘을 같은 credential로 묶으면 안 되니까요.

agent-run은 실행 단위의 진실 원장이 되어야 해요. begin → run → finish 라이프사이클과 evidence record에 항목을 더해야 해요. actorUserId, agentIdentity, delegatedScopes, approvalId, toolCallAuditId가 필요하죠.

actorUserId는 Slack command 또는 natural language mention을 시작한 사람이고, agentIdentity는 판단하고 도구를 호출한 agent workload예요. delegatedScopes에는 이번 실행에서 허용된 범위를 담고, approvalId는 사람이 승인한 write action의 근거가 되죠. toolCallAuditId는 GitHub, Prisma, crawler, CLI provider의 세부 호출 기록과 연결돼요.

### 체인을 타고 흐르는 권한

be-chain과 agent/cto에서는 CTO agent가 PM 작업을 BE worker로 분배하고, agent/be는 구현 계획을, agent/be-diff-generator나 agent/be-test는 후속 산출물을 만들어요. 최초 Slack 사용자부터 마지막 worker까지를 단일 run log로 뭉개면 중간 actor가 사라져 누가 무엇을 위임했는지 알 수 없어요. parent-child AgentRun 관계와 delegated scope가 필요한 이유죠.

slack과 github는 trust boundary에 가까워요. Slack은 사용자 intent와 interaction context가 들어오는 입구고, GitHub는 실제 write action이 일어나는 외부 resource server죠.

agent/code-reviewer, agent/issue-labeler, pr-review-loop, webhook에는 자동 트리거와 사용자 트리거가 섞여 들어올 수 있어요. webhook 자동 트리거에는 actorUserId가 없거나 system actor가 들어가는 반면, Slack command에는 명시적인 사용자 actor가 있죠. 이 차이를 모델에 남겨야 GitHub write 권한도 다르게 줄 수 있어요.

### 범위는 좁게 끊어야 한다

scope vocabulary는 좁게 잡아야 해요. write:github처럼 넓은 범위로 두지 말고 github.pr.comment, github.issue.label처럼 실제 tool adapter가 검사할 단위로 나누고, crawler.job.create와 prisma.schema.propose도 별도 범위로 구분해야 해요. 그래야 user → agent → tool의 각 호출에 이번 실행에 필요한 권한만 전달할 수 있어요.

에이전트 권한 체인의 출발점은 복잡한 token service가 아니에요.

사용자를 시작점으로 두고 에이전트를 독립된 actor로 구분해 기록하며, 도구 호출도 검증 가능한 행위로 따로 남겨야 해요. 그래야 write action을 최소 권한으로 열고, 위임과 거절의 이유도 나중에 설명할 수 있어요.
