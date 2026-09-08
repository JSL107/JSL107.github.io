---
title: "감사 로그에 bot과 backend만 남는데 write action을 열어도 될까"
description: "봇 토큰만 쓰면 감사 로그에 bot과 backend만 남는다. user → agent → tool 호출 체인에 위임 범위와 감사 맥락을 남기는 설계안을 표준 draft와 제품 문서를 근거로 정리한다."
pubDatetime: 2026-08-24T19:08:00+09:00
category: backend
---

Slack 기반 에이전트가 read-only 도구를 넘어 외부 시스템까지 바꾸기 시작하면 봇 토큰만으로는 부족해요. user → agent → tool로 이어지는 권한 체인을 설계해야 하죠. 에이전트를 독립된 실행 주체로 식별하고, 각 행위에 필요한 위임 범위와 감사 맥락도 끝까지 보존해야 해요. 아래는 관련 표준 draft와 제품 문서를 읽고 제 시스템 구조에 대보며 정리한 설계안이에요. 코드로 옮겨 돌려본 단계는 아직 아니고요. 사용자 한 명이 Slack 워크스페이스 하나에서 쓰는 단일 구성이라, 여러 조직이 한 시스템을 나눠 쓰거나 테넌트가 갈리는 환경에서 무엇이 달라지는지는 이 글이 보여주지 못해요.

## Write action이 만드는 새로운 문제

/today는 오늘 할 일을 정리하고 /review-pr은 PR diff를 읽으며 /worklog는 업무 로그 초안을 만드는데, 이 단계들은 대부분 read-only 흐름이에요. 실패해도 잘못된 답변 하나가 남을 뿐, 외부 시스템의 상태가 직접 바뀌지는 않아요.

에이전트가 GitHub issue에 라벨을 붙이고 PR에 코멘트를 남기면 상황이 달라져요. Prisma schema 변경 제안을 바탕으로 migration 성격의 작업을 만들 때나, crawler job을 등록하고 백엔드 워커에게 구현을 위임하는 경우도 마찬가지고요. 모두 외부 상태를 바꾸는 일이니까요.

사고가 나면 토큰 문자열이 아니라 호출 체인을 확인해야 해요. 최초 사용자가 누구였고 어떤 Slack interaction에서 시작됐는지, 중간에서 어느 에이전트가 판단했고 어떤 권한이 축소되어 전달됐는지를 살펴야 해요. 어떤 도구 호출이 왜 거절됐는지도 기록에 남아 있어야 하고요.

멀티 에이전트 시스템에서 에이전트를 단순한 LLM 호출 함수로 두면 경계가 흐려져요. 독립 식별자와 권한, 승인 이력, 감사 책임을 지닌 workload, 그러니까 사람이 아니면서 스스로 돌아가는 실행 주체로 다뤄야 해요. 그래야 write action을 열 때 최소 권한과 추적 가능성을 함께 확보할 수 있어요.

## Bot token과 shared key로는 체인이 남지 않는다

기존 시스템은 Slack bot token이나 GitHub app token 같은 서비스 단위 credential로 모든 작업을 처리해요. 사용자가 승인한 OAuth token을 worker queue나 DB에 저장해 두었다가 나중에 쓰기도 해요. 내부 API를 shared secret이나 service account로 묶어, 백엔드에서 온 요청이라는 이유만으로 그대로 신뢰하기도 해요.

호출 체인이 짧을 때는 편해요. 하지만 Slack command가 backend agent를 부르고, agent가 model-router를 거치면 얘기가 달라져요. 여기서 LLM과 github 모듈, Prisma adapter, crawler worker까지 호출하면 중요한 정보가 사라지거든요.

단순 bearer token(가진 사람이면 누구든 그대로 쓸 수 있는, 소지 자체가 권한이 되는 토큰)만 넘기면 downstream 서비스는 요청의 성격을 판단하기 어려워요. PR을 읽고 리뷰 초안을 만드는 agent/code-reviewer가 사용자 A의 PR 리뷰 요청 범위에서 만든 GitHub comment인지 알 수 없거든요. 로그에 bot 또는 backend만 남으면 나중에 권한을 줄이기도, 거절 사유를 설명하기도 힘들어져요.

### 표준은 토큰이 아니라 위임 범위를 묻는다

IETF의 AI Agent Authentication and Authorization draft는 AI agent를 LLM과 도구, 서비스, 리소스를 반복해서 호출하는 workload로 봐요. 여기에 WIMSE(Workload Identity in Multi-System Environments, 여러 시스템에 걸쳐 workload의 신원을 다루는 규격)와 OAuth 2.0 계열, OpenID Shared Signals Framework를 적용하는 방향이에요. 에이전트에는 안정적인 identifier와 credential을 주고, 사용자를 대신할 때는 delegation context도 보존해야 한다는 거죠.

여기까지가 draft에 적힌 내용이고, 아래는 그걸 제 시스템에 대본 제 해석이에요. 권한 모델은 "사용자가 승인했으니 worker가 아무 때나 쓴다"에서 "이 agent identity가 받은 특정 위임 범위에서 이번 행위를 수행한다"로 바뀌어야 한다고 봐요. 그 위임은 사용자 또는 시스템에서 받은 것이어야 하잖아요.

## 에이전트를 IAM의 대상으로 다루기

AI agent auth draft는 에이전트를 IAM(Identity and Access Management, 누가 무엇에 접근할 수 있는지를 계정과 권한으로 관리하는 체계)이 다뤄야 할 대상으로 놓고, Agent Identity Management System, 줄여서 AIMS라는 개념 모델을 둬요. AIMS는 제품 이름이 아니에요.

draft가 AIMS의 구성 요소로 세는 항목은 여덟 개예요.

- **Agent Identifiers** — 에이전트를 가리키는 식별자
- **Agent Credentials** — 그 식별자로 인증할 때 쓰는 자격증명
- **Agent Credential Provisioning** — 자격증명 발급과 갱신. 이때 실행 환경이 주장대로인지 증명하는 증거인 attestation이 발급 판단의 입력으로 들어와요
- **Agent Authentication** — 호출자가 그 에이전트가 맞는지 확인
- **Agent Authorization** — 이번 행위를 해도 되는지 판정
- **Agent Observability and Remediation** — 관측과 사후 조치
- **Agent Authentication and Authorization Policy** — 인증·인가 규칙
- **Agent Compliance** — 규정 준수

결국 에이전트 workload의 identity와 permission을 관리하는 축 하나를 통째로 세우라는 얘기예요.

내부 시스템 언어로 옮기면 이렇게 대응돼요.

- `agent-registry` — 에이전트 목록과 표시 정보를 들고 있는 모듈. agent identifier와 display metadata를 맡아요
- `agent-run` — 실행 한 건의 기록이 쌓이는 모듈. 특정 실행의 actor, trigger, approval, evidence에 tool call audit까지 묶어 실행 단위로 남겨요
- `model-router` — 어떤 agent type이 어느 provider를 호출했는지 남기는 모듈
- `github`, `slack`, `crawler` — 외부 시스템에 실제로 닿는 모듈. 토큰을 검사하고 보호된 자원을 실제로 내주는 서버인 resource server, 또는 tool adapter 역할이에요

AIMS가 당장 별도 서버를 도입하라는 뜻은 아니에요. 도메인 모델에 "에이전트도 인증·인가 대상"이라는 축을 더하라는 요구에 가까워요.

### Entra Agent ID 는 이걸 제품으로 구현했다

Microsoft Entra Agent ID는 agent identity를 일반 사용자나 app registration(사람이 아닌 애플리케이션을 디렉터리에 등록해 둔 것)과 구분해요. agent identity는 자체 credential이 없는 특별한 service principal(디렉터리 안에서 애플리케이션이 권한을 받는 계정)이고, 같은 종류의 에이전트가 공유하는 템플릿인 agent identity blueprint가 대신 token을 얻어요. accountable human 또는 group을 뜻하는 sponsor도 두고요.

권한 면에서는 Global Administrator와 Privileged Role Administrator를 차단해요. User Administrator 같은 고위험 directory role과 custom role, role-assignable group membership도 제한하고요. 이 목록은 Entra Agent ID 문서의 「Authorization in Microsoft Entra Agent ID」 페이지에 그대로 적혀 있어요. 제가 읽기에 이건 에이전트에 sponsor와 권한 제한, 조건부 접근, 감사까지 갖춘 별도의 수명주기가 필요하다는 이야기예요. 벤더 기능을 그대로 쓰지 않더라도 이런 원칙은 가져올 수 있어요.

## Delegation chaining은 맥락을 다시 표현한다

OAuth Identity and Authorization Chaining Across Domains draft는 여러 trust domain을 지나는 요청에서 identity와 authorization 정보를 보존하는 메커니즘이에요. trust domain은 같은 authorization server(토큰을 발급하며 누구에게 무엇을 허용할지 판정하는 서버)의 판단을 그대로 믿기로 약속한 시스템의 묶음이에요. 제 시스템으로 옮기면 Slack 워크스페이스와 제 백엔드, GitHub이 각각 다른 trust domain이고요. 뒤에 나올 Transaction Tokens가 한 trust domain **안에서** 호출을 묶는 장치라면, 이 draft는 trust domain과 trust domain **사이를** 잇는 장치예요. access token 하나를 끝까지 릴레이하지 말고 경계를 넘을 때마다 맥락을 다시 표현하라는 것이 이 문서가 정한 방식이고요.

요청이 domain A의 authorization server에서 시작한다고 해볼게요. domain B의 protected resource, 그러니까 유효한 토큰이 있어야 접근할 수 있는 보호된 자원에 도달해도 원래 사용자가 누구였는지, 어떤 authorization을 받았고 어느 중간 resource server를 거쳤는지를 알 수 있어야 해요.

### 토큰을 릴레이하는 대신 grant로 다시 받는다

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

access token이 아닌 grant가 왜 `access_token` 필드로 오는지가 먼저 걸려요. RFC 8693은 token exchange 응답을 정의하면서 `access_token`이라는 이름은 역사적인 이유로 쓰는 것이고 발급된 토큰이 OAuth access token일 필요는 없다고 못 박아 둬요. 그러니 이 필드에 실제로 담겨 오는 건 domain B에 제시할 JWT authorization grant예요. `token_type`이 `N_A`인 것도 같은 대목에서 설명돼요. 발급된 토큰이 access token이 아니거나 access token으로 쓸 수 없으면, OAuth의 `token_type` 구분이 이 맥락에 해당하지 않는다는 뜻으로 `N_A`를 쓴다고요.

나머지 필드는 이름 그대로예요. `resource`는 대상 authorization server를, `subject_token`은 근거가 된 token을 뜻하고, `issued_token_type`은 결과물의 유형, `expires_in`은 수명을 나타내요. `expires_in`의 단위는 초라서 이 grant는 60초짜리예요. 뒤에 나올 Txn-Token 예시는 `exp`에서 `iat`를 뺀 360초 수명인데, 하나는 domain B에서 access token으로 바꾸는 그 순간에만 필요한 grant고 다른 하나는 요청 하나가 call chain을 다 지나갈 동안 실려 다니는 증표예요. 쓰이는 구간이 다르니 수명도 다르게 잡혔다고 읽었어요.

Slack → backend → GitHub 체인에 그대로 복사할 API는 아니지만, 중간 호출마다 맥락을 새로 포장하고 검증하는 설계 방향은 적용할 수 있어요.

## Transaction token으로 한 번의 행위를 묶기

앞 절은 trust domain과 trust domain 사이를 어떻게 잇느냐는 문제였어요. 이번 절은 그 경계를 넘어온 요청이 한 trust domain 안에서 여러 서비스를 지나는 동안 무엇을 들고 다니느냐는 문제고요.

체인 전체가 같은 권한을 들고 다니게 두지 말고, 한 번의 행위에만 묶이는 짧은 증표를 따로 발급하는 편이 나아요. Transaction Tokens draft가 말하는 signed JWT가 그 역할이에요. call chain 전체에 필요한 정보를 전파하면서 user identity와 workload identity, authorization context, request context를 담거든요. 한 trust domain 안에서 쓰며 수명이 짧고 특정 transaction에 묶여 있고요.

Txn-Token은 OAuth access token이나 authentication credential이 아니에요. trust domain 내부의 downstream workload가 후속 호출을 authorize할 때 쓰죠. Txn-Token을 쓰는 각 trust domain에는 정확히 하나의 logical Transaction Token Service가 있어야 하고요. 이건 Transaction Tokens draft가 MUST로 못 박은 요구사항이에요.

이 개념을 적용하면 worker queue의 payload에 장기 refresh token을 넣지 않아도 될 것 같아요. 문서를 읽고 우리 큐 구조에 대본 판단이고, 실제로 바꿔 돌려본 것은 아니에요.

### 토큰 안에는 무엇이 들어가나

Txn-Token은 장기 권한을 통째로 담지 않아요. "이번 PR 리뷰 요청"이나 "이번 crawler job", "이번 schema 변경 제안"에 필요한 맥락만 짧게 묶어요.

아래는 Transaction Tokens draft에 실린 예시고, 값도 draft 것 그대로예요. 주식 거래를 소재로 삼은 draft의 예시라 이 글이 다루는 PR 리뷰나 crawler job과는 소재가 다른데, 봐야 할 것은 값이 아니라 claim의 구조예요.

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

`iat`는 발급 시각, `exp`는 만료 시각이라 이 예시의 수명은 360초예요. `aud`는 trust domain이고 `txn`은 transaction identifier예요. `sub`는 subject, `req_wl`은 Txn-Token을 요청한 workload를 뜻해요. `rctx`는 request context, `scope`는 authorization scope, `tctx`는 transaction context예요.

이 구조를 제 시스템에 대보면 `txn`은 AgentRun.id 또는 별도 approval transaction id로 둘 수 있어요. `req_wl`은 slack gateway나 agent/cto dispatcher가 되고, `scope`는 tool adapter가 실제로 검사할 수 있는 단위까지 좁혀 정의하고요. 어떤 이름으로 끊을지는 뒤에서 다시 다룰게요.

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

이 요청은 Txn-Token 하나를 받아 오는 호출이에요. `grant_type`과 `subject_token`은 앞의 token exchange와 같은 자리인데, `requested_token_type`에 txn_token을 적어 일반 access token 말고 Txn-Token을 달라고 요청하는 점이 달라요. 생략부호로 남은 두 자리에는 draft가 정의한 JSON 객체가 들어가요. `request_context`에는 이 transaction의 맥락이 들어가는데, 발급된 토큰의 `rctx`가 될 호출자 IP나 인증 수단 같은 값이에요. `request_details`에는 요청 자체의 세부 정보가 들어가고, Transaction Token Service는 이 값에 자기가 가진 정보를 합쳐 `tctx`를 만들어요. 제 시스템으로 옮기면 `request_context`에는 Slack interaction의 사용자와 채널, 트리거 종류가 들어가고 `request_details`에는 "PR #123에 리뷰 코멘트를 단다" 같은 이번 행위의 대상과 동작이 들어갈 자리예요.

이번 요청의 context를 token 발급 시점에 함께 넣는 게 핵심이에요. LLM이 중간에 도구를 고른다면 모델의 판단만 기록해서는 부족하고, 그 판단이 어떤 승인과 범위에서 실행됐는지 token 또는 audit record에 남겨야 하거든요.

## 내부 모델은 표준보다 먼저 준비할 수 있다

이 글이 참고한 문서 네 종은 성숙도가 같지 않아요. OAuth 2.0 Token Exchange인 RFC 8693은 이미 RFC예요. 반면 AI agent auth draft와 identity chaining draft, transaction token draft는 아직 Internet-Draft 단계고, Transaction Tokens는 OAuth WG 문서로 진행 중이에요. 그러니 draft가 바뀔 수 있고, 지금 특정 구현체에 내부 모델을 강하게 결합하면 이후 변화에 끌려갈 수 있다는 뜻이죠.

그래서 안 해도 되는 조건부터 넉넉하게 잡아 두려고 해요. read-only 명령만 있고 호출 체인이 짧다면, 또 외부 write action과 장기 worker가 없다면 agent identity 체계를 과하게 만들 필요는 없어요. 개인용 로컬 스크립트나 단일 프로세스 자동화에서 AIMS 전체를 흉내 내면 운영 비용만 늘고, OAuth trust domain을 제대로 나누지 않고 identity chaining이라는 이름만 붙이면 기존 bearer token relay에 로그 필드 몇 개만 더한 수준에 그칠 수 있고요.

반대로 해야 하는 조건은 이래요. write action과 장기 worker, 다중 에이전트 위임이 함께 등장하고 외부 SaaS 호출과 사용자별 승인 범위까지 있다면 미리 모델을 잡아야 해요. 그래도 처음부터 완성형 token service를 만들 필요는 없어서, 저는 AgentRun에 actor와 delegation field를 남기고 tool call audit을 분리하고 scope vocabulary를 좁게 정의하는 데서 시작하려고 해요. 특정 라이브러리를 고르는 일보다 내부 도메인 모델을 이 문제의식에 맞추는 일이 먼저니까요.

## AgentRun을 권한 체인의 진실 원장으로 만들기

Slack 기반 LLM 멀티 에이전트 시스템에서 제가 먼저 바꾸려는 모듈은 다섯 곳이에요.

- `agent-registry` — 앞에서 agent identifier 자리에 대응시킨 그 모듈. 여기서 권한 경계를 나눠요
- `agent-run` — 앞에서 실행 기록 자리에 대응시킨 그 모듈. 여기에 위임 범위와 거절까지 적고요
- `be-chain` — 백엔드 작업이 에이전트 사이로 분배되는 경로
- `slack` — 사용자 요청이 들어오는 입구
- `github` — 실제 write action이 나가는 출구

agent-registry에서는 지금 한 봇으로 뭉뚱그려진 에이전트들을 각각 다른 권한 경계로 나눌 생각이에요. PR을 리뷰하는 agent/code-reviewer, 작업을 분배하는 agent/cto, 구현 계획을 세우는 agent/be, schema 변경을 제안하는 agent/be-schema, issue에 라벨을 붙이는 agent/issue-labeler, 코드를 고치는 agent/be-fix가 필요한 권한은 서로 다르니까요. 특히 PR에 코멘트를 남기는 agent와 schema 변경 제안을 만드는 agent를 같은 credential로 묶으면, 한쪽만 골라 권한을 줄이거나 회수할 수 없어요.

agent-run은 실행 단위의 진실 원장이 되어야 해요. 저는 begin → run → finish 라이프사이클과 evidence record에 다음 항목을 더하려고 해요.

- `actorUserId` — Slack command 또는 natural language mention을 시작한 사람
- `agentIdentity` — 판단하고 도구를 호출한 agent workload
- `delegatedScopes` — 이번 실행에서 허용된 범위
- `approvalId` — 사람이 승인한 write action의 근거
- `toolCallAuditId` — GitHub, Prisma, crawler, CLI provider의 세부 호출 기록과 연결되는 열쇠
- `deniedToolCalls` — 어떤 도구 호출이 왜 거절됐는지

마지막 항목이 도입부에서 세운 세 가지 확인 사항 중 마지막, 그러니까 "어떤 도구 호출이 왜 거절됐는지"가 회수되는 자리예요. 거절은 실행 기록에 남지 않으면 존재 자체가 사라지니까 성공한 호출과 같은 원장에 함께 적어야 해요.

### 최초 사용자와 마지막 worker 사이에서 중간 actor가 사라진다

be-chain과 agent/cto에서는 CTO agent가 PM 작업을 BE worker로 분배하고, agent/be는 구현 계획을, diff 초안을 만드는 agent/be-diff-generator나 테스트를 설계하는 agent/be-test는 후속 산출물을 만들어요. 최초 Slack 사용자부터 마지막 worker까지를 단일 run log로 뭉개면 중간 actor가 사라져 누가 무엇을 위임했는지 알 수 없어요. parent-child AgentRun 관계와 delegated scope가 필요한 이유죠.

slack과 github는 trust boundary에 가까워요. Slack은 사용자 intent와 interaction context가 들어오는 입구고, GitHub는 실제 write action이 일어나는 외부 resource server죠.

agent/code-reviewer와 agent/issue-labeler, PR 리뷰를 주기적으로 도는 pr-review-loop, 그리고 webhook에는 자동 트리거와 사용자 트리거가 섞여 들어올 수 있어요. webhook 자동 트리거에는 actorUserId가 없거나 system actor가 들어가는 반면, Slack command에는 명시적인 사용자 actor가 있죠. 이 차이를 모델에 남겨야 GitHub write 권한도 다르게 줄 수 있어요.

### 범위는 좁게 끊어야 한다

저는 scope vocabulary를 좁게 잡으려고 해요. write:github처럼 넓은 범위로 두지 말고 github.pr.comment, github.issue.label처럼 실제 tool adapter가 검사할 단위로 나눠야 해요. crawler.job.create와 prisma.schema.propose도 별도 범위로 구분하고요. 그래야 user → agent → tool의 각 호출에 이번 실행에 필요한 권한만 전달할 수 있어요.

## 무엇을 확인해야 이 설계가 맞다고 할 수 있을까

아직 코드로 옮기지 않았으니 지금 낼 수 있는 건 결과가 아니라 검증 계약이에요. 무엇을 어떤 조건에서 확인할지 미리 적어 두고, 구현한 뒤 이 자리로 돌아와 채우려고 해요.

**판정 기준.** 목표를 한 문장으로 줄이면 이래요. AgentRun 한 건의 id만 들고 다른 로그를 뒤지지 않은 채, 도입부의 세 질문에 답할 수 있으면 통과예요. 최초 사용자가 누구였고 어떤 Slack interaction에서 시작됐는지, 중간에서 어느 에이전트가 판단했고 어떤 권한이 축소되어 전달됐는지, 어떤 도구 호출이 왜 거절됐는지 이 셋이요.

**확인 환경과 방법.** 로컬 개발 환경에서 Slack 슬래시 커맨드 한 번으로 GitHub write action이 나가는 경로를 끝까지 돌린 다음, 그 실행의 AgentRun 레코드와 tool call audit 레코드만 읽어 위 세 질문에 답해 보려고 해요. 지표는 질문마다 "레코드만으로 답이 나온다 / 안 나온다"의 이진 판정이고요.

**전후 비교의 기준.** 비교 축은 "사고 조사 시 레코드만으로 복원 가능한 항목"으로 두려고 해요. 지금 그 축에서 남는 것은 호출 주체 하나뿐이고, 그마저 bot 또는 backend로만 찍혀요. 바꾼 뒤에는 위에 적은 여섯 항목이 같은 축에 남고요. 다만 이건 항목이 있느냐 없느냐의 이진 비교라 "몇 퍼센트 줄었다" 같은 정량 지표가 아니에요. 항목이 남는다는 것과 그 값이 실제로 맞는다는 것도 다른 이야기라, 값의 정확성은 이 판정으로 증명되지 않아요.

**실패 경로.** 정상 경로만 보면 부족해서 세 가지를 함께 확인하려고 해요. 증표가 만료된 뒤 들어온 도구 호출이 거절되고 그 거절이 `deniedToolCalls`에 남는지, 같은 `approvalId`로 write action을 두 번 실행했을 때 두 번째가 막히는지, 워커가 재시작된 뒤 재개된 실행이 앞선 AgentRun의 위임 범위를 그대로 이어받는지예요.

**재실행 규칙.** 같은 run을 재시도할 때 승인 식별자는 재사용하되 위임 범위는 다시 평가하도록 두려고 해요. 사람이 한 번 승인한 사실은 그대로 두고, 그 사이에 권한이 회수됐는지는 실행 시점에 다시 묻자는 뜻이에요.

**재현 최소 조건과 확인하지 않은 값.** 재현에 필요한 최소 조건은 Slack 앱 하나, GitHub write 권한이 있는 자격증명 하나, AgentRun을 적재할 데이터베이스 하나예요. 반대로 이 글에서 정하지 않은 값도 분명히 해 둘게요. 어떤 라이브러리로 token service를 세울지, 토큰 수명을 몇 초로 잡을지, Txn-Token을 실제로 발급할지 아니면 AgentRun 레코드로 대신할지는 아직 결정하지 않았어요. 본문에 나온 60초와 360초는 draft 예시의 값이지 제가 고른 값이 아니고요.

## 출발점은 token service가 아니다

에이전트 권한 체인의 출발점은 복잡한 token service가 아니에요. 다음에 손댈 자리는 AgentRun 스키마 한 줄이고요. 거기에 actorUserId와 delegatedScopes가 비어 있는 한 나머지 설계는 전부 종이 위에서만 맞는 이야기로 남아요.

## 참고 자료

아래 링크는 글을 올린 뒤 출처를 다시 짚으며 2026년 9월 8일에 직접 열어 확인했어요. Internet-Draft는 개정될 때마다 번호가 올라가서 같은 주소라도 내용이 달라질 수 있으니, 확인한 리비전을 함께 적어 둘게요.

- **AI Agent Authentication and Authorization** — 확인한 리비전은 `draft-klrc-aiagent-auth-03`(2026년 7월 6일, 개인 제출 Internet-Draft, Informational 목표). <https://datatracker.ietf.org/doc/draft-klrc-aiagent-auth/>
  「표준은 토큰이 아니라 위임 범위를 묻는다」와 「에이전트를 IAM의 대상으로 다루기」 절을 받쳐요. 에이전트를 workload로 보는 정의, WIMSE와 OAuth 2.0 계열, OpenID Shared Signals Framework를 조합하는 방향, AIMS 여덟 구성 요소가 이 문서에 있어요.
- **OAuth Identity and Authorization Chaining Across Domains** — 확인한 리비전은 `draft-ietf-oauth-identity-chaining-17`(OAuth WG, Standards Track 목표, RFC Editor 큐 대기). <https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-chaining/>
  「Delegation chaining은 맥락을 다시 표현한다」 절을 받쳐요. 본문의 token exchange 요청 예시와 `token_type`이 `N_A`인 응답 예시도 이 문서의 것이에요.
- **Transaction Tokens** — 확인한 리비전은 `draft-ietf-oauth-transaction-tokens-11`(OAuth WG, WG 합의 후 write-up 대기). <https://datatracker.ietf.org/doc/draft-ietf-oauth-transaction-tokens/>
  「Transaction token으로 한 번의 행위를 묶기」 절 전체를 받쳐요. "각 trust domain은 정확히 하나의 logical TTS를 둬야 한다"는 MUST 문장, 본문의 Txn-Token JSON 예시, `request_context`와 `request_details`의 정의가 모두 이 문서에 있어요.
- **RFC 8693, OAuth 2.0 Token Exchange** — 2020년 1월, Standards Track. <https://www.rfc-editor.org/rfc/rfc8693.html>
  응답이 `access_token` 필드로 오는 이유, `token_type` 값 `N_A`의 뜻, `expires_in`의 단위가 초라는 사실을 받쳐요.
- **RFC 7523, JSON Web Token (JWT) Profile for OAuth 2.0 Client Authentication and Authorization Grants** — 2015년 5월, Standards Track. <https://www.rfc-editor.org/rfc/rfc7523.html>
  identity chaining이 JWT authorization grant를 만들 때 쓰는 프로파일이라 「토큰을 릴레이하는 대신 grant로 다시 받는다」 절을 받쳐요.
- **Microsoft Entra Agent ID 문서** — 「Entra Agent ID 는 이걸 제품으로 구현했다」 절을 받쳐요. 문서 홈은 <https://learn.microsoft.com/en-us/entra/agent-id/> 이고, 본문이 인용한 두 페이지는 아래와 같아요.
  - 「Overview of agent identities in Microsoft Entra」 <https://learn.microsoft.com/en-us/entra/agent-id/agent-identities> — agent identity가 자체 credential 없는 특별한 service principal이라는 것, blueprint가 대신 token을 얻는다는 것, sponsor가 책임지는 사람 또는 그룹이라는 설명이 여기 있어요.
  - 「Authorization in Microsoft Entra Agent ID」 <https://learn.microsoft.com/en-us/entra/agent-id/authorization-agent-id> — Global Administrator와 Privileged Role Administrator, User Administrator를 배정할 수 없다는 것, custom role을 배정할 수 없다는 것, role-assignable group의 멤버가 될 수 없다는 것이 여기 있어요.
