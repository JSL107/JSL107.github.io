---
title: "완료 이벤트를 수렴하는 에이전트 실행 구조"
description: "장기 모델 실행을 worker의 대기 작업에서 분리하고, webhook 완료 이벤트를 내부 상태로 안전하게 수렴하는 구조를 살펴본다."
pubDatetime: 2026-09-06T19:05:00+09:00
category: backend
---

Slack 명령은 빨리 끝나야 해도 에이전트의 일까지 금세 끝나는 건 아니에요. 사용자가 /review-pr 같은 명령을 보내면 서버는 곧바로 ack를 돌려주고, 실제 리뷰 생성은 뒤에서 이어가요. BullMQ worker가 모델 호출을 시작하면 수십 초, 길게는 몇 분 동안 프로세스를 붙잡아요. 이때 worker timeout, 모델 실행 실패, 네트워크 단절, 사용자 취소가 한데 섞이거든요.

Background Responses와 webhook completion pattern은 이 경계를 새로 그어요. worker는 모델의 답을 기다리는 곳이 아니라 모델 실행을 등록하고 완료 이벤트를 모으는 곳이 돼요. 장기 실행은 OpenAI Responses API의 background job이 맡고, 시스템은 response.id와 webhook delivery, retrieve, cancel, 내부 감사로그를 관리해요. 비동기 호출 자체보다 완료 이벤트를 내부 상태에 정확히 반영하는 일이 핵심이에요.

## worker가 오래 기다릴 때 흐려지는 책임

Slack 기반 에이전트에서 첫 번째 병목은 대개 HTTP 생명주기예요. Slack은 slash command나 interaction에 빠른 ack를 기대하니까 사용자에게는 "처리 중" 메시지를 먼저 보여줘야 해요. slack 모듈이 요청을 받고 agent-run이 실행 이력을 만든 뒤, BullMQ worker가 model-router를 통해 모델을 호출하는 구조가 자연스러워요.

모델 실행이 길어질수록 worker는 사실상 원격 job의 생명주기를 대신 맡아요. worker가 다룰 수 있는 건 로컬 프로세스와 타임아웃, 재시도 횟수예요. 실제로는 provider가 요청을 완료했는지, 결과를 한 번만 저장했는지 확인해야 해요. 이미 취소된 run에 성공 메시지를 보내지 않았는지도 살펴야 하는데, 성격이 다른 관심사가 한 실행에 묶여 있어요.

Background mode는 이 구조를 provider run 단위로 나눠요. Responses API 요청에 background: true를 주면 호출자는 Response 객체와 상태를 받은 뒤 바로 빠져나와요. 상태가 queued 또는 in_progress인 동안에는 retrieve로 확인하거나 webhook을 기다려요. 내부 AgentRun도 더는 worker의 함수 호출과 1:1로 묶이지 않아요. AgentRun 하나가 외부 response.id 하나를 참조하고, 완료 이벤트가 들어오면 결과를 저장하는 구조가 되는 거죠.

## 긴 요청을 짧은 등록으로 바꾸기

첫 단계에서는 Responses 생성 요청에 background: true를 넣어요. OpenAI 예시는 긴 소설 생성을 입력으로 들지만, 이 자리는 PR 리뷰나 업무 로그, daily plan처럼 reasoning 시간이 길어질 수 있는 model-router 호출에 해당해요.

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

중요한 건 입력 문장이 아니라 background: true예요. Slack 에이전트의 input에는 PR diff, GitHub task 목록, 전일 계획, 사용자 요청 같은 prompt 재료가 들어가요. worker는 응답 본문을 기다리지 않고 resp.id와 초기 resp.status를 agent-run에 남긴 뒤 종료해도 돼요.

상태는 retrieve로 확인해요. queued와 in_progress는 아직 끝나지 않은 상태이고, 나머지는 내부 terminal state로 매핑할 후보가 돼요. OpenAI status를 화면에 그대로 보여주기보다 내부 AgentRun에 자체 상태를 두는 편이 안전해요. RUNNING, COMPLETED, FAILED, CANCELLED, INCOMPLETE로 나누고 provider status는 증거로 남겨요. Slack 메시지와 재시도, 감사로그가 내부 상태를 기준으로 움직여야 하니까요.

```bash
curl https://api.openai.com/v1/responses/resp_123 \
-H "Content-Type: application/json" \
-H "Authorization: Bearer $OPENAI_API_KEY"
```

polling은 구현하기 쉽지만 장기 실행 agent가 동시에 늘어나면 주기적인 retrieve가 불필요한 부하를 만들어요. 정상 경로에는 webhook completion을 두고, polling은 보정 장치나 복구 경로로 남기는 편이 더 잘 맞아요.

## webhook은 결과를 찾으라는 신호다

OpenAI webhook의 payload에는 정보가 많지 않아요. response.completed 이벤트가 모델 출력 전체를 싣는 대신, 보통 data.id로 response id를 알려줘요. webhook delivery는 작고 빠르게 처리하고 실제 결과는 retrieve로 가져오는 구조예요.

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

webhook 모듈의 handler는 서명을 검증하고 webhook-id를 delivery idempotency key로 저장해요. 이어서 data.id를 기준으로 결과 hydrate job을 BullMQ에 넣고 2xx를 돌려줘요. 여기서 OpenAI retrieve와 DB 저장, Slack 응답 게시까지 처리하면 webhook endpoint가 다시 장기 작업을 떠안게 되니까요.

OpenAI webhook은 Standard Webhooks 사양을 따르며, 핵심 헤더는 webhook-id, webhook-timestamp, webhook-signature예요. 공식 SDK에는 raw body와 headers를 받아 서명 검증과 JSON parse를 함께 처리하는 client.webhooks.unwrap(body, headers, options?) helper가 있어요. 서명 검증 대상은 파싱된 JSON 객체보다 전달된 본문 바이트열에 가까워서 raw body가 필요해요.

NestJS에서는 body parser를 거친 객체만 handler에 넘기지 않도록 이 endpoint의 raw body를 보존해야 해요.

## at-least-once 이벤트에서는 중복을 먼저 설계해야 한다

Webhook completion pattern은 이벤트 수신보다 같은 완료를 한 번만 반영하는 일이 더 까다로워요. OpenAI는 endpoint가 2xx를 반환하지 않거나 몇 초 안에 응답하지 않으면 재시도해요. 재시도는 exponential backoff로 이어지고 최대 72시간까지 계속될 수 있어요. 3xx redirect도 성공으로 처리하지 않아요.

webhook handler는 느리거나 redirect 뒤에 숨어서는 안 되고, 실패를 애매하게 삼켜서도 안 돼요.

idempotency key는 두 겹으로 둬야 해요. 첫 번째는 delivery 단위로, 이미 처리한 webhook-id라면 같은 HTTP delivery를 다시 처리하지 않아요. 두 번째는 resource 단위로, response_id에 연결된 내부 AgentRun이 이미 terminal 상태라면 뒤늦게 온 이벤트로 Slack 게시나 EvidenceRecord 저장을 반복하지 않아요.

이 두 겹이 없으면 같은 완료 이벤트 때문에 업무 로그나 PR 리뷰가 두 번 게시될 수 있거든요.

ordering도 기대하지 않는 편이 맞아요. 완료, 실패, 취소 계열 이벤트가 체감되는 순서는 네트워크와 재시도의 영향을 받아요. webhook event type은 명령이 아니라 provider 쪽에서 관측한 상태 변화로 받아야 해요. 내부 상태 전이는 현재 AgentRun 상태를 읽고 허용된 전이인지 확인한 뒤 수행해요.

COMPLETED에서 COMPLETED로 가는 전이는 noop으로 두고, CANCELLED에서 COMPLETED로 갈 때는 결과를 저장하더라도 사용자 성공 알림은 막는 정책이 필요해요.

## 취소에서는 사용자와의 약속이 우선이다

background response에는 cancel endpoint가 있어요. 실행 중인 response id에 cancel을 요청할 수 있고, 같은 요청을 두 번 보내도 최종 Response 객체를 반환하는 idempotent 동작을 해요.

```bash
curl -X POST https://api.openai.com/v1/responses/resp_123/cancel \
-H "Content-Type: application/json" \
-H "Authorization: Bearer $OPENAI_API_KEY"
```

애플리케이션의 취소 범위는 provider cancel보다 넓어요. 사용자가 Slack에서 요청을 취소하면 가능할 때 provider 실행도 멈춰야 해요. 늦게 성공 결과가 오더라도 사용자에게 성공처럼 게시하지 않겠다는 약속도 지켜야 해요. provider 취소와 completed webhook 사이에는 race가 생길 수 있으니까요. cancel 요청 직전에 모델 실행이 끝나고 completed 이벤트가 뒤늦게 도착할 수도 있어요.

그래서 내부 상태가 우선이에요. 사용자 요청으로 AgentRun이 CANCELLED가 됐다면 이후 response.completed가 와도 Slack 성공 메시지로 이어지면 안 돼요. retrieve 결과를 감사 목적으로 저장할지, 폐기할지, "cancel 이후 도착한 provider terminal event"로 기록할지는 정책에 달렸어요. 사용자 관점의 terminal state와 provider 관점의 terminal state를 같은 것으로 보면 안 돼요.

## 감사로그를 provider 저장소에 맡길 수 없는 이유

Background mode에서는 결과 보존도 따로 설계해야 해요. Zero Data Retention 프로젝트는 background 요청이 store=false로 실행돼도 비동기 실행과 polling을 위해 response data를 대략 10분 동안 임시 저장할 수 있어요. Modified Abuse Monitoring 프로젝트에서도 background response는 store=true를 명시한 경우에만 polling 기간 이후까지 보존돼요. store를 생략하거나 false로 두면 대략 10분 뒤 삭제될 수 있거든요.

Slack 업무 자동화 시스템의 결과는 나중에도 어떤 근거로 어떤 답을 냈는지 확인할 수 있어야 해요.

여기에는 agent/work-reviewer가 만든 업무 로그와 agent/code-reviewer가 만든 PR 리뷰가 들어가요. agent/pm이 만든 daily plan도 같은 기준으로 확인할 수 있어야 해요.

OpenAI 쪽 retrieve 가능 시간에만 기대면 감사로그가 비어 버릴 수 있어요. webhook hydrate job은 response를 retrieve하자마자 필요한 출력, provider run id, terminal event 시각, 원본 상태를 내부 DB와 EvidenceRecord에 복사해야 해요.

agent-run에 필요한 필드는 providerRunId 하나로 끝나지 않아요. 외부 response id, 마지막으로 받은 webhook delivery id 또는 별도 delivery table, terminal event 수신 시각, provider terminal status, retrieve 성공 여부가 최소한 필요해요. webhookDeliveryId를 AgentRun의 단일 필드에 두면 마지막 delivery만 남아 중복 delivery를 72시간 동안 막기 어려워요.

delivery dedupe는 webhook 모듈의 별도 저장소로 빼고, AgentRun에는 provider run과 내부 상태 전이에 필요한 요약을 남기는 편이 자연스러워요.

## 모든 에이전트에 필요한 패턴은 아니다

이 구조에 직접 닿는 모듈은 agent-run, model-router, slack, webhook이에요.

slack은 빠른 ack와 진행 중 메시지를 맡고, agent-run은 내부 실행 상태와 EvidenceRecord를 관리해요. model-router는 background provider의 시작과 결과 hydrate를 나눠야 해요. webhook은 provider event를 받아 내부 job으로 넘기는 얇은 진입점이 되는 셈이죠.

이 방식에 잘 맞는 agent는 제한적이에요.

출력과 reasoning 시간이 길어질 수 있고 Slack에 최종 결과를 게시하는 작업이 후보예요. agent/code-reviewer, agent/work-reviewer, agent/pm이 여기에 들어가요. agent/be, agent/be-schema, agent/be-sre도 같은 후보예요.

agent/vacation처럼 자연어 파라미터 추출 정도에만 LLM을 쓰는 짧은 작업에는 과해요. agent/issue-labeler나 agent/be-fix처럼 이미 GitHub webhook 자동 트리거와 맞물린 작업은 event source가 두 개가 돼요. 이런 작업은 OpenAI webhook을 더하기 전에 dedupe key와 trace id 설계부터 정리해야 해요.

가장 큰 전제는 OpenAI Responses API를 직접 호출하는 provider가 있어야 한다는 점이에요.

현재 모델 실행이 CLI 구독 기반으로 감싸져 있고 API key를 쓰지 않는 구조라면 background response id나 OpenAI webhook을 받을 수 없어요. 이런 상태에서는 BullMQ worker를 붙잡는 구조가 여전히 현실적인 선택이에요.

도입하려면 model-router에 Responses API background provider를 별도 경로로 추가하고 해당 agent부터 opt-in해야 해요.

## 구현은 상태 전이표에서 시작한다

AgentRunService.execute에 providerRunId, webhookDeliveryId, terminalEventReceivedAt 세 필드만 추가해서는 충분하지 않아요. delivery id는 중복 제거 이력을 위해 별도 테이블이 필요할 가능성이 높아요. terminal event에는 completed뿐 아니라 failed, cancelled, incomplete도 들어올 수 있어요. 내부 상태가 이미 terminal일 때 어떤 이벤트를 폐기하고, 어떤 이벤트를 감사로그에만 남길지도 정해야 해요.

webhook endpoint의 raw body 보존 방식과 빠른 2xx 처리 정책도 함께 정해야 해요.

NestJS에서 OpenAI webhook endpoint만 raw body를 보존할 수 있는지 확인해야 해요. 서명 검증 실패를 어떻게 기록할지도 정해야 해요. retrieve job enqueue에 실패했을 때 2xx를 돌릴지, 5xx로 재시도시킬지도 결정해야 해요. 이 기준이 있어야 agent-run, webhook, slack이 같은 완료 이벤트를 같은 의미로 해석해요.

결국 이 패턴의 목적은 worker를 단순히 빨리 끝내는 데 있지 않아요. provider 실행과 사용자에게 약속한 실행 상태를 분리하고, 중복과 순서 역전, 취소 race, 제한된 보존 기간 속에서도 완료 이벤트를 한 번만 내부 상태로 모으는 데 있어요.

참고 자료:

- https://developers.openai.com/api/docs/guides/background
- https://developers.openai.com/api/docs/guides/webhooks
- https://developers.openai.com/api/reference/resources/webhooks/methods/unwrap
- https://openai.com/index/new-tools-and-features-in-the-responses-api
- https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
- https://hookdeck.com/webhooks/platforms/guide-to-openai-webhooks-features-and-best-practices
