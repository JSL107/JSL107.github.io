---
title: "버튼 승인만으로는 에이전트 결제를 못 맡긴다"
description: "Slack 기반 에이전트에 비용 발생 작업을 맡기려면 승인 버튼과 함께 구매 대상, 결제 권한, 실행 결과를 연결할 증거가 필요하다."
pubDatetime: 2026-11-26T19:47:00+09:00
category: backend
---

Slack에서 에이전트에게 일을 맡기다 보면 생각보다 빨리 돈이 드는 일과 마주해요. 외부 SaaS에서 유료 리소스를 만들거나 예약금을 거는 순간에는 “누가 시켰나?”만으로 부족해요. “무엇을, 얼마까지, 어떤 조건에서 허가했나?”와 “실제로 무엇이 실행됐나?”도 기록으로 남아야 하니까요.

이 글은 AP2 공식 specification v0.2와 flows 문서, Google 공개 블로그, 공식 GitHub 저장소의 generated model 일부를 읽고 정리한 개념 글이에요. 실제 결제망에 붙여 운영해 본 경험을 쓴 글은 아니에요.

## AP2가 붙잡는 승인 경계

기존 결제 UX는 대체로 사람이 신뢰할 수 있는 화면에서 장바구니를 확인하고 “구매”를 누른다는 전제에 기대요. 에이전트가 중간에 들어오면 사용자는 “좋은 조건이면 대신 사줘”라고 말하고 에이전트는 여러 상점과 대화하며 결제 수단은 별도 credential provider가 관리할 수도 있어요. 이때 merchant는 에이전트의 요청이 정말 사용자의 의도에 따른 것인지 확인해야 해요.

AP2는 mandate와 receipt로 답해요. mandate는 사용자가 에이전트에게 준 권한을 암호학적으로 고정한 증거이고 receipt는 각 역할이 결과를 받아들이거나 거절했음을 남기는 증거예요. Google 발표 글에 따르면 AP2는 Agent2Agent, MCP와 함께 쓸 수 있는 공개 프로토콜로, 카드·계좌이체·스테이블코인 같은 특정 결제 수단에 묶이지 않아요. 결제 수단을 새로 만들기보다 agentic 구간에서 “이 요청은 허가된 요청인가?”를 검증할 공통 언어를 더하는 데 가까워요.

AP2는 장바구니 API나 상품 카탈로그 API 전체를 정의하지 않아요. 상품 검색과 merchant의 commerce API는 범위 밖이고 AP2가 다루는 것은 에이전트가 만든 checkout부터 payment authorization까지 이어지는 신뢰 체인이에요. 그래서 결제 SDK보다 에이전트 결제의 보안 레이어로 보는 편이 정확해요.

## LLM이 맡을 수 없는 Trusted Surface

AP2는 Shopping Agent, Trusted Surface, Credential Provider, Merchant, Merchant Payment Processor로 역할을 나눠요. Shopping Agent는 상품을 찾고 checkout을 구성해 구매를 시도해요. Credential Provider는 결제 credential을 관리하고 Merchant는 checkout을 만들어 주문을 완결하며 Merchant Payment Processor는 결제를 처리해요. 한 회사가 여러 역할을 맡을 수 있어도 역할별 책임은 분리돼요.

Trusted Surface는 반드시 non-agentic이어야 해요. LLM이 사용자의 동의를 해석하거나 대신 꾸며 내는 화면이 아니라, 결정적 코드가 렌더링하고 서명 경계를 관리하는 UI여야 해요. Slack 모달, 웹 콘솔, 모바일 승인 화면이 후보가 될 수 있지만 화면에 표시할 mandate content를 LLM이 마음대로 바꿀 수는 없어요. 사용자가 본 내용과 서명된 내용이 같아야 하니까요.

AP2 문서의 threat model은 에이전트 자체를 잠재적 공격자로 봐요. LLM이 포함된 역할은 비결정적이라 프롬프트 주입이나 도구 호출 오류로 원래 의도와 다른 요청을 만들 수 있어요. 두 non-agentic 역할 사이에서는 일반적인 웹 보안으로 충분할 수 있지만 agentic 역할이 끼면 tamper-evident mechanism이 필요해져요. 자연어로 요청을 라우팅하는 건 편리해도 비용 승인의 마지막 경계를 맡겨서는 안 돼요.

## Checkout Mandate와 Payment Mandate가 고정하는 것

Checkout Mandate는 구매 대상에 관한 증거예요. Merchant는 checkout payload를 서명한 JWT로 제공하고 closed Checkout Mandate는 그 `checkout_jwt`와 `checkout_hash`에 묶여요. 사용자가 승인한 checkout이 나중에 다른 상품이나 금액으로 바뀌었다면 hash 검증에서 걸려야 해요.

공식 Python generated model은 closed Checkout Mandate의 핵심 필드를 이렇게 정의해요.

```plain text
class CheckoutMandate(BaseModel):
    """
    Agreement from a User or an Agent to authorize a particular Checkout action.
    """

    vct: Literal['mandate.checkout.1'] = Field(
        default='mandate.checkout.1',
        description="Verifiable Credential Type claim as defined in SD-JWT. MUST be 'mandate.checkout'.",
    )
    checkout_jwt: str = Field(
        ...,
        description='base64url-encoded serialized merchant-signed JWT of the Checkout payload.',
        json_schema_extra={'x-selectively-disclosable-field': True},
    )
    checkout_hash: str = Field(
        ...,
        description='base64url-encoded hash of the checkout_jwt field value, uniquely identifying this checkout. If this checkout mandate is presented as an sd-jwt and the _sd_alg field is present then the hash algorithm used MUST match the _sd_alg field. Otherwise, sha-256 MUST be used.',
    )
```

이 예시는 공식 저장소의 generated model에서 가져왔어요. 내 시스템에 대입하면 Slack 승인 버튼에 “사용자가 승인함”이라는 boolean만 저장해서는 부족해요. merchant가 만든 checkout 원문과 그 hash, mandate schema version, 서명 주체, 생성·만료 시각을 함께 저장해야 그 승인으로 실행한 주문이 같은 checkout인지 검증할 수 있어요.

Payment Mandate는 결제 권한을 고정해요. 공식 model에서 `transaction_id`는 Payment Mandate를 checkout과 연결해요. 설명에는 `checkout_jwt`의 base64url-encoded hash라고 적혀 있고 payee, payment amount, payment instrument, execution date, risk data 같은 필드가 이어져요.

```plain text
class PaymentMandate(BaseModel):
    """
    Agreement from a User or an Agent to authorize a particular Payment action.
    """

    vct: Literal['mandate.payment.1'] = Field(
        default='mandate.payment.1',
        description="Verifiable Credential Type claim as defined in SD-JWT. MUST be 'mandate.payment'.",
    )
    transaction_id: str = Field(
        ...,
        description='base64url-encoded hash of the checkout_jwt field value, uniquely identifying the checkout associated with this. The hash algorithm used MUST be the same as the sd_hash field for this sd-jwt, or sha256 if absent.',
    )
    payee: merchant.Merchant = Field(
        ..., description='The merchant receiving the payment.'
    )
    payment_amount: amount.Amount = Field(
        ...,
        description='Transaction amount object containing currency (ISO 4217 code, e.g., "USD") and amount (integer minor units per ISO 4217, e.g., 27999 = $279.99). Final value confirmed by the user.',
    )
```

“결제 승인”은 결제 수단만 정하는 일이 아니에요. 어떤 checkout에 대해 누구에게 얼마를 어떤 instrument로 지불하는지까지 함께 묶어야 해요. Slack에 “승인” 버튼 하나를 둘 수는 있지만 버튼을 누를 때 보여 준 금액과 merchant, 결제 수단, checkout hash를 결정적 화면에 고정하지 않으면 AP2가 말하는 Trusted Surface가 아니에요.

## 사람이 있을 때와 없을 때

AP2 flows 문서는 Human Present와 Human Not Present를 나눠 설명해요. Human Present에서는 사용자가 그 시점에 직접 closed Checkout Mandate와 closed Payment Mandate를 승인해요. 에이전트가 장바구니를 만들면 Trusted Surface가 mandate content를 렌더링하고 사용자가 인증과 동의를 마친 뒤 서명된 mandate가 Shopping Agent로 돌아가요. 이후 Credential Provider와 Merchant, Merchant Payment Processor가 각자 mandate와 hash binding을 검증해요.

Human Not Present에서는 사용자가 처음에 open Checkout Mandate와 open Payment Mandate를 승인해요. open mandate에는 특정 checkout 하나가 아니라 미래 행동의 조건을 담아요. 허용된 merchant와 line item, 금액 범위, 실행 가능 기간, recurrence, budget 같은 constraint가 여기에 들어가요. 나중에 에이전트가 조건을 만족하는 상황을 찾으면 agent-signed closed mandate를 만들어 실행을 시도해요.

그렇다고 사용자가 없을 때 모든 과정이 자동으로 끝나는 건 아니에요. flows 문서에는 merchant나 credential provider가 `unresolved_constraint` 오류를 반환하면 사용자를 다시 루프로 불러 closed mandate 승인을 받는 경로가 있어요. open mandate로 자동화 범위는 넓히되 constraint 해석이 애매하거나 위험 신호가 크면 Human Present로 돌아갈 수 있어야 해요.

## Receipt로 실행 결과를 연결하기

결제가 끝난 뒤 로그 한 줄만 남겨서는 감사 증거가 약해요. AP2의 receipt는 mandate와 결과를 다시 묶어요. Checkout Receipt는 checkout의 최종 상태를, Payment Receipt는 payment의 최종 상태를 나타내요. 공식 generated model에서 둘 다 `status`, `iss`, `iat`, `reference`, `error`, `error_description` 같은 공통 필드를 갖고, 성공하면 order id나 payment id, PSP·network confirmation id가 붙어요.

`reference`는 closed mandate의 hash에 binding되는 값이에요. 이 필드가 있어야 receipt가 “어떤 mandate에 대한 결과인지”를 말할 수 있어요. 에이전트 실행 로그와 Slack 승인 로그, 결제 처리 결과를 따로 저장하면 나중에 사람이 서로 맞춰 봐야 해요. mandate hash를 기준으로 receipt와 실행 run을 연결하면 감사 쿼리에서 그 관계를 결정적으로 확인할 수 있어요.

PostgreSQL·Prisma 모델을 만든다면 처음부터 checkout mandate, payment mandate, receipt를 세 테이블로 분리하는 편이 나아요. 하나의 “approval” JSON에 담으면 빨리 만들 수는 있지만 schema version, hash, issuer, subject, expiration, receipt reference, error code를 각각 질의해야 할 때 결국 다시 쪼개야 해요.

## 이대리에서 먼저 바꿀 곳

내 시스템은 Slack을 입구로 쓰고, NestJS 백엔드가 자연어 요청을 분류해 여러 작업 생성기로 넘겨요. 그날 할 일을 정리하거나 PR 리뷰를 만들고 업무 로그를 쓰는 작업에는 비용이 직접 발생하지 않아요. 결과가 마음에 들지 않으면 버리거나 다시 만들면 돼요.

비용이 드는 작업까지 맡기려면 실행 이력을 남기는 계층과 Slack 승인 UI, Prisma 데이터 모델이 달라져야 해요. 외부 SaaS에서 유료 작업을 만들거나 결제 수단이 붙은 API를 호출하고 예약·구매 같은 irreversible action을 위임한다면 승인 버튼은 mandate를 만드는 버튼이 되어야 해요. 자연어 라우터는 “무슨 일을 하고 싶은지” 파악할 수 있어도 최종 consent는 Slack modal이나 웹 콘솔 같은 non-agentic 화면에서 받아야 해요.

다만 내 시스템에는 Merchant, Credential Provider, Merchant Payment Processor 역할이 없어서 AP2 전체를 구현할 수 있는 위치는 아니에요. 지금 할 수 있는 일은 내부 증거 모델을 “AP2 compatible하게” 설계하는 데 가까워요. 외부 결제사나 merchant가 AP2 receipt를 돌려주지 않는다면 receipt 테이블에는 내부 실행 결과와 외부 API confirmation id를 임시로 담게 돼요. 그것을 AP2 receipt라고 부르면 안 돼요.

가장 단순한 대안은 Slack 버튼으로 승인받는 거예요. 구현이 빠르고 UX도 익숙하지만 승인 범위가 문자열 설명에 묶이므로 실제로 실행한 checkout과 승인 당시의 금액, 결제 권한의 범위를 별도 규칙으로 확인해야 해요.

다른 선택지는 AP2 서명 포맷을 완전히 구현하지 않더라도 checkout hash, payment scope, expiration, receipt reference를 먼저 각각의 도메인 객체로 분리하는 거예요. 초기 구현량이 늘고 UI도 복잡해지지만 나중에 AP2 호환 merchant나 credential provider가 생겼을 때 내부 모델을 갈아엎을 가능성이 줄어들어요. 지금 얻는 것은 결제 연동이 아니라 감사 가능한 승인 구조예요.

비용이 들지 않고 재시도하기 쉬운 작업에는 이 모델이 과해요. 사용자가 매번 화면을 보고 즉시 승인하는 단순 내부 자동화라면 signed mandate까지는 필요 없을 수 있어요. AP2식 모델은 “사람이 없는 동안 조건부로 실행된다”, “금전·권한·분쟁 책임이 걸린다”, “외부 주체가 검증해야 한다” 중 하나 이상에 해당할 때 값이 생겨요.

## 공개된 구현과 남은 확인 작업

AP2에는 공개 specification과 flows, 공식 GitHub 저장소, Python SDK generated model, Python·Go·Android sample이 있어요. README에는 sample이 ADK와 Gemini 3.1 Flash Lite Preview를 사용하지만 AP2 자체가 그것들을 요구하지는 않는다고 적혀 있어요. PyPI package는 나중에 publish할 예정이며 현재는 GitHub에서 직접 설치하는 명령을 안내해요.

```shell
uv pip install git+https://github.com/google-agentic-commerce/AP2.git@main
```

문서와 샘플은 공개돼 있지만 TypeScript/NestJS 백엔드에서 바로 쓸 안정적인 SDK가 있다고 보기는 어려워요. 공식 저장소의 샘플을 읽고 JSON schema나 generated model을 참고해 직접 모델링해야 하는 단계예요. 결제사별 운영 관행과 dispute handling에서 실제로 어떤 evidence를 받아들이는지, production-grade verifier 패턴은 아직 직접 확인해야 해요.

FIDO Alliance는 agentic authentication과 agentic commerce 표준화를 위한 워킹그룹을 발표했고 Google의 AP2와 Mastercard의 Verifiable Intent를 초기 technical contribution으로 언급했어요. 단일 회사의 데모에만 머무르지는 않는다는 신호지만 표준이 완성됐다는 뜻은 아니에요. 지금은 내 시스템의 승인·감사 모델을 AP2 vocabulary로 점검하는 단계가 맞아요.

다음에는 Slack modal과 웹 콘솔 중 어느 화면이 mandate content를 정확히 렌더링하고 서명 경계를 만들 수 있는지 비교하려고 해요. 이어 Prisma에 CheckoutMandate, PaymentMandate, Receipt 초안을 만들고 에이전트 실행 이력이 mandate hash로 연결되는지 확인할 계획이에요. 결제 연동은 그다음이에요.

## 참고한 출처

- Google Cloud Blog, “Announcing Agent Payments Protocol (AP2)”
- AP2 Specification v0.2, Roles / Agentic vs Non-Agentic Roles / Mandates
- AP2 Flows, Human Present / Human Not Present examples
- google-agentic-commerce/AP2 GitHub repository README and generated Python models
- FIDO Alliance, “FIDO Alliance to Develop Standards for Trusted AI Agent Interactions”
