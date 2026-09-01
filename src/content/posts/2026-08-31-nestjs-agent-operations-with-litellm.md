---
title: "NestJS 에이전트의 모델 운영 경계를 LiteLLM으로 분리할 수 있을까"
description: "credential, budget, rate limit, fallback, 비용 추적을 LiteLLM으로 넘기는 경계를 그려보고, CLI 구독으로 모델을 부르는 지금 구조에는 왜 그대로 붙지 않는지까지 짚는다."
pubDatetime: 2026-08-31T19:13:00+09:00
category: backend
---

## 모델 라우팅이 코드 안에 있을 때 생기는 운영 문제

Slack 명령 하나가 LLM 호출 한 번으로 끝난다면 모델 라우팅을 코드에 넣어도 큰 문제는 없어요. pm 에이전트에는 이 모델, code-reviewer에는 저 모델을 쓰고, 실패하면 예외를 던져요. 배포 전에 테스트하고 문제가 생기면 다시 고치면 돼요.

에이전트가 늘어나면 상황이 달라져요. agent/pm은 매일 계획을 만들고, agent/work-reviewer는 업무 로그를 요약해요. agent/code-reviewer는 PR diff를 읽어요. router가 자연어 멘션을 받아 worker를 고르는 흐름도 생겨요. agent/be-sre, agent/be-test, agent/impact-reporter, ops-supervisor, autopilot 같은 장기 실행 흐름까지 붙으면 “어떤 모델을 쓸까?”보다 더 중요한 질문이 생겨요.

어떤 에이전트가 비용을 많이 쓰는지, 어떤 Slack workspace에서 실패가 잦은지를 알아야 해요. rate limit이 provider 문제인지 특정 agent의 폭주인지도 구분해야 하고요. 실패했을 때 같은 품질의 모델로만 fallback할지, 싼 모델로 내려갈지도 정해야 하죠. 이런 판단을 매번 NestJS 코드의 ModelRouterUsecase에 넣고 배포로 푸는 건 느려요.

LiteLLM AI Gateway가 필요한 자리가 여기예요. 앱 안의 라우팅 로직을 전부 없애자는 뜻은 아니에요. NestJS는 지금 실행 중인 agentRun과 AgentType을 계속 관리하고, 결과를 EvidenceRecord에 어떻게 남길지도 책임져요. provider credential, 모델 alias, virtual key, budget, rate limit, fallback, spend log는 앱 밖의 gateway로 옮기고요.

## LiteLLM은 SDK보다 Proxy Server로 보는 편이 맞다

LiteLLM 문서는 Python SDK와 Proxy Server를 함께 설명해요. SDK는 여러 provider를 completion() 인터페이스로 호출하고, 응답은 OpenAI Chat Completions 형식에 맞춰 받아요. 공식 문서와 GitHub README는 OpenAI, Anthropic, Gemini, Azure, Bedrock, Vertex AI, Ollama 등 100개 이상의 provider를 OpenAI 형식으로 호출할 수 있다고 강조해요.

NestJS 에이전트 시스템에는 SDK보다 Proxy Server가 더 중요해요. Proxy는 FastAPI 기반 gateway처럼 앱과 provider 사이에 서서, 앱이 OpenAI 호환 API 하나만 알면 되도록 만들어요. 실제 provider key와 모델 매핑은 LiteLLM 쪽에 남고요. Docker quickstart를 쓰면 gateway는 http://localhost:4000에 뜨고, Admin UI는 /ui에서 열어요.

문서의 JavaScript 예시를 보면 이 구조가 잘 드러나요. OpenAI SDK는 그대로 쓰고 baseURL만 LiteLLM으로 바꿔요.

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:4000",
  apiKey: "sk-",
});

const response = await client.chat.completions.create({
  model: "gpt-5.5",
  messages: [{ role: "user", content: "Say hello in five words." }],
});

console.log(response.choices[0].message.content);
```

NestJS에서는 이 점이 가장 큰 장점이에요. ModelRouterUsecase가 provider별 SDK를 직접 알 필요가 줄어요. 앱은 pm-agent, work-reviewer, code-reviewer, router-worker 같은 gateway model alias를 호출해요. alias가 실제로 연결할 provider와 모델은 LiteLLM 설정이나 Admin UI에서 바꿀 수 있어요.

기존에는 “AgentType → provider”를 바꿀 때마다 코드를 배포했어요. LiteLLM을 쓰면 앱은 “AgentType → gateway alias”까지만 알아요. 이후의 provider 운영 정책은 gateway가 맡거든요.

## 그런데 내 시스템은 SDK로 모델을 부르지 않는다

여기까지 정리해 두고 내 코드를 다시 열어봤어요. 도입의 전제가 되는 바로 그 부분이 맞지 않았어요.

내 NestJS 에이전트 시스템은 HTTP API SDK로 모델을 호출하지 않아요. codex CLI를 자식 프로세스로 spawn하고 프롬프트를 stdin으로 넘겨요. 인증도 API key가 아니라 구독 계정의 OAuth 세션이에요. 그러니까 ModelRouterUsecase는 provider SDK를 감싼 어댑터가 아니라 CLI 프로세스를 감싼 어댑터예요.

LiteLLM Proxy는 API key를 들고 오는 HTTP 요청을 앞에서 받아 중계하는 물건이에요. CLI가 자기 세션으로 곧장 provider에 나가는 호출은 그 앞에 세울 수가 없어요. baseURL을 바꿔 끼울 자리 자체가 없으니까요.

붙이려면 CLI spawn을 API 호출로 갈아타야 해요. 이건 클라이언트 라이브러리를 하나 교체하는 일이 아니에요. 정액 구독으로 쓰던 호출을 토큰 종량 과금으로 옮기는 결정이죠. 비용을 들여다보려고 gateway를 세우는데 그 도입 자체가 비용을 올리는 방향이라면, 계산은 거기서부터 시작해야 맞아요. 지금 구독으로 한 달에 얼마를 쓰는지, 같은 호출량을 API로 옮기면 얼마가 되는지. 이 두 숫자가 나오기 전까지 아래 이야기는 전부 “그럴 수 있다면”이라는 가정 위에 서 있어요.

그래서 이 글의 나머지는 도입기가 아니라 설계 메모예요. 언젠가 종량제로 옮길 때 다시 꺼내 볼 경계선을 미리 그려두는 쪽에 가까워요.

## Docker, salt key, virtual key가 첫 번째 운영 경계다

LiteLLM Docker quickstart는 간단해요. 공식 문서에 나온 명령을 실행하면 LiteLLM gateway와 Postgres가 함께 떠요. Postgres는 models, virtual keys, spend logs를 저장하는 데 써요.

```bash
curl -sSL https://docs.litellm.ai/docker-compose.yml | docker compose -f - up -d
```

quickstart는 빠르게 시작하기 위한 구성이지만, 운영 전에는 LITELLM_SALT_KEY를 꼭 확인해야 해요. 문서에 따르면 이 값은 provider API key를 암호화하는 데 쓰여요. quickstart compose에는 placeholder가 들어 있어요. 계속 운영할 환경이라면 긴 random 값으로 바꾸고 이후에는 변경하면 안 돼요. 값을 바꾸면 기존에 암호화한 credential을 복호화할 수 없으니까요.

다음으로 살펴볼 경계는 master key와 virtual key예요. virtual key 문서에 따르면 key management에는 Postgres DATABASE_URL과 master key가 필요해요. master key는 Proxy Admin key 역할을 하며 sk-로 시작해야 해요. 설정 파일의 general_settings.master_key에 넣거나 LITELLM_MASTER_KEY 환경변수로 줄 수 있어요.

문서의 virtual key 생성 예시는 master key로 /key/generate를 호출해요. 아래는 문서 원문의 모델명과 식별자를 내 쪽 alias로 바꿔 적은 형태예요.

```bash
curl 'http://0.0.0.0:4000/key/generate' \
  --header 'Authorization: Bearer <MASTER_KEY>' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "models": ["code-reviewer", "be-schema"],
    "metadata": {"user": "agent-code-reviewer"}
  }'
```

중요한 점은 raw provider key가 NestJS 앱으로 들어오지 않는다는 거예요. 앱은 LiteLLM virtual key만 가져요. virtual key에는 접근 가능한 model list, budget, rate limit 같은 제약을 걸 수 있어요. key owner나 team에 연결하면 spend도 key, user, team 단위로 추적할 수 있죠.

에이전트 시스템을 설계할 때는 virtual key를 어떻게 나눌지 먼저 정해야 해요. pm-agent, work-reviewer, code-reviewer, router-worker처럼 agent 계열별로 key를 나누면 budget과 rate limit을 분리하기 쉬워요. 하나의 service key를 쓰고 request의 user나 metadata.tags로만 나누는 방법도 있어요. 배포와 secret 관리는 단순해지지만, key 자체를 운영 경계로 삼기는 어려워요.

처음에는 하나의 service key와 metadata.agentType으로 시작하는 편이 현실적이에요. 비용이 큰 agent부터 virtual key를 따로 나누면 돼요. code-reviewer, work-reviewer, router-worker처럼 호출량과 token 사용량이 클 수 있는 경로는 초기부터 분리 후보로 보는 게 좋아요.

## Spend log는 AgentRun과 연결할 수 있어야 의미가 있다

LiteLLM cost tracking 문서는 spend가 자동으로 추적되는 조건을 분명히 밝혀요. Proxy에 database와 virtual key를 설정하고 요청을 proxy로 보내면 돼요. known model의 비용은 LiteLLM의 model cost map을 기준으로 계산해요. 비용은 response header의 x-litellm-response-cost에서 확인할 수 있어요. database의 LiteLLM_SpendLogs와 UI의 Usage tab에서도 볼 수 있죠.

문서의 cURL 예시는 user와 metadata.tags를 함께 보내요. 필드 이름은 그대로 두고 값만 내 시스템 식별자로 옮겨 적으면 이렇게 돼요.

```bash
curl --location 'http://0.0.0.0:4000/chat/completions' \
  --header 'Content-Type: application/json' \
  --header 'Authorization: Bearer <VIRTUAL_KEY>' \
  --data '{
    "model": "code-reviewer",
    "messages": [
      {
        "role": "user",
        "content": "아래 PR diff를 리뷰해줘"
      }
    ],
    "user": "agent-code-reviewer",
    "metadata": {
      "tags": [
        "agentType:CODE_REVIEWER",
        "agentRunId:01K3QF7A2M4V",
        "trigger:slack-command"
      ]
    }
  }'
```

이 값들은 spend log에 그대로 남아요. 실제 사람이나 고객을 식별하는 값을 넣으면 비용 기록이 곧 개인정보 저장소가 되니까, 처음부터 내부 식별자만 넣는 편이 좋아요. 여기서 중요한 건 필드의 형태예요. user는 end user/customer 단위 추적에 쓰고, metadata.tags는 tag 기반 spend tracking에 써요. 다만 문서는 metadata.tags 기반 custom tag spend tracking을 Enterprise로 표시해요.

NestJS에서는 이 필드를 AgentRun과 맞춰야 해요. 내부에 agentRunId, agentType, slackTeamId 같은 값이 있다면 요청 metadata나 tag에도 같은 값을 넣어요. 그래야 LiteLLM spend log와 내부 EvidenceRecord를 나중에 join할 수 있거든요.

“이번 주 code-reviewer 비용이 왜 튀었는가”를 확인할 때는 LiteLLM의 model_group, token count, spend를 함께 봐요. 내부의 PR diff 크기, 실패 사유, retry 기록도 같이 확인할 수 있어요.

이 연결이 없으면 gateway는 비용 대시보드에 그쳐요. 연결해 두면 에이전트 운영 로그가 돼요.

## Fallback은 안정성 기능이지만 품질 정책이기도 하다

LiteLLM reliability 문서에서 fallback은 provider failover를 뜻해요. 호출이 num_retries 이후에도 실패하면 다른 model group으로 넘겨요. fallback은 정해진 순서대로 시도해요. 일반 오류에는 fallbacks를 쓰고, content policy 위반에는 content_policy_fallbacks를 써요. context window 초과에는 context_window_fallbacks를 쓰며, default_fallbacks도 설정할 수 있어요.

Proxy 설정 예시는 router_settings.fallbacks를 두는 방식이에요.

```yaml
model_list:
  - model_name: gpt-3.5-turbo
    litellm_params:
      model: azure/<deployment-name>
      api_base: <azure-endpoint>
      api_key: <azure-api-key>
      rpm: 6

  - model_name: gpt-4
    litellm_params:
      model: azure/gpt-4-ca
      api_base: https://my-endpoint-canada-berri992.openai.azure.com/
      api_key: <azure-api-key>
      rpm: 6

router_settings:
  fallbacks: [{"gpt-3.5-turbo": ["gpt-4"]}]
```

이 설정은 편리해요. NestJS 코드에 retry와 provider switch를 길게 작성할 필요가 없으니까요. 다만 에이전트에서는 주의해야 해요. fallback은 “성공률”을 높일 수 있지만 “같은 결과 품질”까지 보장하지는 않아요.

이건 남의 얘기가 아니에요. 내 시스템도 한동안 provider를 여러 곳 두고 한쪽이 실패하면 반대편으로 넘겼어요. 지금은 그 경로를 걷어냈어요. 6월에 한 곳, 7월에 나머지 한 곳을 라우팅에서 빼고 단일 provider로 고정했어요. 이제 route()는 primary가 실패하면 재시도 없이 예외를 그대로 올려요. 어댑터 코드는 롤백에 대비해 남겨 뒀지만 부르는 경로는 없어요.

대신 실패를 감추지 않는 쪽에 힘을 줬어요. 사용량 한도에 걸린 거라면 한도를 넘겼다는 사실과 리셋 시각을 Slack 메시지에 함께 붙여 내려요.

넘어간 쪽이 성공하더라도 결과의 성격이 달라지면 그 실행 기록은 나중에 서로 비교가 안 돼요. 성공률 그래프는 예뻐지는데 “지난주 리뷰가 왜 이렇게 무뎠지”를 되짚을 근거는 사라지죠. 돌아보면 fallback을 걷어낸 자리에서 얻은 건 안정성이 아니라 해석 가능성이었어요. LiteLLM의 fallback을 켤 때도 같은 질문을 먼저 통과해야 한다고 봐요. 이 agent의 실행 기록은 모델이 바뀌어도 같은 의미로 읽히는가.

agent/vacation처럼 자연어 파라미터만 추출하는 작업은 fallback 범위를 넓혀도 괜찮을 수 있어요. agent/code-reviewer, agent/be-schema, agent/review-reply-judge처럼 판단 품질이 결과물의 신뢰도와 직결되는 agent는 후보를 좁혀야 해요. context window 초과 fallback도 같아요. 긴 PR diff를 더 큰 context 모델로 넘기는 건 자연스러워요. 더 작은 모델로 줄이면 눈에 띄지 않는 품질 회귀가 생길 수 있어요.

테스트 방식도 주의해야 해요. reliability 문서에 따르면 LiteLLM Proxy v1.85.0부터 mock-testing flag가 incoming Proxy request에서 제거돼요. mock_testing_fallbacks, mock_testing_context_fallbacks, mock_testing_content_policy_fallbacks는 효과가 없어요. Proxy fallback을 검증하려면 비운영 환경에서 실제 provider error를 일으켜야 해요. 이후 정상 요청으로 동작을 확인해야 해요.

## 로그와 거버넌스는 기본값을 먼저 확인해야 한다

LLM gateway를 세우면 모든 요청이 한곳을 지나가요. 관측성은 좋아지지만, 민감한 prompt와 response도 한곳에 모일 수 있죠.

LiteLLM UI Logs 문서는 기본값을 분명히 설명해요. success logs와 error logs는 기본으로 tracked 돼요. request/response content는 기본으로 저장하지 않아요. 저장하려면 store_prompts_in_spend_logs로 opt-in해야 해요. 기본적으로 prompt와 response 본문을 남기지 않으니 안전한 기본값에 가까워요.

prompt 저장을 켜면 실패한 에이전트 실행의 실제 입력을 UI에서 볼 수 있어요. 업무 데이터나 개인정보, credential fragment가 prompt에 섞일 수 있다면 먼저 꺼두는 게 맞아요. 공개 저장소에 붙일 수 없는 데이터도 마찬가지예요. config의 litellm_settings.turn_off_message_logging은 messages/responses logging을 막고 metadata는 남기는 용도로 설명돼요.

로그 retention도 확인해야 해요. UI Logs 문서는 spend logs를 저장한다면 오래된 로그를 주기적으로 지우라고 권해요. 설정 예시로 maximum_spend_logs_retention_period: "7d"와 maximum_spend_logs_retention_interval: "1d"를 들어요.

LiteLLM은 open-source gateway예요. Admin UI, virtual key, spend tracking, fallback 같은 운영 기능을 제공해요. 팀별 logging을 비롯한 일부 기능은 문서에 Enterprise only 또는 Enterprise feature로 표시돼요. “tag별 비용 slice까지 당장 무료로 다 된다”고 가정하면 안 돼요. 먼저 OSS에서 가능한 범위와 Enterprise 범위를 나눠 확인해야 해요.

## 눈에 덜 띄는 실행부터 예산을 걸어야 한다

model-router와 agent-run 쪽 경계는 앞에서 짚었으니, 아직 안 나온 두 곳만 덧붙일게요.

하나는 slack과 router예요. Slack slash command에서는 사용자가 오래 기다리지 않게 해야 해요. 앞에 gateway가 한 겹 서면 고장 날 수 있는 자리도 한 겹 늘어나니까, gateway 장애와 provider 장애를 구분해 메시지를 내려야 하고요. router는 자연어 멘션을 여러 worker로 dispatch해요. worker별로 virtual key나 alias를 나눠 두면 폭주한 worker만 골라서 rate limit으로 막을 수 있어요.

다른 하나는 자동 실행 계열이에요. autopilot, ops-supervisor, study-brief-cron이 여기에 들어가요. resume-calibration-cron, job-application-nudge-cron도 마찬가지죠. 사람이 직접 부르지 않으니 예산 경계가 더 중요한데, 정작 interactive command보다 눈에 덜 띄어요. 새벽에 조용히 돌다가 한참 뒤 청구서로 알게 되는 쪽이 여기예요. 별도 virtual key나 team으로 묶고 max budget과 RPM/TPM을 낮게 잡고 시작하는 편이 안전해요.

정리하면 이래요. LiteLLM은 provider credential, budget, rate limit, fallback, spend log를 맡고 NestJS는 AgentRun의 맥락과 EvidenceRecord를 지켜요. 에이전트별 허용 모델 범위와 품질 정책까지 gateway가 정해 주지는 않으니, 경계를 이렇게 긋고 두 쪽 기록을 연결해야 gateway가 단순한 모델 중계기를 넘어 운영 계층이 돼요.

다만 내 경우엔 그 앞에 숙제가 하나 남아요. 지금은 CLI 프로세스로 모델을 부르고 있어서 이 그림이 그대로 얹히지 않아요. 그러니 다음에 할 일은 LiteLLM을 띄워보는 게 아니라, 구독으로 쓰는 지금 호출량을 종량 기준으로 환산해 보는 거예요. 그 숫자가 나오면 이 메모를 다시 꺼내면 돼요.

참고한 공식 출처:

- https://docs.litellm.ai/docs
- https://docs.litellm.ai/docs/proxy/docker_quick_start
- https://docs.litellm.ai/docs/proxy/virtual_keys
- https://docs.litellm.ai/docs/proxy/cost_tracking
- https://docs.litellm.ai/docs/proxy/reliability
- https://docs.litellm.ai/docs/proxy/ui_logs
- https://docs.litellm.ai/docs/proxy/config_settings
- https://github.com/BerriAI/litellm
