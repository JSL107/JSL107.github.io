---
title: "전화 실행면보다 세션 기록이 먼저다"
description: "Slack 기반 자동화에 전화 입력을 붙이기 전에 Realtime 세션과 도구 호출을 기존 실행 기록에 담는 방법을 검토한다."
pubDatetime: 2026-11-16T19:46:00+09:00
category: backend
---

Slack에서 요청 하나를 처리하던 자동화에 전화를 붙이려면 실행의 경계부터 다시 정해야 해요. OpenAI Realtime API 공식 블로그, Realtime/audio 문서, SIP 문서, 공식 예제 저장소를 바탕으로 구조를 살펴보고 운영 중인 Slack 기반 멀티 에이전트 시스템에 대입해 봤어요. 실제 전화번호와 SIP trunk를 연결해 지연 시간이나 비용을 측정한 결과는 아니에요.

## 채팅으로 충분했던 자동화가 전화를 만나면

장애가 났다고 가정해 볼게요. 지금은 누군가 Slack에 “상태 확인해 줘”라고 쓰면 봇이 요청을 분류해 큐에 작업을 넣고, 워커가 결과를 만든 뒤 채널에 답해요. 요청과 응답의 경계가 분명해서 실패해도 같은 입력으로 다시 돌릴 수 있고 실행 기록도 한 덩어리로 남아요.

같은 요청을 전화로 받으면 사용자는 말을 멈췄다가 다시 시작하기도 해요. 모델이 “잠시만요, 확인해 볼게요”라고 말하는 동안에도 백엔드의 DB 조회나 외부 API 호출은 끝나지 않았을 수 있어요. 통화는 열린 채로 작업이 비동기로 흐르니 기존의 “명령 하나, 작업 하나, 결과 하나” 모델에서는 어디를 실행의 끝으로 봐야 할지 애매해져요.

## 실행 단위가 요청에서 세션으로 바뀐다

Realtime Voice Agent를 음성 입력을 텍스트로 바꿔 기존 챗봇에 넣는 방식으로만 보면 핵심을 놓치기 쉬워요. Realtime 세션은 `/v1/realtime` 연결을 열어 둔 채 오디오 입력과 모델의 음성 출력, 텍스트 이벤트, 도구 호출, 세션 업데이트를 주고받아요.

| 구분 | Slack 자동화 | Realtime 음성 세션 |
| --- | --- | --- |
| 실행 단위 | 메시지나 슬래시 명령 하나 | 통화가 이어지는 세션 |
| 기다리는 동안 | “처리 중” 메시지를 보낸 뒤 결과를 교체 | 확인 발화를 하고 도구 결과를 기다리며 대화를 유지 |
| 기록할 사건 | 요청과 결과 | 발화, 침묵, 도구 호출의 pending 상태와 결과 |

“오늘 할 일 정리해 줘”처럼 한 번의 의도로 끝나는 질의라면 음성 인식 결과를 기존 라우터에 넣어도 돼요. 하지만 “지금 배포가 막혔는데 원인 확인하고 담당자에게 알려 줘”처럼 중간 확인과 승인, 재질문, 장시간 대기가 섞이면 이야기가 달라져요. 이때 음성 에이전트의 본체는 STT보다 세션 상태 관리자에 가까워요.

GA Realtime의 async function calling은 느린 도구 호출이 진행되는 동안에도 대화를 이어 가게 해 줘요. 모델이 외부 DB 조회, GitHub나 Slack 조회, 큐 작업 등록처럼 시간이 걸리는 일을 요청하면 애플리케이션은 나중에 그 결과를 세션에 넣어요. 일반 function calling에서는 애플리케이션이 모델에 도구를 알려 주고, 모델이 호출을 만들면 함수를 실행한 뒤 출력을 `function_call_output`으로 돌려줘요.

```python
tools = [
    {
        "type": "function",
        "name": "get_horoscope",
        "description": "Get today's horoscope for an astrological sign.",
        "parameters": {
            "type": "object",
            "properties": {
                "sign": {
                    "type": "string",
                    "description": "An astrological sign like Taurus or Aquarius",
                },
            },
            "required": ["sign"],
        },
    },
]

input_list.append(
    {
        "type": "function_call_output",
        "call_id": item.call_id,
        "output": horoscope,
    }
)
```

예시의 `get_horoscope` 자리에는 내 시스템의 “PR 리뷰 상태 조회”, “대기 중인 작업 확인”, “실패한 실행 재시도 등록” 같은 내부 도구가 들어갈 수 있어요. 모델이 직접 DB를 만지는 게 아니라 애플리케이션이 승인된 도구 목록과 스키마를 공개하고 서버가 실행을 맡아요.

음성 통화에서 도구가 끝날 때까지 아무 말이 없으면 사용자는 통화가 끊겼다고 느낄 수 있어요. 모델이 먼저 “확인해 볼게요”라고 말하고 서버가 큐에 작업을 넣은 다음, 결과가 오면 같은 세션에서 설명하는 흐름이 필요해요.

## 전화 수신은 webhook에서 시작한다

SIP 문서에 나온 흐름은 “전화번호 → SIP trunk → OpenAI incoming call webhook → accept/reject → Realtime session”에 가까워요. 처음에 판단할 일은 통화 내용을 어떻게 처리할지가 아니라 이 전화를 받을지 말지예요. 수신 전화의 webhook 이벤트에는 `type`이 `realtime.call.incoming`으로 들어오고, 이후 API 호출에 쓸 `call_id`도 포함돼요.

```plain text
POST https://my_website.com/webhook_endpoint
user-agent: OpenAI/1.0 (+https://platform.openai.com/docs/webhooks)
content-type: application/json
webhook-id: wh_685342e6c53c8190a1be43f081506c52
webhook-timestamp: 1750287078
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=

{
  "object": "event",
  "id": "evt_685343a1381c819085d44c354e1b330e",
  "type": "realtime.call.incoming",
  "created_at": 1750287018,
  "data": {
    "call_id": "some_unique_id",
    "sip_headers": [
      { "name": "From", "value": "sip:+142555512112@sip.example.com" },
      { "name": "To", "value": "sip:+18005551212@sip.example.com" },
      { "name": "Call-ID", "value": "03782086-4ce9-44bf-8b0d-4e303d2cc590" }
    ]
  }
}
```

외부 이벤트를 내부 작업으로 바꾸는 webhook 수신부가 이미 있다면 전화 수신은 새로운 에이전트보다 새로운 트리거에 가까워요. 그렇다고 webhook을 받자마자 모든 작업을 시작할 수는 없어요. 먼저 서명을 검증하고 중복 delivery를 처리하며 허용된 발신 조건과 업무 시간 정책도 확인해야 해요.

통화를 받기로 했다면 accept endpoint에 모델, 지시문, 음성, 도구 목록 등의 Realtime 세션 설정을 넘겨요.

```bash
curl -X POST "https://api.openai.com/v1/realtime/calls/$CALL_ID/accept" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "realtime",
    "model": "gpt-realtime-2.1",
    "instructions": "You are Alex, a friendly concierge for Example Corp."
  }'
```

Slack 명령의 ack와 비슷해 보여도 전화에서 accept는 실행의 시작이에요. Slack에서는 ack 뒤에 비동기 응답을 보내면 실행이 끝나지만 전화에서는 통화가 끊길 때까지 세션 이벤트를 살펴보고 필요하면 WebSocket으로 같은 `call_id`에 붙어 제어해야 해요.

## 음성에서는 턴 관리와 감사 경계가 중요하다

텍스트 에이전트에서는 같은 입력에 같은 출력이 나오는지 먼저 살피기도 해요. 업무 보고서나 코드 리뷰에서는 특히 그렇죠. 음성에서는 사용자가 말을 끝낸 건지, 잠깐 숨을 고르는 건지, 네트워크 때문에 끊긴 건지 구분하지 못하면 답변이 정확해도 소용없어요.

Realtime 문서는 이 문제를 VAD와 idle timeout으로 다뤄요. 서버 측 voice activity detection이 발화를 감지하고 일정 시간 새 음성이 없으면 timeout 이벤트를 만들 수 있어요. 이 이벤트가 대화 이력에 빈 오디오 구간을 commit하고 모델의 응답을 유도하면 모델이 “아직 계신가요?”라고 물을 자리가 생겨요.

GA 인터페이스에서는 temperature를 모델 파라미터로 두지 않아요. 베타 인터페이스에서도 낮은 temperature가 음성 응답을 결정적으로 만들지는 않는다고 안내하고 높은 temperature는 오디오 이상을 만들 수 있어요. 그래서 동작을 제어하려면 temperature보다 prompt, 도구 사용 지침, 짧은 확인 발화, 명확한 실패 문구가 중요해요. “도구 조회가 2초 이상 걸리면 먼저 기다려 달라고 말하라”, “사용자가 승인하지 않은 작업은 실행하지 말고 확인 질문을 하라” 같은 대화 운영 규칙이 필요한 거죠.

업무 자동화에서는 비용과 지연뿐 아니라 나중에 실행을 확인할 수 있는지도 문제예요. 사용자가 무엇을 지시했는지, 모델이 어떤 도구를 호출했는지, 서버가 어떤 결과를 돌려줬는지, 실제 side effect가 있었는지 재구성할 수 있어야 해요. “그 작업 다시 실행해 줘”라는 말에는 음성 인식 오류나 중간 끼어들기, 대리 발화 가능성이 섞이므로 기존 Slack 실행면의 버튼 클릭, 명령 입력, 실행 기록만큼 명확한 경계가 필요해요.

- 조회와 변경 작업을 분리한다.
- 변경 작업은 음성만으로 바로 실행하지 않고 별도 승인 단계를 둔다.
- 통화 요약과 도구 호출 증거를 같은 실행 기록에 묶는다.

처음부터 양방향 음성 에이전트를 만들기보다 “음성 메모 → 텍스트 작업 등록”만 붙일 수도 있어요. 구현이 단순하고 실행을 확인하기도 쉽지만 실시간 확인이나 재질문, 긴급 전화 응대는 어려워요. SIP 기반 Realtime 세션을 바로 붙이면 전화 경험은 좋아지는 대신 세션 상태, 재시도, 권한, 녹취/요약 보관 정책까지 설계해야 해요.

## 기존 실행 기록을 어떻게 확장할까

내 시스템은 Slack 요청을 분류해 담당 기능으로 넘기고 공통 실행 이력을 남겨요. 그날 할 일 정리, PR 리뷰 생성, 업무 로그 요약, 지연 원인 조회처럼 기능도 나뉘어 있어요.

지금은 `VoiceSessionRun`이라는 별도 모델을 만들기보다 기존 실행 기록에 음성 트리거와 세션 식별자를 추가하는 편이 낫다고 봐요. 전화로 들어온 요청도 상태 조회, 작업 등록, 리뷰 생성, 알림 전송이라는 기존 기능을 쓰는데 실행 모델을 따로 만들면 감사 경로가 둘로 갈라지니까요.

다만 통화 전체를 하나의 실행으로만 저장해서는 부족해요. 한 통화에 도구 호출이 여러 번 들어갈 수 있고 호출마다 성공·실패·재시도·승인 상태가 다르거든요. 상위 실행 기록에는 `VOICE_CALL` 트리거와 `sessionId`, `callId`를 두고 그 아래에 도구 호출 evidence를 여러 개 붙이는 형태가 자연스러워요. 기존 저장소가 “한 번의 에이전트 실행”을 담았다면 음성에서는 “한 번의 열린 세션 안에서 발생한 여러 실행 조각”을 담을 수 있어야 해요.

자연어 요청을 담당 기능으로 넘기는 기존 분류기는 재사용할 수 있다. 그러나 사용자가 “그거 해 줘”라고 말했을 때는 앞선 발화와 현재 pending tool call을 함께 봐야 한다. 세션 상태 관리자가 현재 발화가 새 요청인지, 이전 도구 호출의 보충 정보인지, 승인 응답인지 구분한 뒤 라우터에 넘기는 구조가 맞다.

## 다음 실험은 전화 연결보다 세션 로그다

첫 실험에는 SIP trunk를 연결하기보다 WebRTC나 WebSocket 기반의 짧은 voice-agent session이 적합해요. 사용자가 음성으로 조회를 요청하면 모델이 도구 호출을 만들고, 서버가 기존 조회 기능을 실행해 결과를 세션에 돌려줘요. 끝으로 통화 요약과 도구 호출 evidence가 같은 실행 ID 아래 남는지 확인해요.

그다음에는 승인 경계를 시험해요. 조회는 바로 수행하되 재시도·알림 전송·외부 상태 변경에는 “제가 이 작업을 실행해도 될까요?”라고 확인해요. 음성 승인만으로 충분할지, Slack 버튼 같은 별도 채널의 승인이 필요할지는 업무 위험도에 따라 달라져요. 공개 운영 시스템에 붙이기 전에는 음성 인식 결과, 모델 발화, 도구 호출, 사용자 승인 문구를 나중에 재구성할 수 있는지 확인해야 해요.

### 참고한 출처

- OpenAI Developers, “Developer notes on the Realtime API”  
https://developers.openai.com/blog/realtime-api/
- OpenAI API Docs, “Realtime and audio”  
https://platform.openai.com/docs/guides/realtime
- OpenAI API Docs, “Realtime API with SIP”  
https://platform.openai.com/docs/guides/realtime-sip
- OpenAI API Docs, “Function calling”  
https://developers.openai.com/api/docs/guides/function-calling
- OpenAI 공식 예제, “openai-realtime-agents”  
https://github.com/openai/openai-realtime-agents
- OpenAI 공식 예제, “openai-realtime-console”  
https://github.com/openai/openai-realtime-console
