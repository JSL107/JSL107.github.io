---
title: "장기 에이전트의 프롬프트 캐시 설계"
description: "반복 실행되는 장기 에이전트에서 안정적인 prefix를 설계하고 캐시 효과를 관측하는 방법을 정리한다."
pubDatetime: 2026-09-05T19:05:00+09:00
category: infra
---

## 반복 실행이 비싸지는 순간

Slack에서 에이전트를 한 번 실행할 때는 비용이 잘 눈에 띄지 않아요. /today, PR 리뷰, 업무 로그 초안을 한 번씩 실행하면 “프롬프트가 길다”는 느낌은 들어도 구조를 손볼 만큼 부담스럽지는 않아요. 문제는 이 실행이 매일, 매 PR마다, 여러 worker에서 반복될 때 생겨요.

장기 에이전트 시스템은 매번 전혀 새로운 질문을 받는 듯하지만, 실제로는 입력 앞부분이 자주 반복돼요. 역할 설명, 시스템 규칙, 도구 목록, 출력 형식, few-shot, 라우터 분류 기준, 장기 기억 요약이 여기에 들어가요. 사용자 입력, 오늘 날짜, GitHub diff, Slack channel, run id, 최근 이벤트처럼 매번 달라지는 내용은 따로 있어요.

처음에는 정확도가 중요해서 프롬프트에 내용을 계속 덧붙여요. “이 경우에는 이렇게 해라”, “저 경우에는 실패로 처리해라”, “이 포맷을 지켜라” 같은 규칙이 점점 늘어나요. 운영 단계에 들어서면 이 긴 앞부분을 매번 다시 계산해야 하는지 고민하게 돼요. 같은 system/developer instruction과 tool schema를 반복해서 쓴다면, 모델이 앞부분을 다시 처리하지 않는 구조를 만들 수 있으니까요.

프롬프트 캐싱은 단순히 “프롬프트를 짧게 쓰자”는 이야기가 아니라, 반복되는 앞부분을 안정적인 prefix로 설계하는 일에 가까워요. 장기 에이전트에서는 프롬프트도 실행 비용과 지연 시간에 영향을 주므로, prefix의 배치와 관측 방식까지 아키텍처로 다뤄야 해요.

## 프롬프트가 아니라 실행 계층을 최적화한다

프롬프트 캐싱은 좋은 답변을 얻기 위한 prompt engineering 기법이 아니에요. 모델이 입력을 처리하며 만든 중간 상태를 재사용해서, 같은 prefix를 다시 계산하지 않도록 실행 계층을 최적화하는 방식이에요.

OpenAI 문서는 prompt caching을 “requests share the same prompt prefix”일 때 이전 계산을 재사용하는 기능이라고 설명해요. 모델은 입력 토큰을 처리하면서 attention에 필요한 key-value 상태를 만들고, 캐시는 이 prefix의 KV 상태를 재사용해요. 토큰 문자열 자체가 아니라 모델이 처리한 중간 상태를 저장하는 셈이에요. 그래서 “내 눈에 같은 문장인가”보다 “모델에 렌더링된 prefix가 같은가”가 더 중요하거든요.

이 차이는 실무에서 꽤 크게 작용해요. tool schema 순서나 structured output 설정이 바뀌고, developer message 앞쪽에 날짜가 들어가면 사람이 보기에는 작은 변화여도 cache hit에 영향을 줄 수 있어요. OpenAI 문서는 model, tools, parallel_tool_calls, text.format, reasoning.effort, text.verbosity, context_management 같은 설정도 cache reuse에 영향을 줄 수 있다고 설명해요.

Claude 문서도 같은 방향으로 설명해요. Claude의 prompt caching은 cache_control로 재사용 가능한 prefix의 끝을 표시해요. prompt 구조는 tools → system → messages 순서로 prefix를 만든다고 나와 있어요. 안정적인 tool 정의와 system instruction, 큰 배경 문서, 예시는 앞에 두고 매번 바뀌는 사용자 요청은 뒤에 두는 게 기본 전략이에요.

프롬프트 캐싱은 “문장을 조금 다듬는 일”에 그치지 않아요. prefix에 넣을 정보와 뒤로 밀어낼 정보를 구분하고, tool schema와 출력 schema의 버전을 고정해야 해요. cache hit가 깨졌을 때 어떤 변경이 원인이었는지 추적하는 일까지 포함하는 설계죠.

## Prefix와 breakpoint가 핵심이다

OpenAI의 최신 문서에 따르면 지원 모델에서는 prompt caching이 기본으로 동작해요. GPT-5.6 이후 모델은 1,024 visible token 이상, 그보다 오래된 모델은 2,048 visible token 이상이어야 cacheable prefix가 돼요. hidden OpenAI system token은 이 최소 길이에 포함되지 않아요.

OpenAI는 implicit mode와 explicit mode를 모두 설명해요. implicit mode에서는 OpenAI가 breakpoint를 자동으로 잡고, explicit mode에서는 개발자가 캐시할 prefix의 끝을 직접 지정해요. explicit mode를 사용하려면 요청에 prompt_cache_options를 넣고, cacheable content block에는 prompt_cache_breakpoint를 붙여야 해요.

```json
{
  "prompt_cache_options": {
    "mode": "explicit"
  }
}
```

```json
{
  "prompt_cache_breakpoint": {
    "mode": "explicit"
  }
}
```

여기에는 중요한 제한이 있어요. OpenAI 문서에 따르면 top-level instructions에는 explicit breakpoint를 넣을 수 없어요. 재사용할 developer instruction에 breakpoint를 지정하려면 developer message 안의 input_text block에 넣어야 해요. explicit mode에서 breakpoint를 하나도 두지 않으면 prompt caching도 동작하지 않고 cache write도 만들어지지 않아요. 마지막 breakpoint 뒤의 내용은 uncached input token rate로 처리돼 cache write 비용을 피할 수 있잖아요.

Claude는 조금 더 명시적인 방식을 써요. block 단위로 cache_control을 붙이며, 기본 TTL은 5분이에요. 1시간 TTL도 지정할 수 있어요. 문서에서는 top-level automatic caching과 block-level explicit breakpoint를 함께 사용하는 예시를 보여줘요.

```json
{
  "model": "claude-opus-5",
  "max_tokens": 1024,
  "cache_control": { "type": "ephemeral" },
  "system": [
    {
      "type": "text",
      "text": "You are a helpful assistant.",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": [{ "role": "user", "content": "What are the key terms?" }]
}
```

Claude 문서에서 실무적으로 눈여겨볼 대목은 “cache writes happen only at your breakpoint”라는 설명이에요. breakpoint까지의 prefix hash가 캐시 항목이 되고, 그 앞에서 무언가 바뀌면 다른 prefix가 돼요. cache read는 이전 write를 뒤로 찾아가며 확인해요. “긴 system prompt에 cache_control을 붙였다”는 것만으로는 부족하고, 그 앞의 tools와 system block이 실제로 안정적인지 확인해야 해요.

Gemini에서는 context caching이라는 용어를 써요. Gemini API 문서는 Gemini 2.5 이상 모델에서 implicit caching이 기본으로 활성화된다고 설명해요. Python과 JavaScript 응답 객체에서는 usage.total_cached_tokens로 cache hit token 수를 확인할 수 있어요. Firebase AI Logic 문서에서는 응답 metadata의 cachedContentTokenCount를 언급하죠.

```plain text
usage.total_cached_tokens
```

```plain text
cachedContentTokenCount
```

Firebase AI Logic의 explicit caching에는 앱 기능과 서버 prompt template, provider, model, location의 정합성이 따라와요. 명시적 캐시를 만든 뒤 server prompt template에서 참조하고, 앱 요청에서 다시 그 server prompt template을 참조하는 흐름이에요. 캐시 내용은 만든 뒤 바꿀 수 없고 TTL 또는 expiration time만 변경할 수 있어요. 서버 에이전트의 prompt cache와 클라이언트 AI 기능의 context cache를 같은 설계로 보면 안 되는 이유예요.

## 캐시가 이득이 아닌 경우

캐시도 공짜는 아니에요. OpenAI 문서에 따르면 GPT-5.6 이후에는 cache write가 일반 uncached input token rate의 1.25배이고, cache read는 0.1배예요. 한 번 쓰고 다시 사용하지 않는 prefix라면 write 비용만 더 낼 수 있어요. 한 번 쓴 뒤 여러 번 읽는 반복 작업이라면 비용과 latency를 줄일 가능성이 커져요.

처음 적용하기 좋은 대상은 프롬프트가 길면서도 앞부분이 거의 바뀌지 않는 작업이에요. Slack command, PR reviewer, daily plan, worklog generator, router intent classifier처럼 role instruction과 출력 형식이 안정적인 실행이 먼저예요. ad-hoc 질문, 한 번만 수행하는 대형 diff 분석, 요청마다 tool 목록과 schema가 달라지는 실험성 agent는 우선 손대지 않아도 돼요. 반복해서 읽을 prefix가 있어야 캐시의 이점도 생기거든요.

TTL도 현실적인 제약이에요. Claude의 기본 cache lifetime은 5분이며, 응답 완료 시점이 아니라 cache entry를 write 또는 read하는 request 시작 시점부터 시간을 재요. 스트리밍 응답이 길어지면 후속 요청을 예상보다 빨리 보내야 cache를 재사용할 수 있어요. 긴 대화나 agent chain에서는 “이전 실행이 끝난 뒤 5분”이라고 단순하게 계산하면 안 돼요.

관측성도 빼놓을 수 없어요. cache hit는 “설정했으니 됐다”로 끝나는 기능이 아니에요. OpenAI는 Prompt Caching Dashboard에서 cache read hit rate를 볼 수 있다고 설명해요. Gemini는 cached token 관련 usage field를, Claude는 usage에 cache read/write token 계열 값을 제공해요. provider마다 필드 이름과 의미가 다르므로, 애플리케이션에서는 공통 metadata로 정규화해야 해요.

성숙한 설계는 캐시 API 호출을 감싸는 wrapper 하나로 끝나지 않아요. prefix fingerprint, tool schema version, prompt template version, provider cache read/write token, model name을 함께 기록해야 해요. 그래야 “어제부터 cache hit가 0이 됐다”는 현상이 생겼을 때 원인을 추적할 수 있으니까요. tool schema가 바뀌었는지, model-router가 다른 모델을 골랐는지, developer message 앞에 날짜가 들어갔는지 확인할 수 있어요.

## Slack 에이전트 시스템에 적용하기

가장 먼저 살펴볼 곳은 model-router예요. cache key에 model이 영향을 준다면 같은 AgentType이 어떤 모델로 라우팅되는지가 비용 최적화의 전제가 돼요. 모델 라우팅을 자주 바꾸면 정확도 실험은 쉬워질 수 있지만, prefix cache 관점에서는 이전 실행과 전혀 다른 조건이 돼요.

그다음은 agent-run이에요. 이미 agent 실행의 시작과 종료, evidence, metadata를 기록한다면 여기에 cache 관측값을 붙이는 게 자연스러워요. AgentRun metadata에 provider별 raw usage와 정규화된 cachedInputTokens, cacheWriteTokens, promptPrefixFingerprint, toolSchemaVersion, promptTemplateVersion을 남길 수 있어요. 이 필드 이름은 provider 공식 API가 아니라 애플리케이션 내부 관측용으로 정해야 해요. provider 원본 필드는 별도로 보존하는 편이 안전해요.

router prompt는 자연어 멘션을 intent classifier로 보내고 여러 worker dispatcher에 넘기는 과정에서 거의 항상 반복돼요. 분류 후보 표, handoff 규칙, 실패 처리 규칙은 안정적인 prefix로 두기 좋아요. 사용자 원문과 Slack thread 정보, 최근 이벤트는 뒤쪽에 배치해야 해요. router의 정확도만큼이나 매번 같은 prefix를 유지하는지도 중요하죠.

slack 모듈은 캐시 대상이라기보다 변동성이 들어오는 입구예요. Slack command payload에는 user id, channel id, command text, trigger id, response url처럼 매번 달라지는 값이 많아요. 이런 값을 developer/system instruction 앞쪽에 직렬화하면 prefix가 쉽게 깨져요. Slack adapter에서는 payload를 prompt 맨 앞에 그대로 붙이지 말고, 안정적인 instruction 뒤의 user message 또는 context block으로 미루는 편이 나아요.

실제 agent 중에서는 agent/pm, agent/work-reviewer, agent/code-reviewer, agent/be-sre, agent/be-test, agent/blog, autopilot, ops-supervisor가 후보예요. 역할 규칙과 출력 형식은 반복되고, 실행마다 달라지는 입력도 비교적 분명해요. agent/code-reviewer는 PR diff가 매번 달라도 리뷰 원칙과 금지 사항, 출력 포맷은 안정적이에요. agent/pm과 agent/work-reviewer도 GitHub task나 전일 plan은 바뀌지만, daily plan/worklog 작성 규칙은 고정할 수 있어요.

agent/vacation처럼 자연어 파라미터 추출에만 LLM을 쓰는 짧은 작업은 우선순위가 낮아요. 입력과 prefix가 짧으면 cacheable token 기준을 넘기 어렵고, 넘더라도 절감 폭이 작을 수 있어요. agent/paper-recommend는 입력 후보 목록이 크고 자주 반복된다면 후보가 될 수 있어요. 다만 공통으로 캐시할 부분과 매번 달라지는 시장 데이터를 먼저 분리해야 하잖아요.

## 캐시가 맞을 수밖에 없는 구조

적용하기 전에 현재 prompt layout의 system/developer prefix 앞쪽에 실행마다 달라지는 값이 섞였는지 확인해야 해요. 오늘 날짜, run id, Slack payload, GitHub diff, 사용자 원문이 앞에 있으면 cache hit를 기대하기 어려워요. 안정적인 instruction, tool schema, output schema를 앞에 두고 변화하는 내용을 뒤로 미루는 데서 시작해요.

provider별 usage field도 버리지 말고, agent-run에서 cache read/write token을 장기 지표로 확인할 수 있게 해야 해요. cache hit가 정확도 지표를 대신하지는 않아요. 다만 장기 에이전트를 반복 실행하는 시스템에서는 비용과 첫 토큰 지연을 설명하는 별도의 운영 지표가 돼요.

OpenAI, Claude, Gemini, Firebase AI Logic은 모두 caching을 제공하지만 breakpoint, TTL, 최소 토큰, usage field, explicit cache 생성 방식은 서로 달라요. “프롬프트 캐싱을 지원한다”는 한 문장으로 묶어 추상화하면 위험해요. 장기 에이전트에서 중요한 건 provider 기능을 켜는 데 그치지 않아요. 캐시가 맞을 수밖에 없는 prefix를 설계하고, 깨졌을 때 바로 알아차릴 구조를 만들어야 하거든요.
