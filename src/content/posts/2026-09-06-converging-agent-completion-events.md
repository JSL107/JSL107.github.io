---
title: "worker가 모델을 기다리는 동안 책임이 흐려져요"
description: "Slack 봇은 3초 안에 답해야 하는데 모델은 몇 분을 씁니다. 그 사이를 worker가 붙잡고 있으면 타임아웃·취소·중복이 한 실행에 뒤엉켜요. 완료를 이벤트로 받아 내부 상태에 한 번만 모으는 구조를 정리했습니다."
pubDatetime: 2026-09-06T19:05:00+09:00
category: backend
---

Slack 명령은 빨리 끝나야 하는데 에이전트의 일까지 금세 끝나지는 않아요. PR 리뷰를 만들라는 명령이 들어오면 서버는 곧바로 접수 응답을 돌려주고 실제 리뷰 생성은 뒤에서 이어가는데, 작업 큐(BullMQ)의 worker가 모델 호출을 시작하면 수십 초에서 길게는 몇 분 동안 프로세스를 붙잡거든요. 문제는 그동안 worker timeout과 모델 실행 실패, 네트워크 단절, 사용자 취소가 한데 섞인다는 점이에요.

그럼 worker는 무엇을 책임지는 걸까요? 모델이 끝났는지 확인하는 일일까요, 아니면 결과를 한 번만 저장하는 일일까요. 둘을 같은 실행에 묶어 두면 어느 쪽이 실패했는지 나중에 가릴 수 없어요.

**Background Responses**는 모델 실행을 등록만 하고 빠져나오는 방식이고, **webhook completion pattern**은 그 실행이 끝났다는 사실을 provider가 알려주는 방식이에요. 둘을 합치면 worker는 답을 기다리는 곳이 아니라 실행을 등록하고 완료 이벤트를 모으는 곳이 돼요. 비동기 호출 자체보다 **완료 이벤트를 내부 상태에 정확히 반영하는 일**이 어려운 부분이고, 이 글은 거기에 초점을 둡니다.

**아래는 OpenAI 공식 문서와 예제를 2026년 9월 6일에 읽고 정리한 것이고, 붙여서 돌려본 결과가 아니에요.** 마지막 절에 적었듯 지금 제 시스템은 이 패턴의 전제부터 충족하지 못합니다.

## worker가 오래 기다릴 때 흐려지는 책임

Slack 기반 에이전트에서 첫 번째 병목은 대개 HTTP 생명주기예요. Slack은 slash command 확인 응답을 3000밀리초 안에, interaction payload 확인 응답도 3초 안에 받기를 요구하니 사용자에게 "처리 중" 메시지를 먼저 보여줘야 하고, 그래서 Slack 진입점이 요청을 받아 실행 기록을 만든 뒤 작업 큐의 worker가 모델 라우터를 통해 모델을 호출하는 구조가 자연스러워요.

모델 실행이 길어질수록 worker는 사실상 원격 job의 생명주기를 대신 맡아요. 그런데 worker가 실제로 다룰 수 있는 건 로컬 프로세스와 타임아웃, 재시도 횟수뿐이에요. 정작 확인해야 하는 것은 provider가 요청을 완료했는지, 결과를 한 번만 저장했는지, 이미 취소된 실행에 성공 메시지를 보내지 않았는지인데, 성격이 다른 관심사가 한 실행에 묶여 있는 셈이죠.

Background mode는 이 구조를 provider run 단위로 나눠요. Responses API 요청에 `background: true`를 주면 호출자는 Response 객체와 상태를 받은 뒤 바로 빠져나오고, 상태가 `queued`나 `in_progress`인 동안에는 retrieve로 확인하거나 webhook을 기다려요. 내부 실행 기록도 더는 worker의 함수 호출과 1:1로 묶이지 않아요. 실행 기록 하나가 외부 `response.id` 하나를 참조하고, 완료 이벤트가 들어오면 결과를 저장하는 구조가 되는 거죠.

## 긴 요청을 짧은 등록으로 바꾸기

첫 단계에서는 Responses 생성 요청에 `background: true`를 넣어요. 공식 예시는 긴 소설 생성을 입력으로 들지만, 이 자리는 PR 리뷰나 업무 로그, 그날의 계획처럼 reasoning 시간이 길어질 수 있는 모델 호출에 해당해요.

```javascript
import OpenAI from "openai";

const client = new OpenAI();

const resp = await client.responses.create({
  model: "gpt-5.6",
  input: "Write a very long novel about otters in space.",
  background: true,
});

console.log(resp.status);
```

코드는 공식 Node SDK(`openai` npm 패키지) 기준이고, 확인 시점의 최신 릴리스는 v7.10.0(2026-09-03)이에요. 뒤에서 쓰는 `client.webhooks.unwrap`도 이 버전 소스에 들어 있고요. 다만 설치해서 실행해 본 건 아니라, 손에 있는 설치본에 같은 메서드가 있는지는 각자 버전을 확인해야 해요.

중요한 건 입력 문장이 아니라 `background: true` 한 줄이에요. Slack 에이전트라면 input 자리에 PR diff, GitHub task 목록, 전일 계획, 사용자 요청 같은 prompt 재료가 들어가고, worker는 응답 본문을 기다리지 않고 `resp.id`와 초기 `resp.status`를 실행 기록에 남긴 뒤 종료해도 돼요.

상태는 retrieve로 확인해요. `queued`와 `in_progress`는 아직 끝나지 않은 상태이고, 이 둘을 벗어난 `completed`·`failed`·`cancelled`·`incomplete`가 내부 종료 상태로 매핑할 후보가 되는데, provider가 준 상태를 화면에 그대로 보여주기보다 내부에 자체 상태를 두는 편이 안전해요. RUNNING·COMPLETED·FAILED·CANCELLED·INCOMPLETE로 나누고 provider status는 증거로 남기는 식이죠. Slack 메시지와 재시도, 감사로그가 전부 내부 상태를 기준으로 움직여야 하니까요.

```bash
curl https://api.openai.com/v1/responses/resp_123 \
-H "Content-Type: application/json" \
-H "Authorization: Bearer $OPENAI_API_KEY"
```

polling은 구현하기 쉽지만 장기 실행 에이전트가 동시에 늘어나면 주기적인 retrieve가 불필요한 부하를 만들어요. 정상 경로에는 webhook completion을 두고 polling은 보정 장치나 복구 경로로 남기는 편이 더 잘 맞아요.

## webhook은 결과를 찾으라는 신호다

webhook payload에는 정보가 많지 않아요. `response.completed` 이벤트가 모델 출력 전체를 싣는 대신 보통 `data.id`로 response id만 알려주거든요. webhook은 결과를 배달하는 게 아니라 **결과를 찾으러 가라는 신호**이고, 실제 내용은 retrieve로 가져오는 구조인 셈이죠.

```plain text
POST https://yourserver.com/webhook
user-agent: OpenAI/1.0 (+https://platform.openai.com/docs/webhooks)
content-type: application/json
webhook-id: wh_685342e6c53c8190a1be43f081506c52
webhook-timestamp: 1750287078
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=

{
  "object": "event",
  "id": "evt_685343a1381c819085d44c354e1b330e",
  "type": "response.completed",
  "created_at": 1750287018,
  "data": {
    "id": "resp_abc123"
  }
}
```

그래서 수신부 handler가 할 일은 셋으로 좁혀져요. 서명을 검증하고, `webhook-id`를 delivery 중복 제거 키로 저장하고, `data.id`를 기준으로 결과를 가져올 job을 큐에 넣은 뒤 2xx를 돌려주는 거예요. 여기서 retrieve와 DB 저장, Slack 게시까지 처리하면 webhook endpoint가 다시 장기 작업을 떠안게 되니까요.

OpenAI webhook은 Standard Webhooks 사양을 따르며 핵심 헤더는 `webhook-id`, `webhook-timestamp`, `webhook-signature`예요. 공식 SDK에는 raw body와 headers를 받아 서명 검증과 JSON parse를 함께 처리하는 `client.webhooks.unwrap(body, headers, options?)` helper가 있고요. 서명 검증 대상은 파싱된 JSON 객체가 아니라 전달된 본문 바이트열이라서, NestJS처럼 body parser가 앞에 붙는 프레임워크에서는 이 endpoint만 raw body를 보존해야 해요.

실행 조건도 하나 짚어 둘게요. webhook endpoint는 provider 대시보드의 webhook 설정 페이지에서 이름과 공개 URL, 받을 이벤트 종류를 지정해 등록하고 그 자리에서 서명 검증에 쓸 signing secret을 받아요. 공식 Node SDK는 그 값을 `OPENAI_WEBHOOK_SECRET` 환경변수나 클라이언트 생성 옵션, 또는 함수 인자로 받고요.

## at-least-once 이벤트에서는 중복을 먼저 설계해야 한다

at-least-once는 같은 완료가 두 번 이상 도착할 수 있다는 뜻이에요. 그래서 이 패턴에서 정말 까다로운 건 이벤트를 받는 일이 아니라 **같은 완료를 한 번만 반영하는 일**이에요. OpenAI는 endpoint가 2xx를 반환하지 않거나 몇 초 안에 응답하지 않으면 재시도하는데, 재시도 간격을 점점 벌리는 exponential backoff로 이어지고 최대 72시간까지 계속될 수 있어요. 3xx redirect도 성공으로 처리하지 않고요. 그러니 handler는 느리거나 redirect 뒤에 숨어서는 안 되고, 실패를 애매하게 삼켜서도 안 돼요.

중복 제거 키는 두 겹으로 둬야 해요. 첫 번째는 delivery 단위로, 이미 처리한 `webhook-id`라면 같은 HTTP delivery를 다시 처리하지 않아요. 두 번째는 resource 단위로, `response_id`에 연결된 내부 실행이 이미 종료 상태라면 뒤늦게 온 이벤트로 Slack 게시나 근거 기록 저장을 반복하지 않아요. 이 두 겹이 없으면 같은 완료 이벤트 때문에 업무 로그나 PR 리뷰가 두 번 게시될 수 있거든요.

순서도 기대하지 않는 편이 맞아요. 완료·실패·취소 계열 이벤트가 체감되는 순서는 네트워크와 재시도의 영향을 받으니, webhook event type은 명령이 아니라 provider 쪽에서 관측한 상태 변화로 받아야 해요. 내부 상태 전이는 현재 상태를 읽고 허용된 전이인지 확인한 뒤에 수행하고요. COMPLETED에서 COMPLETED로 가는 전이는 아무 일도 하지 않는 것으로 두고, CANCELLED에서 COMPLETED로 갈 때는 결과를 저장하더라도 사용자 성공 알림은 막는 정책이 필요해요.

## 취소에서는 사용자와의 약속이 우선이다

background response에는 cancel endpoint가 있어요. 실행 중인 response id에 cancel을 요청할 수 있고, 같은 요청을 두 번 보내도 최종 Response 객체를 반환하는 idempotent 동작을 해요.

```bash
curl -X POST https://api.openai.com/v1/responses/resp_123/cancel \
-H "Content-Type: application/json" \
-H "Authorization: Bearer $OPENAI_API_KEY"
```

그런데 애플리케이션의 취소 범위는 provider cancel보다 넓어요. 사용자가 Slack에서 요청을 취소하면 가능할 때 provider 실행도 멈춰야 하고, 늦게 성공 결과가 오더라도 사용자에게 성공처럼 게시하지 않겠다는 약속까지 지켜야 하거든요. 취소 요청 직전에 모델 실행이 끝나 완료 이벤트가 뒤늦게 도착하는 경합이 실제로 생길 수 있어요.

그래서 내부 상태가 우선이에요. 사용자 요청으로 실행이 CANCELLED가 됐다면 이후 `response.completed`가 와도 Slack 성공 메시지로 이어지면 안 돼요. retrieve 결과를 감사 목적으로 저장할지, 폐기할지, "취소 이후 도착한 provider 종료 이벤트"로 기록할지는 정책에 달렸고요. 핵심은 사용자 관점의 종료 상태와 provider 관점의 종료 상태를 같은 것으로 보면 안 된다는 점이에요.

## 감사로그를 provider 저장소에 맡길 수 없는 이유

Background mode에서는 결과 보존도 따로 설계해야 해요. 여기 나오는 `store`는 응답을 provider 쪽에 저장할지 정하는 요청 옵션이고, Zero Data Retention과 Modified Abuse Monitoring은 provider 프로젝트의 데이터 취급 설정 유형이에요. Zero Data Retention 프로젝트는 background 요청이 `store=false`로 실행돼도 비동기 실행과 polling을 위해 response data를 대략 10분 동안 임시 저장할 수 있어요. Modified Abuse Monitoring 프로젝트에서도 background response는 `store=true`를 명시한 경우에만 polling 기간 이후까지 보존되고, store를 생략하거나 false로 두면 대략 10분 뒤 삭제될 수 있고요.

10분이면 충분할까요? 감사로그로 쓰기엔 턱없이 짧아요. 업무 자동화 시스템의 결과는 몇 달 뒤에도 어떤 근거로 어떤 답을 냈는지 확인할 수 있어야 하니까요. 업무 로그를 쓰는 워커나 PR 리뷰를 만드는 워커, 그날 할 일을 정리하는 워커가 낸 산출물이 전부 여기 해당해요.

여기서 말한 10분은 위 두 설정의 프로젝트에 걸린 조건이지만, 보존 기간을 provider가 정한다는 사실 자체는 설정과 무관해요. 그러니 provider 쪽 retrieve 가능 시간에 기대면 안 돼요. 결과를 가져오는 job은 retrieve하자마자 필요한 출력과 provider run id, 종료 이벤트 시각, 원본 상태를 내부 DB에 복사해야 해요.

실행 기록에 필요한 필드도 provider run id 하나로 끝나지 않아요. 외부 response id, 마지막으로 받은 delivery id 또는 별도 delivery 테이블, 종료 이벤트 수신 시각, provider 종료 상태, retrieve 성공 여부가 최소한 필요하거든요. delivery id를 실행 기록의 단일 필드에 두면 마지막 것만 남아 중복 delivery를 72시간 동안 막기 어려워요. 그래서 delivery 중복 제거는 별도 저장소로 빼고, 실행 기록에는 provider run과 내부 상태 전이에 필요한 요약만 남기는 편이 자연스러워요.

## 모든 에이전트에 필요한 패턴은 아니다

이 구조에 직접 닿는 자리는 넷이에요. Slack 진입점이 빠른 접수 응답과 진행 중 메시지를 맡고, 실행 기록이 내부 상태와 근거를 관리하고, 모델 라우터가 실행 시작과 결과 가져오기를 나누고, webhook 수신부가 provider 이벤트를 내부 job으로 넘기는 얇은 진입점이 되는 셈이죠.

다만 잘 맞는 작업은 제한적이에요. 출력과 reasoning 시간이 길고 Slack에 최종 결과를 게시하는 작업, 그러니까 PR 리뷰를 만들거나 업무 로그를 쓰거나 그날 할 일을 정리하는 쪽이 후보예요. 반대로 자연어에서 날짜와 기간만 뽑아내는 데만 LLM을 쓰고 계산은 규칙에 맡기는 짧은 작업에는 과하고요.

주의할 조합도 있어요. 이미 GitHub webhook으로 자동 트리거되는 작업에 이 패턴을 더하면 이벤트 출처가 둘이 돼요. 그런 작업은 OpenAI webhook을 붙이기 전에 중복 제거 키와 추적 id 설계부터 정리해야 해요.

## 그런데 제 시스템은 전제부터 안 맞아요

가장 큰 전제는 Responses API를 직접 호출하는 provider가 있어야 한다는 점이에요.

제 시스템은 그렇지 않아요. 모델 실행이 **구독형 CLI를 자식 프로세스로 띄우는 방식**으로 감싸져 있고 API 키를 쓰지 않거든요. 그러면 background response id를 받을 수도 없고 webhook을 받을 대상도 없어요. 이 상태에서는 작업 큐의 worker가 실행을 붙잡고 있는 지금 구조가 여전히 현실적인 선택이에요.

도입하려면 모델 라우터에 Responses API background provider를 별도 경로로 추가하고 작업 하나부터 opt-in해야 해요. 그 전에는 이 글의 나머지가 전부 그림일 뿐이고요.

## 그래도 남는 것: 상태 전이표

전제가 안 맞아도 이 정리에서 남는 게 있어요. 필드 몇 개를 더하는 문제가 아니라 **상태 전이를 먼저 적어야 하는 문제**라는 걸 알게 됐거든요.

provider run id와 delivery id, 종료 이벤트 시각 세 필드를 실행 기록에 추가하는 것만으로는 부족해요. delivery id는 중복 제거 이력을 위해 별도 테이블이 필요할 가능성이 높고, 종료 이벤트에는 completed뿐 아니라 failed·cancelled·incomplete도 들어오고, 내부 상태가 이미 종료일 때 어떤 이벤트를 폐기하고 어떤 이벤트를 감사로그에만 남길지도 정해야 해요.

webhook endpoint의 raw body 보존 방식과 빠른 2xx 처리 정책도 같이 정해야 하고요. 서명 검증 실패를 어떻게 기록할지, 결과 가져오기 job을 큐에 넣는 데 실패했을 때 2xx를 돌릴지 5xx로 재시도시킬지도 결정해야 해요. 이 기준이 있어야 Slack 진입점과 실행 기록, webhook 수신부가 같은 완료 이벤트를 같은 의미로 해석하거든요.

결국 이 패턴의 목적은 worker를 빨리 끝내는 데 있지 않아요. **provider 실행과 사용자에게 약속한 실행 상태를 분리하고**, 중복과 순서 역전, 취소 경합, 제한된 보존 기간 속에서도 완료 이벤트를 한 번만 내부 상태로 모으는 데 있어요.

다음에 해볼 만한 걸 하나 남겨요. 지금 쓰는 시스템에서 긴 작업 하나를 골라 **상태 전이표를 손으로 적어 보세요.** 「이미 취소된 실행에 완료가 도착하면」 칸이 비어 있다면, 그 칸이 이 글에서 말한 경합이 실제로 지나가는 자리예요.

## 재보기 전에 확인 계약부터 적어 둔다

그 표를 제 쪽에서 적으면 이렇게 되는데, 앞의 결정들은 아직 제 손으로 재본 게 아니에요. 그래서 무엇을 어떤 기준으로 확인할지만 미리 고정해 둘게요.

확인할 항목은 도입부에서 꺼낸 문제와 같은 축이에요. 같은 delivery 식별자가 두 번 도착해도 Slack 게시가 1건인지, 이미 취소된 실행에 완료 이벤트가 도착해도 성공 알림이 0건인지. 둘 다 아직 측정하지 않았어요.

확인 환경은 webhook을 받을 수 있는 로컬 endpoint와 대시보드에서 발급받은 서명 시크릿을 둔 상태예요. 입력은 두 가지로, 같은 `webhook-id`를 가진 delivery를 다시 보내는 것과 취소 요청 뒤에 완료 이벤트를 도착시키는 것이고요. 지표는 Slack 게시 횟수와 실행 기록의 내부 상태 둘만 봐요.

전후 비교도 정량 지표가 아니라 이진 값으로 해요. 지금처럼 worker가 실행을 붙잡는 구조와 이 패턴을 붙인 구조를 놓고, 중복 게시가 발생하는지와 취소 후 성공 알림이 발생하는지 두 가지만 견주는 거죠. 어느 쪽도 아직 재보지 않았으니 아래 표는 측정 결과가 아니라 기대값을 적어 둔 계약이에요.

| 입력 | 기대 내부 상태 | 기대 사용자 알림 |
| --- | --- | --- |
| 같은 `webhook-id` delivery 재도착 | 첫 delivery의 처리 결과 유지, 상태 전이 없음 | 없음(첫 게시 1건만) |
| CANCELLED 실행에 `response.completed` 도착 | CANCELLED 유지, provider 종료 상태는 증거로만 기록 | 성공 알림 없음 |
| 결과 가져오기 job 큐 적재 실패 | RUNNING 유지, 종료 상태로 넘기지 않음 | 없음(성공·실패 알림 모두 보류) |
| 서명 검증 실패 | 실행 상태 변화 없음, 검증 실패 사실만 기록 | 없음 |
| 수신부 재시작 직후 같은 delivery 재전송 | 중복 제거 저장소 조회로 재처리 없음 | 없음 |

표의 마지막 두 줄은 아직 확정하지 못한 부분을 안고 있어요. 큐 적재 실패에 2xx를 돌릴지 5xx로 재시도를 유도할지는 정하지 못했고, 재시작 경계에서 중복 제거 저장소가 어느 범위까지 살아 있어야 하는지도 미확인이에요.

## 출처

제품 동작과 제한은 문서 확인 시점에 따라 달라질 수 있어요. 확인일은 자료마다 표에 적었어요.

| 제목 | 자료 링크 | 본문 주장 대응 | 확인일 |
| --- | --- | --- | --- |
| Implementing slash commands / Handling user interaction in your Slack apps | [슬래시 명령](https://docs.slack.dev/interactivity/implementing-slash-commands) · [상호작용 처리](https://docs.slack.dev/interactivity/handling-user-interaction) | slash command 확인 응답의 3000밀리초 제한과 `response_url` 지연 응답, interaction payload 확인 응답의 3초 제한 | 2026-09-08 |
| Background mode | [직접 링크](https://developers.openai.com/api/docs/guides/background) | `background: true` 로 등록 후 즉시 반환, `queued`·`in_progress` 상태, retrieve와 cancel endpoint의 idempotent 동작, ZDR·Modified Abuse Monitoring 프로젝트의 10분 임시 보존 | 2026-09-06 |
| Webhooks | [직접 링크](https://developers.openai.com/api/docs/guides/webhooks) | payload가 `data.id` 만 싣는 구조, 2xx 미반환 시 exponential backoff 재시도와 최대 72시간, 3xx 를 성공으로 보지 않음, 대시보드 webhook 설정 페이지에서 이름·공개 URL·이벤트 종류로 endpoint 를 등록하고 signing secret 을 받는 절차 | 2026-09-06(등록 절차는 2026-09-08 확인) |
| webhooks.unwrap | [직접 링크](https://developers.openai.com/api/reference/resources/webhooks/methods/unwrap) | raw body 와 headers 를 받아 서명 검증과 파싱을 함께 처리하는 helper | 2026-09-06 |
| openai-node v7.10.0 | [릴리스](https://github.com/openai/openai-node/releases/tag/v7.10.0) · [webhooks 소스](https://github.com/openai/openai-node/blob/v7.10.0/src/resources/webhooks/webhooks.ts) | 코드 예시가 기준으로 삼은 공식 Node SDK 와 확인 시점의 최신 릴리스 버전, 해당 버전에 `unwrap` 이 있다는 점, signing secret 을 `OPENAI_WEBHOOK_SECRET` 환경변수·클라이언트 옵션·함수 인자로 받는다는 점 | 2026-09-08 |
| Standard Webhooks 사양 | [직접 링크](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) | `webhook-id`·`webhook-timestamp`·`webhook-signature` 세 헤더, 서명 대상이 본문 바이트열이라는 점 | 2026-09-06 |
| Guide to OpenAI webhooks | [직접 링크](https://hookdeck.com/webhooks/platforms/guide-to-openai-webhooks-features-and-best-practices) | at-least-once 전달에서 delivery 단위와 resource 단위로 중복 제거를 두 겹 두는 관행(1차 출처가 아닌 해설 자료) | 2026-09-06 |
| New tools and features in the Responses API | https://openai.com/index/new-tools-and-features-in-the-responses-api | background mode 도입 배경. **확인 시점에 자동 요청이 403 으로 막혔다** — 보조 자료이고, 위 공식 문서만으로 본문의 모든 주장을 확인할 수 있다 | 2026-09-06 |
