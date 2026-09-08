---
title: "외부 작업을 재시도하기 전에 상태부터 확인해야 하는 이유"
description: "timeout 뒤에도 외부 write는 성공했을 수 있으므로 postcondition 검증, idempotency key, receipt를 결합해 중복 부작용을 막아야 한다."
pubDatetime: 2026-09-04T09:00:00+09:00
category: backend
---

timeout은 응답을 받지 못했다는 뜻일 뿐, 외부 작업이 실패했다는 증거는 아니에요. Slack 기반 에이전트 실행기를 살펴보면서, 실패 여부가 애매할 때 곧바로 재시도하지 말고 실제 상태부터 확인해야 하는 이유를 정리해 볼게요. 외부 write가 섞인 큐·webhook 재처리 경로를 다루는 백엔드 개발자를 독자로 생각하고 썼고, 범위는 논문과 벤더 문서로 개념을 정리한 뒤 제 시스템에 어떻게 적용할지 계획을 세우는 데까지예요. 실제로 적용해서 측정한 수치는 이 글에 없어요.

## 타임아웃 뒤에 이미 메시지는 나갔을 수 있다

Slack에서 이벤트를 받으면 워커가 큐에 잡을 넣고, 에이전트는 작업을 마친 뒤 사용자에게 메시지를 보내요. 그런데 Slack Events API는 이벤트 요청에 3초 안에 HTTP 2xx로 응답하라고 요구하고, 그 시간을 넘기면 `http_timeout`을 이유로 같은 이벤트를 최대 세 번까지 다시 보내요. 큐 쪽에서도 비슷한 일이 생겨요. 제가 쓰는 BullMQ는 Redis 위에서 도는 Node.js 작업 큐인데, 워커가 진행 중이라는 신호를 계속 보내지 못한 잡을 stalled로 판정해 waiting 목록으로 되돌리고 다시 처리해요. 다만 무엇을 실패로 볼지와 몇 번까지 되돌릴지는 큐 구현과 설정에 따라 달라서, 재처리가 일어나는 조건은 쓰는 큐의 문서로 확인해야 해요. 어느 쪽이든 애플리케이션에서는 “실패했으니 다시 실행”하는 흐름이 자연스러워 보여요.

문제는 외부 세계가 그렇게 깔끔하게 움직이지 않는다는 데 있어요. 첫 번째 실행에서 메시지를 보내는 Slack Web API 메서드인 `chat.postMessage` 요청이 이미 Slack 서버에 도착했을 수도 있고, DB row가 만들어졌거나 GitHub comment가 생성됐을 수도 있어요. 다만 내 프로세스가 그 사실을 확인하기 전에 timeout, crash, retry가 끼어드는 거죠. 이 상태에서 두 번째 실행을 시작하면 복구가 아니라 부작용을 중복으로 일으키게 돼요.

Slack Events API 문서만 봐도 이런 상황은 정상적인 운영 조건이에요. 재시도 시도 번호와 이유는 HTTP header에도 함께 담겨요. “같은 이벤트가 다시 들어올 수 있다”는 상황은 예외가 아니라 계약에 포함된 동작인 셈이에요.

```plain text
x-slack-retry-num: 1
x-slack-retry-reason: http_timeout
```

Events API callback payload에는 중복을 감지할 때 쓸 수 있는 `event_id`가 들어 있어요. 아래 예시에서 중복 판정에 쓰는 필드는 최상위 `event_id` 하나예요. `event.type`이나 `team_id`는 어떤 이벤트가 어느 워크스페이스에서 왔는지만 알려 줘서 같은 이벤트의 재전달을 구분하지 못하고, `event_ts`와 `event_time`은 발생 시각이라 이미 처리한 이벤트인지 판단하는 기준으로 쓰기 어려워요. 그래서 처리한 `event_id`를 따로 기록해 두고 새로 들어온 값과 대조하는 방식이 돼요.

```json
{
  "type": "event_callback",
  "token": "XXYYZZ",
  "team_id": "T123ABC456",
  "api_app_id": "A123ABC456",
  "event": {
    "type": "name_of_event",
    "event_ts": "1234567890.123456",
    "user": "U123ABC456"
  },
  "event_context": "EC123ABC456",
  "event_id": "Ev123ABC456",
  "event_time": 1234567890,
  "authorizations": [
    {
      "enterprise_id": "E123ABC456",
      "team_id": "T123ABC456",
      "user_id": "U123ABC456",
      "is_bot": false,
      "is_enterprise_install": false
    }
  ],
  "is_ext_shared_channel": false,
  "context_team_id": "T123ABC456",
  "context_enterprise_id": null
}
```

여기서 중요한 질문은 “retry를 할까 말까”가 아니에요. “retry 전에 이미 원하는 상태가 되었는지 확인했는가”예요.

## Tool call은 원자적이지 않다

arXiv 논문 “Verified Tool Calls Improve LLM Agent Reliability Under Non-Atomic Failures”는 LLM agent의 tool call을 (a, r, S, S′)로 나타내요. a는 agent가 보낸 action, r은 tool response, S는 실행 전 실제 상태, S′는 실행 후 실제 상태예요. 원자적인 tool이라면 response r이 S → S′ 상태 전이를 충실하게 알려 줘요.

하지만 실제 API, DB, queue, webhook은 그렇게 동작하지 않아요. 논문에서는 이 차이를 response channel과 effect channel이 분리된 것으로 설명해요. response channel은 agent가 확인한 응답이고, effect channel은 외부 시스템에서 실제로 일어난 변경이에요. timeout이 발생했다는 건 response channel이 끊겼다는 뜻일 뿐, effect channel에서 아무 일도 일어나지 않았다는 뜻은 아니에요.

논문은 non-atomic failure를 네 가지로 나눠요.

- **Timeout-After-Dispatch**: 요청이 서버에서 처리되기 시작했거나 이미 완료됐지만, 응답이 agent에게 도착하기 전에 timeout이 발생하는 경우예요.
- **Delayed Visibility**: write는 성공했지만 eventual consistency 때문에 검증 read에서는 이전 상태가 보이는 경우예요. eventual consistency는 쓴 값이 모든 읽기 경로에 즉시 나타나지 않고 시간이 지나면서 반영되는 성질이에요.
- **Partial Success**: 복합 작업 가운데 일부만 반영됐는데도 API가 성공한 것처럼 보이는 경우예요.
- **Stale Conflicts**: agent가 상태를 확인한 뒤 다른 프로세스가 같은 상태를 바꾸면서, 원래 유효했던 action이 더는 유효하지 않게 되는 경우예요.

기존 retry 방식은 이런 차이를 구분하지 않아요. 실패 응답이나 timeout, 응답 없음이 모두 “다시 호출”로 이어져요. LLM agent에서는 위험이 더 커져요. 모델은 자연어 reasoning을 바탕으로 다음 행동을 고르지만, 외부 시스템에서 작업이 일부라도 성공했는지는 직접 알 수 없거든요. 재시도 정책을 prompt에 맡기면 안 되는 이유예요. 모델에게 “조심해서 다시 시도해”라고 지시하기보다 application layer와 infrastructure layer에 명확한 복구 규칙을 두는 편이 맞아요.

## Verify-before-retry는 retry 앞에 read를 끼운다

논문에서 제안한 방법은 Verified Tool Wrapper이며, effect-response separation, verify-before-retry, idempotent execution이라는 세 가지 원칙을 따라요.

첫째, effect-response separation은 응답을 실제 상태를 입증하는 확실한 증거로 여기지 않아요. 둘째, verify-before-retry는 실패 여부가 애매할 때 바로 재호출하지 않고 postcondition verifier부터 실행해요. postcondition은 작업이 끝났다면 반드시 성립해야 하는 조건이고, verifier는 외부 상태를 읽어 그 조건이 성립하는지 판정하는 코드예요. 셋째, idempotent execution은 retry가 필요할 때 같은 logical operation에 같은 idempotency key를 붙여 중복 효과를 줄여요.

논문에 실린 알고리즘은 다음과 같은 흐름으로 진행돼요.

```plain text
Algorithm 1 Verified Tool Call

Require: action a, verifier V, idempotency key k, max retries N
Ensure: success or failure

execute(a, key=k)
for i = 1 to N do
  response ← get_response(a)
  if response == SUCCESS then
    return success
  end if
  if response == FAILURE (definitive) then
    return failure
  end if
  if response == AMBIGUOUS then
    wait(backoff(i))
    result ← V(current_state)
    if result == TRUE then
      return success
    else if result == UNKNOWN then
      continue
    else if result == FALSE then
      execute(a, key=k)
    end if
  end if
end for
return failure
```

verifier는 write를 하지 않고 read-only 방식으로 현재 상태를 확인한 뒤 TRUE, FALSE, UNKNOWN 중 하나를 반환해요. TRUE라면 이미 성공한 것이므로 retry하지 않아요. FALSE라면 의도한 상태가 없다고 판단해 retry할 수 있어요. UNKNOWN은 eventual consistency나 불충분한 관측 때문에 아직 결론을 내릴 수 없는 상태예요.

verifier가 단순히 존재 여부만 확인해서는 부족해요. 논문은 invoice 예시를 통해 `[row.exists]`만 확인하면 partial success를 성공으로 잘못 판단할 수 있다고 지적해요. `[row.exists]`는 논문 본문의 표기를 그대로 옮긴 것으로, 행이 존재하는지만 보는 조건을 뜻해요. postcondition은 “무언가 생겼다”가 아니라 “필요한 필드와 상태가 모두 맞다”여야 해요.

Stripe의 idempotency 문서는 이런 방향이 실제 API 계약에 어떻게 적용되는지 보여 줘요. Stripe는 idempotency key를 사용하면 같은 key로 들어온 첫 번째 요청의 status code와 response body를 저장하고, 이후 같은 key로 요청이 들어오면 같은 결과를 반환한다고 설명해요. HTTP에서는 Idempotency-Key header를 사용해요.

```bash
curl https://api.stripe.com/v1/customers \
  -u sk_test_YOUR_TEST_KEY: \
  -H "Idempotency-Key: KG5LxwFBepaKHyUD" \
  -d description="My First Test Customer (created for API docs at https://docs.stripe.com/api)"
```

`-u`에 들어간 값은 예시용 test key라, 그대로 실행하면 인증에서 막혀요. 자기 계정의 test key로 바꿔 넣어야 동작해요.

Stripe 문서는 key를 만들 때 UUID v4처럼 entropy가 충분한 값을 사용하라고 권장하며, key 길이는 255자까지 허용한다고 설명해요. key는 최소 24시간이 지나면 자동으로 제거될 수 있고, 제거된 뒤 같은 key를 다시 사용하면 새 요청으로 처리될 수 있어요. 원래 요청과 parameter가 다를 때는 accidental misuse를 막기 위해 오류를 반환해요. 벤더 문서의 이런 값은 언제든 바뀔 수 있으니, 255자와 24시간은 글 끝 출처 목록에 적은 확인 시점 기준으로 읽어 주세요.

이 원칙은 agent tool wrapper에도 그대로 적용돼요. retry를 안전하게 처리하려면 operation을 식별하는 key, 실행 결과를 추적하는 receipt, 최종 상태를 확인하는 postcondition이 필요해요. 이름이 비슷해서 헷갈리기 쉬운데, 셋은 각각 다른 것을 가리켜요. idempotency key는 Stripe처럼 외부 API가 같은 요청의 재시도를 알아보게 하려고 요청에 실어 보내는 값이고, operationKey는 제 시스템이 “이 실행과 저 실행이 같은 논리적 작업이다”라고 부르기 위해 내부에서 붙이는 식별자예요. 보통 operationKey를 재료로 삼아 그 작업에 쓸 idempotency key를 만들게 돼요. receipt는 그 작업을 실제로 실행하고 무엇을 만들었는지 내 쪽에 남기는 기록이에요. 논문에는 postcondition과 idempotency key가 나오지만 receipt라는 말은 없어서, receipt는 제가 이 기록을 부르는 이름이에요.

## Durable execution은 같은 문제의 다른 면이다

key와 receipt와 postcondition을 다 갖춰도 남는 질문이 하나 있어요. 그 셋은 재시도가 들어왔을 때 판단할 근거를 만들어 주지만, 실행하던 프로세스가 중간에 재시작되면 어디까지 진행했는지에 대한 기억은 무엇이 들고 있을까요. 이 질문을 정면으로 다루는 쪽이 durable execution이에요.

Diagrid의 AI agents 문서는 agent 실행을 durable workflow로 다루는 방식을 설명해요. reasoning step, LLM call, tool invocation을 workflow activity로 기록하고, 프로세스가 재시작되면 저장된 history를 replay해 마지막으로 완료한 activity 다음부터 실행을 이어 가요. 완료된 LLM call과 tool call은 다시 실행하지 않기 때문에 이미 사용한 token이 또 과금되지 않고, 외부 side effect도 중복되지 않는다고 문서에 나와 있어요.

이 방식은 verify-before-retry가 다루는 문제를 다른 층에서 해결해요. durable workflow는 “완료된 activity를 다시 발행하지 않는다”는 데 초점을 맞추고, verify-before-retry는 “완료 여부가 애매한 write를 재발행하기 전에 외부 상태를 확인한다”는 데 초점을 맞춰요. 둘은 서로 대체하기보다 보완하는 관계에 가까워요.

큐 기반 시스템에서는 activity history가 완벽하게 남지 않을 수 있어요. worker가 외부 API를 호출한 직후 죽거나 receipt를 저장하기 전에 프로세스가 종료될 수 있거든요. durable log만 보면 작업이 끝나지 않은 것처럼 보이지만, 외부 시스템에는 변경이 이미 반영됐을 수도 있어요. 그래서 receipt 저장과 postcondition verifier가 함께 필요해요.

## 언제나 쓰면 좋은 은탄환은 아니다

verify-before-retry에도 분명한 한계가 있어요. 논문은 controlled simulator와 두 개의 대표 workflow에서 실험했고, postcondition verifier도 hand-designed였다고 밝혀요. 그 환경에서 보고한 지표는 task success rate와 duplicate side effects rate 두 가지예요. activate_customer workflow에서는 wrapper를 씌운 agent가 모든 fault 수준에서 task success rate 100%를 유지한 반면 baseline은 low fault 92%에서 high fault 64%까지 떨어졌고, duplicate side effects rate는 baseline이 low·medium·high fault에서 각각 20%·44%·72%였는데 wrapper 쪽은 0%·16%·20%였어요. 다만 이 수치는 결함을 일부러 주입한 시뮬레이터에서 나온 값이고, 실제 production API에서 발생하는 다양한 인증 실패, rate limit, stale read와 불완전한 verifier까지 모두 다룬 것은 아니에요.

verifier가 틀리면 복구 정책 전체가 잘못돼요. 너무 느슨하면 partial success를 성공으로 판단하고, 너무 엄격하면 eventual consistency 때문에 아직 보이지 않는 성공을 실패로 판단해 retry를 일으켜요. postcondition은 “검증 가능한 업무 불변식”이어야 하며, 즉시 확인할 수 없는 시스템에서는 UNKNOWN, backoff, polling 같은 중간 상태를 둬야 해요.

모든 tool에 같은 수준으로 적용할 필요는 없어요. read-only tool이나 캐시 조회, pure computation처럼 side effect가 없는 작업에는 복잡한 wrapper가 지나칠 수 있어요. Slack 메시지 발송, DB 상태 변경, GitHub comment 생성, 결제·문자·이메일 발송처럼 외부 write가 발생하는 작업은 우선순위가 높아요.

## Slack 기반 에이전트 실행기에 대입하기

여기서부터는 아직 실행하지 않은 설계예요. 아래 계약을 코드로 옮겨 본 적이 없고, 중복이 실제로 얼마나 줄어드는지도 재 보지 않았어요. 그래서 이 절은 “이렇게 했더니 됐다”가 아니라 “이 순서로 확인해 보겠다”는 계획으로 읽어 주세요. 겪은 실패와 방향 전환을 적지 못하는 것도 같은 이유예요. 적용 전이라 시행착오가 아직 없고, 없는 사건을 만들어 넣는 대신 없다는 사실만 적어 둘게요.

아래에 나오는 이름은 모두 제 저장소의 모듈·디렉터리 이름이라 그대로 적어요. 이름만으로는 업무 데이터나 고객 정보가 드러나지 않고, 일반 명칭으로 바꾸면 어느 경계에서 무엇을 확인할지가 흐려지기 때문이에요.

이 개념을 내 시스템에 적용한다면 agent-run, prisma, slack, webhook부터 살펴볼 거예요. agent-run은 실행 lifecycle과 evidence를 모으는 모듈이라 logical operation의 receipt를 저장하기 좋아요. prisma는 DB 스키마와 접근 코드가 모여 있는 자리인데, Prisma는 이 프로젝트가 쓰는 ORM 이름이에요. 여기서는 unique key와 transaction을 이용해 “같은 operation은 한 번만 기록된다”는 local invariant를 만들 수 있어요. slack에서는 Events API의 event_id, retry header, message timestamp 같은 외부 증거를 다뤄야 해요. webhook은 GitHub나 Slack에서 같은 사건이 다시 들어오는 입구이므로 deduplication의 첫 관문이 돼요.

실제 write성 도구 가운데서는 slack 응답 발송, agent-run 상태 전이, github comment 또는 review 계열을 먼저 다루게 돼요. 세 경계에 무엇을 남기고 무엇을 확인할지 정리하면 이렇게 돼요.

| 대상 write | receipt로 남길 값 | postcondition |
|---|---|---|
| slack 응답 발송 | 같은 operationKey에 대응하는 Slack message receipt | receipt가 있으면 그것으로 판정하고, receipt가 없으면 intent에 남긴 channel과 operationKey marker로 최근 메시지를 조회해 가린다 |
| agent-run 상태 전이(DB) | Prisma unique key로 한 번만 기록되는 행 | 그 행의 최종 status field가 의도한 값이다 |
| github comment·review 생성 | 외부 객체 ID 또는 comment body에 넣은 식별 가능한 marker | 그 ID나 marker로 객체를 다시 찾을 수 있다 |

BullMQ 재처리와 Slack event retry를 따로 설계하면 같은 문제를 두 번 설계하는 셈이에요. 둘 다 “같은 logical operation이 다시 실행될 수 있다”는 하나의 문제이기 때문이에요. 그래서 실행을 다시 굴리는 슬래시 커맨드인 `/retry-run`, queue retry, webhook retry가 모두 같은 wrapper를 지나게 배선할 생각이에요. retry 여부도 모델이 아니라 adapter가 operationKey, receipt, postcondition verifier를 기준으로 결정하게 둘 거예요.

durable workflow를 함께 도입할지도 정해야 하는데, 지금 계획으로는 넣지 않아요. 재시도 입구가 Slack event 재전달, 큐 재처리, 수동 재실행 세 가지이고 셋 다 같은 wrapper를 지나게 만들 수 있어서, 문서를 읽고 판단한 기준으로는 workflow runtime을 새로 얹는 비용이 먼저 오지 않았어요. 대신 기준을 하나 적어 둘게요. 한 요청이 여러 LLM call과 tool call을 이어 붙여 중간부터 재개해야 하는 형태가 되면, 그때가 durable workflow를 다시 볼 지점이에요.

먼저 현재 write tool 목록에서 slack, github, prisma 경계를 훑어 “외부 상태를 바꾸는 adapter”만 추릴 거예요. 그런 다음 각 adapter의 postcondition을 한 줄로 적어요. 가령 “Slack 응답 발송 완료 = operationKey에 대응하는 message receipt가 있고, 필요한 경우 Slack 객체 식별자를 보유한다”처럼 실제로 검증할 수 있는 문장이어야 해요.

계약은 성공을 무엇으로 재는지까지 적어야 닫혀요. 저는 논문이 쓴 것과 같은 축으로 보려고 해요. 같은 operationKey에서 발생한 중복 부작용 건수, 그러니까 중복으로 나간 Slack 메시지와 comment 수를 세고, 재시도가 끼어든 실행의 최종 성공률을 함께 기록해 적용 전후를 비교하는 식이에요.

receipt를 저장하는 시점도 같이 정해요. 실행 전에 intent를 기록하고, 실행 후에 receipt를 저장하며, 실패 여부가 애매하면 verifier를 먼저 호출하는 순서예요. 이 순서가 깨지면 중복이 다시 생겨요. 이 흐름을 agent-run과 EvidenceRecord, 즉 실행 근거를 한 건씩 남기는 레코드에 녹여 두면 Slack retry, BullMQ retry, webhook 재전달을 하나의 복구 계약으로 다룰 수 있어요.

결국 안전한 retry는 실패 응답을 받은 작업을 다시 실행하는 기능이 아니에요. 같은 logical operation의 intent와 receipt를 남기고 postcondition으로 외부 상태를 확인한 뒤, 꼭 필요할 때만 같은 idempotency key로 재실행하는 복구 계약이에요.

참고한 출처예요. 발행일과 별개로, 아래 문서는 모두 2026년 9월 8일에 열어 본문에 인용한 내용을 확인했어요.

- Verified Tool Calls Improve LLM Agent Reliability Under Non-Atomic Failures (arXiv, HTML 렌더): https://arxiv.org/html/2608.02645v1 — HTML 경로가 열리지 않으면 초록 페이지 https://arxiv.org/abs/2608.02645 로 들어가 PDF를 받을 수 있어요. 두 경로 모두 확인했고, 본문에 옮긴 수치는 HTML 렌더 쪽에 있어요.
- Slack Events API, retries 절 (3초 응답 규칙, 재시도 횟수와 header): https://docs.slack.dev/apis/events-api/#retries
- Stripe API, Idempotent requests (idempotency key 길이 255자, 최소 24시간 보관, parameter 불일치 시 오류): https://docs.stripe.com/api/idempotent_requests
- Diagrid Catalyst, Durable workflows for AI agents (history replay와 완료된 activity 재발행 금지): https://docs.diagrid.io/concepts/ai-agents
- BullMQ, Stalled jobs (워커 신호가 끊긴 잡의 waiting 복귀와 maxStalledCount): https://docs.bullmq.io/guide/jobs/stalled
