---
title: "A2A로 구분하는 내부 워커와 독립 에이전트"
description: "Slack 멀티 에이전트 시스템에서 A2A를 모든 워커에 적용하기보다 독립 에이전트 위임의 설계 기준으로 사용하는 방법을 살핀다."
pubDatetime: 2026-10-19T09:00:00+09:00
category: backend
---

Slack 멀티 에이전트 시스템에서 내부 워커를 부르는 일과 독립 에이전트에게 일을 맡기는 일은 경계가 달라요. 이 글은 A2A Protocol v1.0 문서, 공식 저장소, 공식 JavaScript SDK README, Google Codelab 예제를 읽고 그 차이를 정리한 글이에요. 직접 붙여 운영해 본 후기는 아니에요.

## 내부 호출에서 독립 에이전트 위임으로

Slack에 “오늘 할 일 정리해 줘”, “이 PR 리뷰해 줘”, “이번 주 업무 로그 초안 만들어 줘” 같은 요청이 들어와요. 처음에는 라우터가 의도를 파악해 백엔드 워커를 고르고, 워커가 모델을 호출한 결과를 Slack으로 돌려주면 충분해요. 워커가 늘어나면 사정이 달라져요. 같은 프로세스 안에서 함수처럼 부를 수 있는 일도 있지만, 별도 런타임과 권한, 저장소, 모델 정책을 가진 독립 에이전트에게 맡기고 싶은 일도 생기거든요.

그때는 “HTTP 엔드포인트 하나 열고 JSON을 던지면 되지 않나?” 싶어져요. 하지만 일을 위임하려면 상대가 무엇을 할 수 있는지 알아야 하고, 오래 걸리는 작업의 상태를 추적해야 해요. 실패 후 재시도와 후속 요청도 구분해야 하고, 최종 결과를 채팅 메시지 한 줄로만 흘려보내서도 안 돼요.

Slack 멀티 에이전트의 내부 워커는 보통 “내가 만든 코드”예요. 라우터는 어떤 워커를 부를지 알고, 워커가 받는 입력은 타입으로 정해져 있으며, 실행 이력도 같은 데이터베이스에 남길 수 있어요. 실패하면 같은 실행 단위를 다시 돌리거나 사용자에게 실패를 설명하면 돼요. 서로 이미 알고 있으니 이 구조에는 발견(discovery)이 필요 없어요.

외부 또는 로컬의 독립 에이전트라면 호출 전에 그 에이전트가 어떤 입력 형식을 받는지, 스트리밍을 지원하는지, 인증이 필요한지, 어떤 산출물을 돌려주는지 알아야 해요. 이 정보가 코드 주석이나 README에만 있으면 런타임 라우터는 판단할 수 없어요. 결국 사람이 아는 내용을 설정 파일로 옮기거나, 호출에 실패한 뒤에야 알게 돼요.

MCP는 에이전트가 도구, API, 리소스에 접근하는 경계를 다뤄요. 데이터베이스를 조회하고 파일을 읽거나 사내 API를 부르는 일이 여기에 해당해요. 호출자는 여전히 하나의 에이전트이고, 도구는 보통 요청받은 기능을 수행해요.

A2A에서는 상대도 에이전트예요. 상대가 자체 프롬프트와 메모리, 도구, 정책을 가질 수 있고, 요청을 바로 처리하는 대신 추가 질문을 할 수도 있어요. 오래 걸리는 작업은 별도 Task로 만들 수도 있죠. 그러면 호출자는 함수 반환값만 기다리는 대신 상대 에이전트의 실행 상태를 추적해야 해요.

PR 리뷰를 만드는 쪽에서 내부 코드 diff를 읽고 모델만 호출한다면 내부 워커로 충분해요. 별도 저장소를 분석하고 자체 인덱스를 가진 코드 분석 에이전트에게 리뷰 일부를 맡긴다면 달라져요. 이때는 “리뷰 함수 호출 규격”보다 “상대 에이전트에게 어떤 단위로 일을 맡기고, 결과를 어떤 증거로 보존할지”를 정해야 해요.

## Agent Card로 상대의 능력을 확인한다

A2A v1.0에서 Agent Card는 에이전트의 identity와 capability를 드러내는 자기 설명 문서예요. v1.0 specification은 well-known URI로 https://{server_domain}/.well-known/agent-card.json을 제시하고, registry/catalog나 직접 설정도 발견 방법으로 둬요. 일부 예제나 이전 문맥에서는 비슷한 well-known 경로가 다르게 보일 수 있으니, v1.0을 기준으로 볼 때는 agent-card.json을 먼저 확인하는 편이 안전해요.

공식 proto 정의를 보면 Agent Card가 단순한 소개문이 아니라는 걸 알 수 있어요.

```plain text
message AgentCard {
  string name = 1 [(google.api.field_behavior) = REQUIRED];
  string description = 2 [(google.api.field_behavior) = REQUIRED];
  repeated AgentInterface supported_interfaces = 3 [(google.api.field_behavior) = REQUIRED];
  AgentProvider provider = 4;
  string version = 5 [(google.api.field_behavior) = REQUIRED];
  optional string documentation_url = 6;
  AgentCapabilities capabilities = 7 [(google.api.field_behavior) = REQUIRED];
  map<string, SecurityScheme> security_schemes = 8;
  repeated SecurityRequirement security_requirements = 9;
  repeated string default_input_modes = 10 [(google.api.field_behavior) = REQUIRED];
  repeated string default_output_modes = 11 [(google.api.field_behavior) = REQUIRED];
  repeated AgentSkill skills = 12 [(google.api.field_behavior) = REQUIRED];
  repeated AgentCardSignature signatures = 13;
  optional string icon_url = 14;
}
```

Agent Card에는 지원 인터페이스, 프로토콜 버전, capability, security scheme, input/output mode, skill이 담겨요. 기존의 “등록된 워커 목록”이 내부 구현 목록이라면, A2A식 Agent Card는 이를 외부에 일을 맡길 때 쓸 계약으로 바꿔요. 라우터가 “저 에이전트에게 지금 이 일을 맡길 수 있는가?”를 판단할 근거가 되는 데이터예요.

Agent Card 안의 skill은 에이전트가 잘 수행할 만한 행동을 더 구체적으로 설명해요. 공식 proto에는 id, name, description, tags, examples, input_modes, output_modes, security_requirements가 있어요. 라우터는 자연어로 들어온 의도를 skill 후보와 맞춰 볼 수 있어요. “PR을 봐 달라”는 요청은 코드 리뷰 skill로, “지난주 보고서 초안”은 업무 로그 skill로 이어질 수 있죠.

Agent Card가 있다고 신뢰까지 자동으로 생기지는 않아요. A2A는 Agent Card를 JWS로 서명할 수 있게 하고, JavaScript SDK도 서명 검증 기능을 제공해요. 그래도 “이 사용자의 요청을 저 에이전트에게 넘겨도 되는가”, “어떤 토큰을 위임할 것인가”, “외부 에이전트가 돌려준 텍스트를 다시 LLM 프롬프트에 넣어도 되는가”는 제품에서 정할 정책이에요. 공개 Slack 요청을 받아 민감한 저장소 정보를 외부 에이전트에게 넘긴다면, Agent Card를 살피기 전에 접근 제어와 데이터 마스킹부터 필요해요.

## Message와 Task로 대화와 실행을 구분한다

A2A의 실행 모델은 Message와 Task를 구분해요. Message는 사용자나 에이전트가 보낸 말 한 차례로, role과 parts를 가져요. 단순 질의응답이나 범위 협상, 추가 질문에 어울려요. Task는 추적할 수 있는 실행 단위예요. 오래 걸리거나 상태가 바뀌는 일, 중간에 입력이 더 필요하거나 나중에 결과를 다시 가져와야 하는 일에 맞아요.

공식 specification의 기본 Task 실행 예시를 보면 이 차이가 잘 드러나요.

```plain text
POST /message:send HTTP/1.1
Host: agent.example.com
Content-Type: application/a2a+json
Authorization: Bearer ***

{
  "message": {
    "role": "ROLE_USER",
    "parts": [{"text": "What is the weather today?"}],
    "messageId": "msg-uuid"
  }
}
```

```plain text
HTTP/1.1 200 OK
Content-Type: application/a2a+json

{
  "task": {
    "id": "task-uuid",
    "contextId": "context-uuid",
    "status": {"state": "TASK_STATE_COMPLETED"},
    "artifacts": [{
      "artifactId": "artifact-uuid",
      "name": "Weather Report",
      "parts": [{"text": "Today will be sunny with a high of 75°F"}]
    }]
  }
}
```

날씨 예시는 단순하지만 Slack 시스템에 대입하면 “휴가 잔여 계산”처럼 입력이 작고 결과가 정해지는 작업에 가까워요. 반면 “PR 리뷰 생성”이나 “주간 업무 로그 초안”은 실행을 추적해야 해요. 사용자는 Slack에서 기다리는 동안 내부 모델 호출이 오래 걸릴 수 있고, 실패하면 다시 실행해야 할 수도 있으니까요. 이런 일은 Message 하나로 끝내기보다 Task로 보는 편이 자연스러워요.

A2A에서 contextId는 관련된 Message와 Task를 묶는 논리적 맥락이에요. 첫 요청에서 새 context가 생기고, 이후 요청에 같은 contextId를 붙여 대화를 이어갈 수 있어요. taskId는 그 안의 특정 실행 단위를 가리켜요. 한 맥락에서 여러 Task가 생길 수 있고, 후속 요청에서 이전 Task를 참조할 수도 있어요.

사용자가 “아까 그 리뷰에서 보안 관점만 다시 봐 줘”라고 하면 대화 맥락은 이어지지만, 산출물과 상태는 따로 갖는 새 실행이 필요해요. A2A에서는 같은 contextId 아래 새 Task를 만들고 referenceTaskIds로 이전 Task를 참조해요. Slack 대화 스레드의 “첫 리뷰”, “보안 관점 재검토”, “작성자 답변 수용 여부 판단”도 각각 별도 실행으로 남길 수 있어요.

| A2A 개념 | Slack 멀티 에이전트 시스템에서의 대응 |
| --- | --- |
| contextId | 하나의 Slack 대화나 사용자의 연속 요청을 묶는 상위 맥락 |
| taskId | 모델 호출과 워커 실행을 추적하는 개별 실행 ID |
| terminal state | 성공, 실패, 취소, 거절처럼 더 이상 같은 실행을 수정하지 않는 상태 |
| Artifact | 최종 리뷰, 업무 로그 초안, 계획표, 구조화 JSON처럼 보존해야 하는 결과 |

## Artifact로 잃으면 안 되는 결과를 남긴다

A2A는 Message와 Artifact의 역할을 나눠요. Message로 작업을 시작하고 상태를 설명하거나 추가 입력을 요청해요. Artifact는 Task의 결과물이에요. 문서, 이미지, 구조화 데이터, 파일처럼 후속 작업의 근거가 되는 출력은 Artifact로 남겨요.

이 구분은 스트리밍 도중 연결이 끊겼다가 다시 붙을 때 중요해요. specification은 streaming update를 받는 클라이언트가 재연결하면 모든 status message를 받지 못할 수 있다고 봐요. 그래서 중요한 정보를 Message 전달에만 맡겨서는 안 돼요. 최종 보고서나 코드 변경안처럼 잃으면 안 되는 결과는 Task에 연결된 Artifact로 남겨야 해요.

긴 작업의 스트리밍 예시를 보면 이 판단이 더 분명해져요.

```plain text
POST /message:stream HTTP/1.1
Host: agent.example.com
Content-Type: application/a2a+json
Authorization: Bearer ***

{
  "message": {
    "role": "ROLE_USER",
    "parts": [{"text": "Write a detailed report on climate change"}],
    "messageId": "msg-uuid"
  }
}
```

```plain text
HTTP/1.1 200 OK
Content-Type: text/event-stream

data: {"task": {"id": "task-uuid", "contextId": "context-uuid", "status": {"state": "TASK_STATE_WORKING"}}}

data: {"artifactUpdate": {"taskId": "task-uuid", "contextId": "context-uuid", "artifact": {"parts": [{"text": "# Climate Change Report\n\n"}]}}}

data: {"statusUpdate": {"taskId": "task-uuid", "contextId": "context-uuid", "status": {"state": "TASK_STATE_COMPLETED"}}}
```

Slack에서는 진행 메시지가 사용자 경험에 영향을 줘요. “처리 중”이라는 응답이 없으면 사용자는 봇이 죽었다고 느껴요. 하지만 운영과 감사에는 진행 메시지보다 최종 Artifact가 더 중요해요. PR 리뷰 본문, 업무 보고 초안, 오늘 할 일 목록이 Slack 응답에만 남아서는 안 돼요. 재시도하거나 다시 요약하고 후속 결과와 비교하려면 실행 기록에도 결과물로 남겨야 해요.

A2A의 Task는 terminal state에 도달하면 다시 시작하지 않아요. completed, failed, canceled, rejected가 끝 상태예요. 이후 수정이나 후속 요청에는 같은 contextId 아래 새 Task를 만들어요. 끝난 Task가 다시 살아나면 “이 Artifact는 어떤 입력에서 나왔는가”, “실패한 뒤 무엇을 바꿔 재시도했는가”, “사용자가 본 결과와 현재 저장된 결과가 같은가”를 설명하기 어려워져요.

현재 구조에서 실패한 모델 호출을 같은 실행 레코드의 상태만 바꿔 다시 쓴다면 A2A식 실행 모델과 맞지 않아요. 실패한 실행은 실패로 닫고, 같은 상위 맥락에서 새 실행을 만들어 이전 실행을 참조하게 하면 나중에 분석하기 쉬워요. “재시도”는 같은 Task를 되살리는 게 아니라 이전 Task를 근거로 새 Task를 만드는 일이에요.

## 모든 워커를 A2A 대상으로 보지는 않는다

이대리 같은 Slack 기반 LLM 멀티 에이전트 시스템에서 A2A가 가장 먼저 영향을 주는 곳은 의도 분류 라우터예요. 지금은 라우터가 사용자 말을 보고 내부 워커를 골라요. 여기에 Agent Card 개념을 넣으면 “코드에 등록된 워커”뿐 아니라 “발견 가능한 외부 에이전트”도 후보로 볼 수 있어요. 판단에 필요한 것은 “무슨 일을 할 수 있는가”, “입출력 형식은 무엇인가”, “인증과 스트리밍을 지원하는가”예요.

두 번째는 실행 이력이에요. 지금도 에이전트 실행에는 시작, 실행, 종료의 생명주기가 있어요. A2A를 읽고 점검할 것은 이 실행 ID가 taskId 역할을 할 수 있는지, Slack 스레드나 사용자 요청 묶음이 contextId 역할을 할 수 있는지, 실패와 취소가 terminal state로 닫히는지예요.

세 번째는 결과 저장이에요. Slack 응답은 사용자에게 보여주는 화면이고, Artifact는 시스템이 보존하는 결과예요. PR 리뷰, 업무 로그 초안, 하루 계획은 모두 후속 작업의 입력이 될 수 있어요. 결과가 텍스트 응답으로만 흘러가면 나중에 “무엇을 근거로 다음 에이전트가 판단했는가”를 찾기 어려워요.

모든 워커에 A2A를 적용할 필요는 없어요. 자연어에서 숫자 몇 개를 뽑아 정해진 방식으로 계산하는 휴가 계산 같은 기능은 독립 에이전트에게 맡기기보다 내부 유스케이스로 두는 편이 나아요. 결과가 작고 권한 경계도 단순하며 외부에서 발견할 필요도 없어요. 여기에 A2A Task를 억지로 씌우면 추적 객체만 늘어나요.

웹훅으로 들어온 이슈에 라벨을 붙이는 작업도 입력과 출력이 짧고 자동 트리거가 분명하다면 마찬가지예요. 외부 에이전트가 자체 정책에 따라 오래 실행하는 작업이라면 A2A 후보가 되지만, 단순 모델 분류라면 내부 실행 이력만으로 충분해요.

반대로 외부 지식 저장소를 가진 연구 요약 에이전트, 별도 코드 인덱스를 가진 리뷰 에이전트, 긴 작업을 비동기로 진행하고 결과 파일을 돌려주는 생성 에이전트는 A2A 후보예요. 이 경우에는 상대의 capability와 Task 상태를 런타임에 확인할 가치가 있어요.

| 작업 성격 | A2A 후보인가 | 이유 |
| --- | --- | --- |
| 짧은 자연어 파라미터 추출 후 결정적 계산 | 낮음 | 발견, Task, Artifact의 이점보다 구현 비용이 큼 |
| Slack 요청을 받아 긴 보고서나 리뷰를 생성 | 중간 | 내부 실행 이력은 필요하고, 외부화되면 A2A 경계가 유용함 |
| 별도 런타임·권한·저장소를 가진 전문 에이전트 호출 | 높음 | Agent Card와 Task lifecycle이 위임 계약으로 작동함 |
| 내부 전용 배치 분석과 운영 신호 감지 | 상황 의존 | 외부 에이전트로 분리할 계획이 없다면 내부 계약으로 충분함 |

## 다음 확인은 실행 구조와 위임 후보의 경계다

A2A JavaScript SDK는 @a2a-js/sdk로 제공되며 JSON-RPC, HTTP+JSON/REST, gRPC를 지원해요. TypeScript·NestJS 백엔드라면 기술적으로 접근하기 좋은 편이에요. 그래도 패키지 설치부터 시작할 필요는 없어요. 먼저 현재 실행 구조를 A2A 개념에 맞춰 4줄로 적어 봐야 해요. contextId는 무엇이고, taskId는 무엇이며, terminal state는 무엇이고, Artifact는 어디에 저장되는지요.

이 표를 쓰다 막히는 곳이 실제 설계 부채다. 예를 들어 Slack 스레드와 내부 실행이 느슨하게만 연결되어 있다면 context 설계가 약한 것이다. 최종 결과가 Slack 메시지에만 있고 별도 결과 테이블이나 파일 레코드가 없다면 Artifact 자리가 빈 것이다. 실패한 실행을 재사용하고 있다면 terminal state의 의미가 흐린 것이다.

그다음에는 내부 워커 하나를 Agent Card처럼 설명해 볼 수 있어요. “이 워커는 어떤 input mode를 받는가”, “출력은 text인가 structured JSON인가”, “스트리밍이 필요한가”, “사용자 추가 입력 상태가 있는가”를 적어 보면 돼요.

A2A는 opaque agent 사이의 협업을 목표로 해요. 내부 메모리와 도구, 프롬프트를 공개하지 않고도 협업할 수 있다는 게 장점이에요. 다만 opaque하다는 것은 클라이언트가 상대 내부를 볼 수 없다는 뜻이기도 해요. 그래서 외부 에이전트의 Agent Card, status message, Artifact는 모두 검증되지 않은 입력으로 다뤄야 해요.

특히 Slack 라우터가 외부 Agent Card의 설명을 그대로 LLM 프롬프트에 넣는 구조는 조심해야 해요. Agent Card의 description이나 skills.description도 외부 입력이니까요. capability를 발견하는 데 쓰더라도 필드를 검증하고 프롬프트 주입을 막아야 해요. 인증도 “Bearer 토큰을 붙인다”로 끝나지 않아요. 사용자의 권한을 어디까지 위임할지, 외부 에이전트가 받은 데이터를 얼마나 보관할 수 있을지 별도 정책이 필요해요.

다음에는 현재 실행 이력에서 A2A의 context, task, terminal state, artifact가 각각 어디에 대응되는지 적고, 외부 위임 후보 워커 하나를 골라 Agent Card 초안을 만들어 볼 계획이에요.

### 참고한 출처

- https://a2a-protocol.org/latest/
- https://a2a-protocol.org/v1.0.0/topics/life-of-a-task/
- https://github.com/a2aproject/A2A
- https://github.com/a2aproject/A2A/blob/main/docs/specification.md
- https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto
- https://github.com/a2aproject/a2a-js
- https://codelabs.developers.google.com/intro-a2a-purchasing-concierge
