---
title: "어제까지 잘 되던 캐시가 오늘 0%가 됐다면"
description: "프롬프트 앞부분을 다시 계산하지 않는 기능은 켜는 것보다 깨지지 않게 두는 게 어려워요. 날짜 한 줄이 앞에 끼면 그날부터 적중률이 0이 돼요. provider 넷의 규칙 차이와 무엇을 기록해야 원인을 찾는지 정리했어요."
pubDatetime: 2026-09-05T19:05:00+09:00
category: infra
---

어제까지 잘 맞던 캐시 적중률이 오늘 갑자기 0이 됐다면 무엇부터 보시겠어요? 프롬프트를 고친 적이 없다면 더 난감하죠. 그런데 이런 일은 도구 목록 순서가 바뀌거나, 안내문 맨 앞에 오늘 날짜가 한 줄 들어가는 것만으로도 생겨요.

이 글에서 **프롬프트 캐싱**은 모델이 입력 앞부분을 처리하며 만든 중간 상태를 재사용해, 같은 앞부분을 다시 계산하지 않게 하는 기능이에요. 문장을 짧게 쓰는 일과는 관계가 없고, **어디까지가 매번 같은 앞부분인지를 설계하는 일**에 가까워요.

반복 실행되는 에이전트를 운영하는 분이라면 이 글에서 세 가지를 가져가실 수 있어요. 무엇이 캐시를 깨뜨리는지, provider 넷이 규칙을 어떻게 다르게 두는지, 깨졌을 때 원인을 찾으려면 무엇을 기록해 둬야 하는지.

여기서 묶은 넷은 층위가 같지 않아요. OpenAI와 Claude, Gemini API는 서버에서 직접 호출하는 모델 API고, Firebase AI Logic은 모바일·웹 앱이 Gemini 모델에 접근하게 해 주는 Firebase 제품이에요. 앞의 셋은 서버에서 도는 에이전트의 prompt cache 이야기, 마지막 하나는 앱 쪽 이야기라 규칙도 그만큼 다르게 읽어야 해요.

**아래는 각 provider 공식 문서를 2026년 9월 5일에 읽고 정리한 것이고, 제 시스템에 적용해 절감 폭을 재본 결과가 아니에요.** 마지막 절의 적용 계획도 문서를 보고 그린 그림이에요.

## 반복 실행이 비싸지는 순간

Slack에서 에이전트를 한 번 실행할 때는 비용이 잘 눈에 띄지 않아요. 그날 할 일 정리나 PR 리뷰, 업무 로그 초안을 한 번씩 실행하면 "프롬프트가 길다"는 느낌은 들어도 구조를 손볼 만큼 부담스럽지는 않죠. 문제는 이 실행이 매일, 매 PR마다, 여러 worker에서 반복될 때 생겨요.

장기 에이전트 시스템은 매번 전혀 새로운 질문을 받는 듯하지만, 실제로는 입력 앞부분이 자주 반복돼요. 역할 설명, 시스템 규칙, 도구 목록, 출력 형식, few-shot(모델에 미리 보여 주는, 정답이 붙은 예시 묶음), 라우터 분류 기준, 장기 기억 요약이 여기에 들어가요. 사용자 입력, 오늘 날짜, GitHub diff, Slack channel, run id, 최근 이벤트처럼 매번 달라지는 내용은 따로 있어요.

처음에는 정확도가 중요해서 프롬프트에 내용을 계속 덧붙여요. “이 경우에는 이렇게 해라”, “저 경우에는 실패로 처리해라”, “이 포맷을 지켜라” 같은 규칙이 점점 늘어나요. 운영 단계에 들어서면 이 긴 앞부분을 매번 다시 계산해야 하는지 고민하게 돼요. 같은 system/developer instruction과 tool schema를 반복해서 쓴다면, 모델이 앞부분을 다시 처리하지 않는 구조를 만들 수 있으니까요.

장기 에이전트에서는 프롬프트도 실행 비용과 지연 시간에 영향을 주므로, prefix의 배치와 관측 방식까지 아키텍처로 다뤄야 해요.

## 프롬프트가 아니라 실행 계층을 최적화한다

프롬프트 캐싱은 좋은 답변을 얻기 위한 prompt engineering 기법이 아니에요. 모델이 입력을 처리하며 만든 중간 상태를 재사용해서, 같은 prefix를 다시 계산하지 않도록 실행 계층을 최적화하는 방식이에요.

OpenAI 문서는 prompt caching을 “requests share the same prompt prefix”일 때 이전 계산을 재사용하는 기능이라고 설명해요. 여기서부터는 문서 문장이 아니라 제 정리인데, 모델은 입력 토큰을 처리하면서 attention에 필요한 key-value 상태를 만들고 캐시는 이 prefix의 KV 상태를 재사용해요. 토큰 문자열 자체가 아니라 모델이 처리한 중간 상태를 저장하는 셈이죠. 그래서 “내 눈에 같은 문장인가”보다 “모델에 렌더링된 prefix가 같은가”가 더 중요해요.

이 차이는 실무에서 꽤 크게 작용해요. tool schema 순서나 structured output 설정이 바뀌고, developer message 앞쪽에 날짜가 들어가면 사람이 보기에는 작은 변화여도 cache hit에 영향을 줄 수 있어요. OpenAI 문서는 model, tools, parallel_tool_calls, text.format, reasoning.effort, text.verbosity, context_management 같은 설정도 cache reuse에 영향을 줄 수 있다고 설명해요.

Claude 문서도 같은 방향으로 설명해요. Claude의 prompt caching은 cache_control로 재사용 가능한 prefix의 끝을 표시해요. prompt 구조는 tools → system → messages 순서로 prefix를 만든다고 나와 있어요. 안정적인 tool 정의와 system instruction, 큰 배경 문서, 예시는 앞에 두고 매번 바뀌는 사용자 요청은 뒤에 두는 게 기본 전략이에요.

두 문서를 겹쳐 놓으면 해야 할 일이 분명해져요. prefix에 넣을 정보와 뒤로 밀어낼 정보를 구분하고, tool schema와 출력 schema의 버전을 고정해야 해요. cache hit가 깨졌을 때 어떤 변경이 원인이었는지 추적하는 일까지 포함하는 설계죠.

## Prefix와 breakpoint가 핵심이다

아래 breakpoint 배치 규칙은 특정 요청 스펙 위의 이야기예요. OpenAI 쪽은 Responses API 요청, Claude 쪽은 `system`과 `messages`를 담아 보내는 Claude API 요청 기준이고, 둘 다 2026년 9월 5일에 읽은 문서를 옮긴 거예요. 제가 쓰는 SDK 버전과 모델 버전이 이 규칙을 그대로 받는지는 확인하지 않았어요. 그러니 예시를 그대로 옮겨 심기 전에, 각자 쓰는 SDK가 `prompt_cache_options`와 `cache_control`을 어떤 이름으로 노출하는지부터 확인하시는 편이 안전해요.

OpenAI의 최신 문서에 따르면 지원 모델에서는 prompt caching이 기본으로 동작해요. GPT-5.6 이후 모델은 1,024 visible token 이상, 그보다 오래된 모델은 2,048 visible token 이상이어야 cacheable prefix가 돼요. hidden OpenAI system token은 이 최소 길이에 포함되지 않아요.

OpenAI는 implicit mode와 explicit mode를 모두 설명해요. implicit mode에서는 OpenAI가 breakpoint를 자동으로 잡고, explicit mode에서는 개발자가 캐시할 prefix의 끝을 직접 지정해요. explicit mode를 사용하려면 요청에 `prompt_cache_options`를 넣고, cacheable content block에는 `prompt_cache_breakpoint`를 붙여야 해요.

여기에는 중요한 제한이 있어요. OpenAI 문서에 따르면 top-level instructions에는 explicit breakpoint를 넣을 수 없어요. 재사용할 developer instruction에 breakpoint를 지정하려면 developer message 안의 `input_text` block에 넣어야 해요. explicit mode에서 breakpoint를 하나도 두지 않으면 prompt caching도 동작하지 않고 cache write도 만들어지지 않아요. 마지막 breakpoint 뒤의 내용은 uncached input token rate로 처리돼 cache write 비용을 피할 수 있어요.

두 값이 요청의 어디에 붙는지를 한 건으로 보면 이렇게 생겼어요. OpenAI 문서의 explicit mode 예시에서 모델 이름과 cache key 줄을 덜어 내고, 자리만 보이도록 텍스트를 우리말 설명으로 바꾼 축약본이에요.

```json
{
  "prompt_cache_options": { "mode": "explicit" },
  "input": [
    {
      "role": "developer",
      "content": [
        {
          "type": "input_text",
          "text": "역할 규칙, 도구 설명, 출력 형식처럼 매번 같은 앞부분",
          "prompt_cache_breakpoint": { "mode": "explicit" }
        }
      ]
    },
    { "role": "user", "content": "매번 달라지는 사용자 입력" }
  ]
}
```

붙는 자리는 두 곳이에요. 요청 레벨 옵션인 `prompt_cache_options`는 최상위에 한 번 붙고, breakpoint 표시는 developer message 안의 `input_text` block 안에 붙어요. 캐시 경계가 developer message 바깥이 아니라 그 안쪽 block에 그어진다는 뜻이죠.

Claude는 조금 더 명시적인 방식을 써요. block 단위로 `cache_control`을 붙이며, 캐시가 살아 있는 시간(TTL)은 기본 5분이에요. 1시간 TTL도 지정할 수 있어요. 문서에서는 top-level automatic caching과 block-level explicit breakpoint를 함께 사용하는 예시를 보여줘요. 여기서 top-level automatic caching은 요청 최상위에 `cache_control`을 하나 두면 시스템이 마지막 cacheable block에 breakpoint를 잡아 주고, 대화가 길어지면 그 자리를 앞으로 옮겨 주는 방식이에요. 앞에서 본 OpenAI의 implicit mode가 아무 표시 없이도 도는 기본 동작인 것과 달리, 이쪽은 필드를 하나 넣어야 자동으로 움직인다는 점이 달라요. 아래 예시는 문서의 「automatic caching에 block-level caching을 함께 쓰기」 대목을 그대로 옮긴 것이에요.

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

Claude 문서에서 실무적으로 눈여겨볼 대목은 "cache writes happen only at your breakpoint"라는 설명이에요. breakpoint까지의 prefix hash가 캐시 항목이 되고, 그 앞에서 무언가 바뀌면 다른 prefix가 돼요. cache read는 이전 write를 뒤로 찾아가며 확인하는데, 되짚어 보는 범위는 20개 블록까지예요.

문서에는 이 구조에서 나오는 흔한 실수가 예시로 나와요. 블록 1~5에 큰 고정 배경이 있고 블록 6에 타임스탬프와 사용자 메시지가 들어가는데, `cache_control`을 블록 6에 붙이는 경우예요. 뒤로 되짚는 동작이 "앞에 있는 안정적인 내용을 찾아 캐시해 주는" 게 아니라 **이전 요청이 실제로 써 둔 항목을 찾는** 것이라서, 매번 달라지는 블록 6에 breakpoint를 두면 쓰이는 항목도 매번 달라져요. 문서의 처방은 간단해요. `cache_control`을 블록 5로 옮기라는 거죠.

정리하면 breakpoint는 **캐시를 공유하고 싶은 요청들 사이에서 앞부분이 완전히 같은 마지막 블록**에 놓아야 해요. "긴 system prompt에 cache_control을 붙였다"는 것만으로는 부족하고, 그 앞의 tools와 system block이 실제로 안정적인지 확인해야 하고요.

Gemini에서는 context caching이라는 용어를 써요. Gemini API 문서는 Gemini 2.5 이상 모델에서 implicit caching이 기본으로 활성화되며, 요청이 캐시에 적중하면 절감된 비용이 자동으로 반영된다고 설명해요. 다만 할인율을 수치로 밝히지는 않아서, 얼마나 싸지는지는 모델별 캐시 단가를 따로 봐야 해요(2026년 9월 8일 기준 캐싱 문서와 가격 문서 어디에도 할인율 수치는 없었어요). 켜기 위해 할 일이 없다는 뜻이기도 하고, 반대로 **끄거나 조절할 여지도 적다**는 뜻이에요. 적중한 토큰 수는 Python과 JavaScript 응답 객체의 `usage.total_cached_tokens` 필드에서 확인할 수 있고, Firebase AI Logic 문서는 응답 metadata의 `cachedContentTokenCount`를 언급하죠.

Firebase AI Logic의 explicit caching에는 "같아야 하는 것"이 따라붙어요. 문서는 캐시가 provider와 모델에 매여 있다고 적어요. 캐시를 만들 때 쓴 provider와 모델을 그 캐시를 쓰는 앱 요청도 똑같이 써야 한다는 뜻이죠. Agent Platform Gemini API를 쓸 때는 location, 그러니까 모델과 캐시가 도는 지역까지 걸려요. 캐시와 server prompt template과 앱 요청, 이 셋의 location이 모두 같아야 하거든요. 다만 하나가 어긋났을 때 어떤 오류로 돌아오는지까지는 문서에 나오지 않아요.

여기서 server prompt template은 서버에 두는 프롬프트 구성이에요. 캐시를 리소스 이름으로 참조해 두면 앱은 템플릿 ID만 넘겨 그 캐시를 쓰게 되죠. 캐시 내용은 만든 뒤 바꿀 수 없고 TTL 또는 만료 시각(expiration time)만 변경할 수 있어요. 서버 에이전트의 prompt cache와 클라이언트 AI 기능의 context cache를 같은 설계로 보면 안 되는 이유예요.

## 캐시가 이득이 아닌 경우

캐시도 공짜는 아니에요. OpenAI 문서에 따르면 GPT-5.6 이후에는 cache write가 일반 uncached input token rate의 1.25배이고, cache read는 0.1배예요. 한 번 쓰고 다시 사용하지 않는 prefix라면 write 비용만 더 낼 수 있어요. 한 번 쓴 뒤 여러 번 읽는 반복 작업이라면 비용과 latency를 줄일 가능성이 커져요.

처음 적용하기 좋은 대상은 프롬프트가 길면서도 앞부분이 거의 바뀌지 않는 작업이에요. Slack command, PR reviewer, daily plan, worklog generator, router intent classifier처럼 role instruction과 출력 형식이 안정적인 실행이 먼저예요. ad-hoc 질문, 한 번만 수행하는 대형 diff 분석, 요청마다 tool 목록과 schema가 달라지는 실험성 agent는 우선 손대지 않아도 돼요. 반복해서 읽을 prefix가 있어야 캐시의 이점도 생기거든요.

TTL도 현실적인 제약이에요. Claude의 기본 cache lifetime은 5분이며, 응답 완료 시점이 아니라 cache entry를 write 또는 read하는 request 시작 시점부터 시간을 재요. 스트리밍 응답이 길어지면 후속 요청을 예상보다 빨리 보내야 cache를 재사용할 수 있어요. 긴 대화나 agent chain에서는 “이전 실행이 끝난 뒤 5분”이라고 단순하게 계산하면 안 돼요.

관측성도 빼놓을 수 없어요. cache hit는 “설정했으니 됐다”로 끝나는 기능이 아니에요. OpenAI는 Prompt Caching Dashboard에서 cache read hit rate를 볼 수 있다고 설명해요. Gemini는 cached token 관련 usage field를, Claude는 usage에 cache read/write token 계열 값을 제공해요. provider마다 필드 이름과 의미가 다르므로, 애플리케이션에서는 공통 metadata로 정규화해야 해요.

성숙한 설계는 캐시 API 호출을 감싸는 wrapper 하나로 끝나지 않아요. prefix fingerprint, tool schema version, prompt template version, provider cache read/write token, model name을 함께 기록해야 해요. 그래야 도입부의 그 상황, 그러니까 "어제부터 적중률이 0이 됐다"가 실제로 벌어졌을 때 원인을 좁힐 수 있어요. tool schema가 바뀌었는지, 라우터가 다른 모델을 골랐는지, 안내문 앞에 날짜가 들어갔는지를 기록에서 확인하는 거죠.

관측 계약은 이렇게 잡아 두려고 해요. 같은 작업을 같은 프롬프트 구조로 2주 동안 돌리면서, 캐시 읽기 토큰이 전체 입력 토큰에서 차지하는 비율과 첫 토큰까지 걸린 시간을 적용 전후로 나란히 보는 거예요. 다만 "몇 % 이상이면 적용에 성공한 것"이라고 부를 기준선은 아직 정하지 않았어요. 지금 시스템의 적중률을 한 번도 재 본 적이 없어서, 재기 전에 목표부터 정하면 근거 없는 숫자가 되니까요. 그러니 지금 적을 수 있는 건 계약까지고, 그 아래 숫자는 실제로 돌려 본 뒤에야 채울 수 있어요.

## Slack 에이전트 시스템에 적용하기

가장 먼저 살펴볼 곳은 모델 라우터예요. 캐시 키에 모델이 영향을 준다면 같은 작업이 어떤 모델로 라우팅되는지가 비용 최적화의 전제가 되거든요. 모델 라우팅을 자주 바꾸면 정확도 실험은 쉬워질 수 있지만, prefix cache 관점에서는 이전 실행과 전혀 다른 조건이 돼요.

그다음은 실행 기록이에요. 이미 실행의 시작과 종료, 근거, metadata를 남기고 있다면 거기에 캐시 관측값을 붙이는 게 자연스러워요. provider별 원본 usage와 함께 정규화된 캐시 읽기·쓰기 토큰 수, prefix 지문, tool schema 버전, prompt template 버전을 남길 수 있고요. 이 필드 이름은 provider 공식 API가 아니라 애플리케이션 내부 관측용으로 정해야 해요. provider 원본 필드는 별도로 보존하는 편이 안전해요.

자연어 멘션을 받아 어느 워커로 보낼지 정하는 라우터의 프롬프트는 거의 항상 반복돼요. 분류 후보 표, handoff 규칙, 실패 처리 규칙은 안정적인 prefix로 두기 좋아요. 사용자 원문과 Slack thread 정보, 최근 이벤트는 뒤쪽에 배치해야 해요. router의 정확도만큼이나 매번 같은 prefix를 유지하는지도 중요하죠.

Slack 진입점은 캐시 대상이라기보다 변동성이 들어오는 입구예요. Slack command payload에는 user id, channel id, command text, trigger id, response url처럼 매번 달라지는 값이 많아요. 이런 값을 developer/system instruction 앞쪽에 직렬화하면 prefix가 쉽게 깨져요. 그러니 payload를 프롬프트 맨 앞에 그대로 붙이지 말고, 안정적인 instruction 뒤의 user message나 context block으로 미루는 편이 나아요. 앞서 본 「블록 6에 breakpoint를 두는 실수」가 실제로 벌어지는 자리가 여기예요.

실제 작업 중에서는 도입부에서 꼽은 셋, 그러니까 그날 할 일을 정리하는 쪽과 업무 로그를 쓰는 쪽, PR 리뷰를 만드는 쪽이 먼저 후보예요. 조사한 내용을 정해진 형식의 글 초안으로 옮기는 작업, 사람이 부르지 않아도 정해진 시각에 스스로 도는 정기 실행도 성격이 같고요. 역할 규칙과 출력 형식은 반복되고 실행마다 달라지는 입력도 비교적 분명하거든요. PR 리뷰라면 diff가 매번 달라도 리뷰 원칙과 금지 사항, 출력 포맷은 안정적이에요. 그날 할 일 정리와 업무 로그도 GitHub task나 전일 계획은 바뀌지만 작성 규칙은 고정할 수 있고요.

반대로 자연어에서 날짜와 기간만 뽑아내는 짧은 작업은 우선순위가 낮아요. 입력과 prefix가 짧으면 위에서 본 최소 토큰 기준을 넘기 어렵고, 넘더라도 절감 폭이 작거든요. 후보 목록이 크고 자주 반복되는 추천 계열 작업은 가능성이 있지만, 공통으로 캐시할 부분과 매번 달라지는 시장 데이터를 먼저 갈라야 해요.

## 캐시가 맞을 수밖에 없는 구조

적용하기 전에 현재 prompt layout의 system/developer prefix 앞쪽에 실행마다 달라지는 값이 섞였는지 확인해야 해요. 오늘 날짜, run id, Slack payload, GitHub diff, 사용자 원문이 앞에 있으면 cache hit를 기대하기 어려워요. 안정적인 instruction, tool schema, output schema를 앞에 두고 변화하는 내용을 뒤로 미루는 데서 시작해요.

provider별 usage 필드도 버리지 말고, 실행 기록에서 캐시 읽기·쓰기 토큰을 장기 지표로 볼 수 있게 해야 해요. cache hit가 정확도 지표를 대신하지는 않아요. 다만 장기 에이전트를 반복 실행하는 시스템에서는 비용과 첫 토큰 지연을 설명하는 별도의 운영 지표가 돼요.

OpenAI, Claude, Gemini, Firebase AI Logic은 모두 caching을 제공하지만 breakpoint, TTL, 최소 토큰, usage field, explicit cache 생성 방식은 서로 달라요. “프롬프트 캐싱을 지원한다”는 한 문장으로 묶어 추상화하면 위험해요. 장기 에이전트에서 중요한 건 provider 기능을 켜는 데 그치지 않아요. 캐시가 맞을 수밖에 없는 prefix를 설계하고, 깨졌을 때 바로 알아차릴 구조를 만들어야 하거든요.

## 출처

각 provider 의 동작과 수치는 문서 확인 시점과 모델 세대에 따라 달라질 수 있어요. 아래 자료는 대부분 2026년 9월 5일에 확인했고, Gemini 쪽 할인율 수치가 없다는 점만 글을 올린 뒤 9월 8일에 캐싱 문서와 가격 문서를 다시 열어 확인했어요. 행마다 확인일을 따로 적어 두었어요. 본문의 수치는 모두 문서에 적힌 값이고, 제 시스템에 적용해 실제로 잰 값은 없어요.

| 제목 | 자료 링크 | 본문 주장 대응 | 확인일 |
| --- | --- | --- | --- |
| Prompt caching (OpenAI) | [직접 링크](https://developers.openai.com/api/docs/guides/prompt-caching) | Responses API 요청 기준, 같은 prefix 재사용, 최소 길이 1,024(GPT-5.6 이후)·2,048(그 이전) 토큰, hidden system token 미포함, implicit·explicit 모드와 `prompt_cache_breakpoint`, top-level instructions 에 breakpoint 불가, 본문 JSON 골격(요청 최상위 `prompt_cache_options` + developer message 의 `input_text` block 안 breakpoint), cache write 1.25배·read 0.1배 | 2026-09-05 |
| Prompt caching (Claude) | [직접 링크](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | `system`·`messages` 를 담는 Claude API 요청 기준, `cache_control` 로 블록 단위 표시, 요청 최상위 `cache_control` 로 마지막 cacheable block 에 breakpoint 를 잡아 주는 automatic caching, prefix 순서 tools → system → messages, 기본 5분·1시간 옵션, "cache writes happen only at your breakpoint", 뒤로 되짚는 20블록 lookback, TTL 을 요청 시작 시점부터 재는 규칙, 블록 6 대신 5에 두라는 실수 예시, 본문 Claude JSON 예시 원문 | 2026-09-05 |
| Context caching (Gemini API) | [직접 링크](https://ai.google.dev/gemini-api/docs/caching) | Gemini 2.5 이상에서 implicit caching 기본 활성화, 캐시 적중 시 비용 절감이 자동 반영된다는 서술(할인율 수치는 문서에 없음), `usage.total_cached_tokens` | 2026-09-05, 할인율 부재는 2026-09-08 재확인 |
| Gemini API pricing | [직접 링크](https://ai.google.dev/gemini-api/docs/pricing) | 캐시 단가는 모델별로 있으나(읽기 단가와 시간당 저장 단가) 원본 입력 대비 할인율 수치는 없음 — 본문의 할인율 부재 확인 근거이자, 모델별 캐시 단가를 직접 볼 경로 | 2026-09-08 |
| Context caching in Firebase AI Logic | [직접 링크](https://firebase.google.com/docs/ai-logic/context-caching) | 모바일·웹 앱에서 Gemini 모델에 접근하는 제품이라는 성격, server prompt template 을 거치는 explicit cache 흐름과 앱이 템플릿 ID 로 참조한다는 점, 캐시가 provider·모델에 매여 앱 요청도 같은 provider·모델을 써야 한다는 요구, Agent Platform Gemini API 에서 캐시·server prompt template·앱 요청의 location 일치 요구, 생성 후 내용 변경 불가와 TTL·만료 시각만 수정 가능 | 2026-09-05 |
| Prompt Caching in the API | [직접 링크](https://openai.com/index/api-prompt-caching/) | 기능 도입 배경(보조 자료). 위 공식 문서만으로 본문의 모든 수치를 확인할 수 있다 | 2026-09-05 |
