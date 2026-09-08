---
title: "Deep Agents는 프레임워크보다 실행 하네스다"
description: "Deep Agents의 planning, filesystem, subagents, human-in-the-loop를 장기 에이전트 작업의 실행 구조라는 관점에서 살펴본다."
pubDatetime: 2026-08-27T19:06:00+09:00
category: backend
---

## 한 번의 호출로 끝나지 않는 일이 늘어날 때

제가 운영하는 Slack 에이전트에게 “오늘 할 일 정리해 줘”라고 시키는 정도라면 구조는 단순해요. 입력을 받은 뒤 필요한 데이터를 몇 번 조회하고, 모델을 한 번 호출해 결과를 Slack에 돌려줘요. NestJS usecase 하나가 요청을 받아 ModelRouter를 호출하고 결과를 포맷팅하면 끝나요.

“지난 PR 몇 개를 보고 이번 주 업무 로그를 만들고, 누락된 테스트 리스크를 따로 정리하고, 블로그 후보까지 뽑아 줘” 같은 요청은 한 번의 LLM 호출로 다루기 어려워요. GitHub 결과와 리뷰 메모가 길어지고 초안도 여러 번 바뀌니까요. 일부 단계가 실패해도 전체 작업을 재개할 수 있어야 해요.

이때 병목은 “어떤 모델을 붙일까”가 아니에요. 라우터가 있고 에이전트 역할까지 나뉘었다면 이제 실행 구조를 고민해야 해요. 긴 작업을 어떻게 쪼개고 중간 산출물을 어디에 둘지, 하위 작업을 실행할 컨텍스트와 위험한 도구 호출을 멈출 지점은 어디일지 정해야 해요. Deep Agents 패턴은 바로 이 지점에서 의미가 생겨요.

이 글은 LLM 호출 한 번으로 끝나는 에이전트를 이미 굴리고 있고 이제 여러 단계로 이어지는 작업을 맡기려는 백엔드 개발자를 위해 썼어요. 읽고 나면 Deep Agents가 장기 실행을 어떤 장치로 떠받치는지, 그 장치를 이미 굴러가는 실행 기록 위에 어떻게 얹을지 그림을 그릴 수 있어요. 다루는 범위는 하네스의 구조와 도입 판단까지이고, 성능 벤치마크나 모델 비교는 다루지 않아요. 아래는 공식 문서와 LangChain 블로그를 읽고 정리한 내용이라, 아직 지금 쓰는 시스템에 붙여 돌려본 결과는 아니에요.

## Deep Agents는 더 똑똑한 루프가 아니라 실행 하네스다

Deep Agents는 “agent harness”인데, 기존 tool-calling loop를 버리는 구조는 아니에요. LLM이 메시지를 보고 도구를 호출한 뒤 결과를 읽고 다음 행동을 정하는 기본 루프는 그대로 두고, 여기에 장기 작업에 필요한 장치를 기본으로 붙이는 거죠.

이름이 겹쳐 헷갈리기 쉬운데, deepagents는 이 하네스를 구현한 패키지 이름이에요. LangChain 문서는 deepagents가 LangChain의 구성 요소 위에 서고 실행 런타임으로는 LangGraph를 쓴다고 설명해요. 지속 실행과 스트리밍, human-in-the-loop 같은 기능은 그 런타임이 대 주는 몫이죠. 정리하면 LangChain이 프레임워크, LangGraph가 런타임, deepagents가 그 위에 얹힌 하네스예요.

이 하네스의 뼈대는 planning, filesystem, subagents, detailed prompts 네 장치로 좁혀져요.

이 하네스가 무엇을 대신 해 주는지는 기본값 목록만 봐도 드러나요. 기본 기능에는 write_todos와 파일 도구, task subagent가 들어가고, smart defaults(설정을 비워 두면 알아서 잡히는 기본값)와 context management(모델에 넣을 정보를 고르고 줄이고 다른 곳으로 옮기는 일)까지 딸려 와요. deepagents의 성격을 한 마디로 줄이면 “batteries-included agent harness”, 그러니까 필요한 장치를 미리 다 넣어 둔 실행 하네스예요. 별도 도구나 프롬프트를 거의 붙이지 않고도 createDeepAgent를 만들 수 있거든요.

아래 코드를 그대로 돌려 보려면 세 가지가 필요해요. 패키지는 문서의 quickstart 기준으로 `npm install deepagents langchain @langchain/core`인데, 문서가 버전을 고정해 두지 않아 제가 확인한 버전 번호는 없어요(미확인). 런타임은 LangGraph가 맡고, Node.js 최소 버전은 문서에 적혀 있지 않아 이것도 미확인이에요. 모델 자격증명은 provider별로 필요하지만 어떤 환경변수 이름을 쓰라는 안내를 이 문서에서는 찾지 못했어요.

```typescript
import { createDeepAgent } from "deepagents";

const agent = createDeepAgent();

const result = await agent.invoke({
  messages: [
    {
      role: "user",
      content: "Research LangGraph and write a summary in summary.md",
    },
  ],
});
```

여기서 눈여겨볼 부분은 “summary.md에 쓰라”는 지시예요. 일반적인 채팅 에이전트는 긴 조사 결과를 대화창에 계속 밀어 넣지만, Deep Agents는 중간 산출물을 파일로 내려요. 대화 컨텍스트는 모든 원문을 쌓아 두는 창고가 아니라 다음 행동의 방향을 트는 조정면, 그러니까 비행기 날개에 달려 기체를 기울이는 그 작은 판에 가까워요. 지금 판단하는 데 필요한 압축 정보만 그 위에 올라가 있죠.

## 계획과 파일과 서브에이전트는 따로 놀지 않는다

첫 번째 장치인 planning은 도구가 write_todos 하나뿐이에요. 사람이 보기 좋은 체크리스트라기보다, 장기 작업의 현재 상태를 모델이 계속 갱신하도록 돕는 작업 상태예요. 긴 작업에서는 끝낸 일과 남은 일, 다음 행동이 쉽게 흐려지는데 todo 상태가 이런 흐림을 줄여줘요.

### 파일은 첨부가 아니라 작업 공간이다

그다음은 virtual filesystem이에요. 기본 파일 도구는 여섯 개인데, ls로 목록을 보고 read_file로 읽고 write_file로 쓰고 edit_file로 고치고, glob과 grep으로 찾아요. 각 도구에는 옵션도 달려 있어요. read_file은 offset과 limit를 줘서 큰 파일을 처음부터 끝까지 읽지 않고 필요한 구간만 잘라 볼 수 있어요. glob은 `**/*.py` 같은 패턴으로 경로를 훑고, sandbox backend를 붙이면 execute로 명령까지 실행할 수 있어요.

deepagents Python 패키지의 0.2 릴리스에서는 filesystem backend가 더 중요해졌어요. 이전에는 LangGraph state 위의 virtual filesystem이었어요. [0.2부터는 Backend 추상화로](https://www.langchain.com/blog/doubling-down-on-deepagents) LangGraph State와 LangGraph Store를 붙일 수 있고, 실제 로컬 파일시스템과 composite backend까지 연결돼요. composite backend는 경로별로 다른 저장소를 물리는 구성이라, 예를 들면 `/memories/` 아래만 오래 남는 저장소로 보내고 나머지는 그 실행이 끝나면 사라지게 둘 수 있어요.

filesystem은 단순한 첨부 저장소가 아니에요. 조사 원문과 diff 분석 로그, 초안, 검증 결과, 실패한 도구 호출의 흔적을 파일로 내리면 메인 대화 컨텍스트가 덜 오염돼요. large tool result eviction도 같은 방향이라, 큰 도구 결과가 토큰 임계값을 넘으면 파일시스템에 덤프하고 오래된 대화 이력은 summarization으로 압축해요.

### 서브에이전트는 맥락을 격리한다

세 번째 장치가 subagent예요. subagent는 “context quarantine”, 그러니까 맥락 격리에 유용해요. 하위 에이전트는 독립된 컨텍스트 창에서 작업해 메인 에이전트의 컨텍스트를 더럽히지 않고, 작업을 마치면 결과만 돌려줘요. 전문 역할을 붙일 수도 있지만 더 본질적인 가치는 이 격리와 압축에 있어요.

subagent를 하나 정의하는 값은 생각보다 싸요.

- 필수: name, description, systemPrompt
- 선택: tools, model, middleware, interruptOn, skills, responseFormat, permissions

문서에 실린 정의 예시를 그대로 옮기면 아래와 같아요. 필수 세 필드가 리터럴 안 어디에 놓이는지, 그리고 그렇게 만든 정의를 배열에 담아 createDeepAgent에 넘기기까지가 한 화면에 들어와요.

```typescript
const researchSubagent: SubAgent = {
  name: "research-agent",
  description: "Used to research more in depth questions",
  systemPrompt: "You are a great researcher",
  tools: [internetSearch],
  model: "google-genai:gemini-3.6-flash",
};
const subagents = [researchSubagent];

const agent = createDeepAgent({
  model: "openai:gpt-5.5",
  subagents,
});
```

따로 정의하지 않아도 격리는 이미 켜져 있어요. [같은 이름의 동기 subagent를 직접 주지 않는 한 general-purpose subagent가 자동으로 추가돼요](https://docs.langchain.com/oss/javascript/deepagents/subagents). 이 subagent는 파일 도구를 기본으로 갖고 같은 모델과 도구를 쓰지만 독립된 컨텍스트에서 실행되고, 동기 subagent를 쓰면 메인 에이전트는 결과를 받을 때까지 기다려요. 작업이 더 길거나 병렬 실행, 중간 조정, 취소가 필요하다면 async subagents 쪽이에요.

### 네 번째 장치는 프롬프트 자체다

detailed prompts(하네스가 미리 써 둔 긴 지시문)는 앞의 세 장치를 실제로 쓰이게 만드는 접착제예요. LangChain 블로그는 deep agent의 네 요소를 planning tool과 filesystem, subagents, detailed prompts로 꼽으면서 출시 때부터 이 넷이 built in이라 개발자는 자기 도구와 프롬프트만 얹으면 됐다고 적어요. 도구를 쥐여 주는 것만으로는 모델이 write_todos를 언제 갱신할지, 어떤 결과를 파일로 내릴지, 어떤 일을 subagent에 넘길지 정하지 못해요. JavaScript 문서도 system prompt와 memory, skills, tool prompt가 “에이전트가 무엇을 갖고 시작하는지”를 정한다고 설명해요. 다만 그 문서는 detailed prompts를 별도 항목으로 이름 붙여 나열하지는 않아서, 네 장치라는 구획 자체는 블로그 쪽 표현을 따랐어요.

## 사람이 끼어야 하는 지점도 하네스의 일부다

장기 작업에서 위험한 순간은 모델이 “그럴듯한 다음 행동”을 너무 자연스럽게 고를 때예요. 파일 삭제나 알림 발송, 외부 시스템 변경 같은 도구 호출에는 자동 실행보다 승인 지점이 필요해요. human-in-the-loop는 interruptOn으로 특정 도구를 호출하기 전에 멈춰요. 이때는 checkpointer가 필요해요. 멈춘 실행 상태를 저장했다가 사람이 승인·수정·거절한 뒤 같은 config로 재개해야 하니까요.

remove_file, fetch_file, notify_email마다 다른 interrupt 정책을 둘 수 있어요. remove_file은 기본 승인 흐름을 켜고, fetch_file은 끄고, notify_email은 approve/reject만 허용해요. 이름 표기가 두 갈래로 갈리는데, interruptOn의 키는 모델이 호출하는 도구 이름이라 snake_case이고 tools 배열에 넘기는 removeFile·fetchFile·notifyEmail은 그 도구를 담은 TypeScript 변수라 camelCase예요. 표기만 다를 뿐 같은 대상을 가리켜요.

표기가 갈리는 자리가 하나 더 있어요. 같은 JavaScript 문서인데도 subagents 페이지는 모델 이름을 `google-genai:`로 쓰고 human-in-the-loop 페이지는 `google_genai:`로 써요. [JavaScript 모델 문서](https://docs.langchain.com/oss/javascript/langchain/models)가 provider 접두사로 드는 건 하이픈 쪽이고, 언더스코어는 [Python 문서](https://docs.langchain.com/oss/python/langchain/models)가 쓰는 표기예요. 그래서 아래 코드는 앞의 subagent 예시와 같은 하이픈으로 맞췄어요.

```typescript
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";

const checkpointer = new MemorySaver();

const agent = createDeepAgent({
  model: "google-genai:gemini-3.6-flash",
  tools: [removeFile, fetchFile, notifyEmail],
  interruptOn: {
    remove_file: true,
    fetch_file: false,
    notify_email: { allowedDecisions: ["approve", "reject"] },
  },
  checkpointer,
});
```

재개하는 쪽은 문서에 예시가 따로 있어요. thread_id를 담은 config를 만들어 첫 invoke에 넘기고, 사람이 결정을 내린 뒤 `new Command({ resume: { decisions } })`를 같은 config로 다시 invoke해요. 같은 config여야 checkpointer가 아까 멈춘 그 실행을 찾아내죠. 아래는 문서 예시에서 thread_id 생성만 고정 문자열로 바꾼 형태이고, 문서 예시에도 import 구문이 없어 Command와 decisions의 출처까지는 확인하지 못했어요.

```typescript
const config = { configurable: { thread_id: "run-2026-08-27-01" } };
const messages = [{ role: "user", content: "Delete the file temp.txt" }];

let result = await agent.invoke({ messages }, config);

// 사람이 approve·edit·reject·respond 중 하나를 고른 뒤
result = await agent.invoke(new Command({ resume: { decisions } }), config);
```

결정 타입도 중요한데, 응답은 approve, edit, reject, respond로 나뉘어요. 특히 respond는 사람이 도구 역할을 대신해 답할 때 쓰고, [side effect가 있는 도구를 거절할 때는 쓰면 안 돼요](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop). 모델이 그 응답을 성공한 도구 결과로 해석할 수 있기 때문이죠.

## 멀티에이전트는 공짜 성능 향상이 아니다

Deep Agents 패턴을 보면 모든 작업을 subagent로 나누고 싶어지지만, Anthropic의 multi-agent research system 글은 비용 문제를 분명히 짚어요. 이 연구 시스템은 lead agent가 전략을 세우고 여러 subagent가 병렬로 조사하는 orchestrator-worker 구조인데, lead agent는 각 subagent가 돌려준 결과를 압축해 받아요.

subagent는 기본값이 아니라 정책으로 다뤄야 해요. 내부 평가에서 multi-agent research는 single-agent보다 좋은 결과를 냈지만 토큰 사용량도 함께 크게 늘었거든요. 일반 chat보다 agent는 약 4배, multi-agent system은 약 15배 토큰을 쓸 수 있어요. 이 배수는 채팅 대화를 기준으로 잡은 값이고, 어떤 과제에서 어떤 토큰을 어떻게 셌는지까지는 그 글에 적혀 있지 않아요.

Anthropic은 넓은 정보 공간과 한 컨텍스트 창을 넘는 자료, 병렬 탐색과 복잡한 도구, 고가치 의사결정을 대상으로 봐요. 반대로 모든 하위 작업이 같은 공유 컨텍스트를 봐야 하거나 의존성이 촘촘해 병렬화하기 어렵다면 맞지 않는데, coding task가 research보다 병렬화할 수 있는 작업이 적을 때가 많은 것도 결국 같은 이유예요.

이 한계는 실무 설계에 바로 이어져요. “역할이 많으니 멀티에이전트”라고 정할 게 아니라, 중간 결과가 너무 크고 독립적으로 탐색할 수 있으며 실패해도 회수할 수 있는지부터 봐야 하죠. 단순 포맷팅이나 짧은 파라미터 추출, 작은 diff 리뷰라면 굳이 Deep Agents식 하네스를 태울 이유가 없어요.

## 제 Slack 에이전트 시스템에서 먼저 걸리는 자리는 agent-run이다

제가 굴리는 시스템에는 에이전트 실행 한 건의 라이프사이클을 남기는 agent-run이 이미 있어요. 이미 그 축이 있다면 새 프레임워크를 통째로 들이기보다 AgentRun 아래에 실행 상태를 확장하는 편이 자연스러워요. 프레임워크를 그대로 도입하면 LangGraph 런타임과 checkpointer용 상태 저장소를 새로 얹어야 하고, 거기 쌓이는 실행 기록이 이미 agent-run에 쌓고 있는 기록과 이중으로 남거든요. 이건 문서를 읽고 내린 판단이지 두 방식을 나란히 돌려 보고 고른 결과는 아니에요. todo 상태와 artifact 경로, child run 관계, human approval interrupt 지점을 AgentRun에 연결하는 게 첫 실험 대상이에요. Anthropic식 lead/subagent 관계도 이미 존재하는 parentId 같은 실행 관계와 잘 맞아요.

하루 계획을 만드는 agent/pm은 planning과 궁합이 좋아요. daily plan은 결과물처럼 보이지만 실제로는 여러 입력을 우선순위에 따라 재배열하는 작업이에요. write_todos에 해당하는 내부 상태가 있으면 “오늘 계획 생성”을 “계획 초안 → 근거 보강 → 누락 확인 → 최종안”으로 바꿀 수 있어요.

agent/cto는 PM이 잡은 일감을 BE worker에게 나눠 주는데, 이때 하위 작업의 원문이 전부 한 컨텍스트에 쌓이기 쉬워요. worker 실행을 child run으로 격리해 압축된 결과만 회수하면 그 부담이 줄어요.

그렇다고 스키마 변경을 제안하는 agent/be-schema, Jest spec을 뽑는 agent/be-test, 구현을 맡는 agent/be, diff를 읽는 agent/code-reviewer가 전부 독립 subagent 후보라고 해서 늘 병렬로 켤 일은 아니에요. schema 변경 제안과 Jest spec 생성은 같은 diff를 보더라도 산출물이 달라 분리할 가치가 있는 반면, 작은 수정 하나에 모든 worker를 켜면 토큰만 낭비해요.

### 중간 산출물이 많은 워커일수록 파일로 내려야 한다

블로그 초안을 쓰는 agent/blog, 업무 회고를 만드는 agent/work-reviewer, 정해진 시각에 하루 일과를 순서대로 도는 autopilot, 실행 이상 징후를 모아 운영 조언을 내는 ops-supervisor는 filesystem 기반 artifact store의 효과를 크게 볼 수 있어요. 초안과 회고 메모, 후보 목록, 검증 로그처럼 중간 산출물이 많은 작업이기 때문이에요. Slack 응답에는 최종 요약과 링크만 남기고, 긴 조사 메모와 초안 이력은 파일이나 저장소에 내려두면 덜 흔들려요.

### sandbox는 preview와 apply를 갈라야 안전하다

sandbox와 agent/be-sandbox에서는 테스트가 실제로 돌고 코드가 생성되고 파일 수정 제안이 나와요. 자동화할 가치가 큰 만큼 side effect도 따라오죠. execute와 human approval의 경계가 바로 여기라서, preview 단계와 apply 단계를 나누고 쓰기·삭제·외부 알림 도구는 interrupt 지점으로 취급해요.

## 다 만들 필요는 없고 AgentRun의 네 자리면 시작된다

앞에서 꼽은 네 자리를 최소 단위로 잡고 시작해 보려고 해요. 이건 하네스의 네 장치(planning, filesystem, subagents, detailed prompts)와는 다른 목록으로, 그 장치들을 제 실행 기록 위에 얹으려고 AgentRun에 새로 내는 자리예요. 이걸로 충분한지는 붙여 본 뒤에야 말할 수 있고요. 처음부터 범용 LangGraph clone을 만들 필요는 없고, 현재 실행 기록 위에 장기 작업의 “작업판”을 얹는 정도로 시작하면 돼요.

subagent를 켜는 정책도 필요해요. Anthropic의 글을 기준으로 breadth-first 탐색과 대량 자료, 독립 검증, 고가치 산출물에는 켜고, 짧은 단일 작업이나 강한 공유 컨텍스트가 필요한 작업에는 꺼요. 여기서 breadth-first 탐색은 한 줄기를 끝까지 파고들기 전에 후보를 넓게 훑는 방식이에요. 이 정책이 없으면 Deep Agents 패턴은 안정성 장치가 아니라 토큰을 태우는 장치가 되죠.

### 붙여 보기 전에 무엇으로 판정할지 정해 둔다

아직 아무것도 재지 않았으니, 붙이고 나서 무엇을 근거로 판정할지를 먼저 적어 둘게요. 아래는 전부 계약이지 측정 결과가 아니에요.

도입부에서 세운 네 기준을 그대로 판정 항목으로 써요.

- 쪼개기: 요청 하나가 몇 개의 단계로 나뉘고 각 단계가 실행 기록에 개별 행으로 남는지 봐요. 지금은 요청 하나가 실행 한 건으로만 남아요.
- 중간 산출물 위치: 조사 원문과 초안이 Slack 메시지 본문이 아니라 파일 경로로 남는지, 그 경로를 실행 기록에서 되짚을 수 있는지 봐요.
- 하위 컨텍스트: worker 실행이 child run으로 갈라지는지, 부모에게 돌아온 결과가 원문보다 짧은지 봐요.
- 멈출 지점: 쓰기·삭제·외부 알림 도구 호출이 승인 카드 없이 실행된 사례가 남는지 봐요.

성공 조건은 네 항목이 모두 관찰되고, 같은 요청을 중간에 끊었다가 재개했을 때 이미 끝난 단계를 다시 실행하지 않는 상태로 잡아요.

측정 환경은 지금 운영 중인 NestJS 서비스와 그 실행 기록 테이블이고 별도 벤치마크 장비는 쓰지 않아요. 지표는 요청당 실행 단계 수, 요청당 총 입력·출력 토큰, 마지막 단계까지 도달한 비율, 승인이 요구된 도구 호출 수 네 가지예요. 측정 방법은 같은 요청 문구를 고정해 두고 며칠에 걸쳐 반복 실행한 뒤 실행 기록에서 이 네 지표를 뽑는 거예요.

전후 비교 대상은 지금의 단일 호출 경로예요. 하네스를 얹기 전에 같은 요청 문구로 같은 네 지표를 먼저 모아 기준선으로 두고, 얹은 뒤 값과 짝지어 비교해요. 다만 “작업이 끝까지 갔는가”는 사실상 이진 결과라, 토큰 수를 빼면 정량 비교가 되는 지표가 거의 없어요. 그래서 이 측정으로는 산출물 품질이 좋아졌다는 주장까지는 못 하고, 끊긴 작업을 이어 붙일 수 있게 됐는지까지만 말할 수 있어요.

실패와 중복, 재시작 경계는 따로 확인해요. 승인 카드를 일부러 거절해 실행이 그 자리에서 멈추는지, 같은 요청을 두 번 보내 중복 실행이 생기는지, 중간에 프로세스를 강제로 내렸다가 같은 config로 재개했을 때 이미 승인된 도구 호출이 다시 승인을 묻지 않는지 세 가지를 각각 시나리오로 돌려 봐요.

재현 최소 조건은 deepagents와 langchain, @langchain/core 설치, checkpointer 하나, 그리고 interruptOn을 건 도구 하나예요. 확인하지 못한 값은 앞서 적은 그대로라, 패키지 버전과 Node.js 최소 버전, 모델 provider 자격증명의 환경변수 이름은 이 글을 쓰며 읽은 문서에서 찾지 못했어요.

### 자기 시스템에서 먼저 볼 세 가지

1. 가장 오래 걸리는 에이전트 작업 하나를 골라, 그 실행이 기록에 몇 개의 행으로 남는지 세 보세요. 한 행뿐이면 아직 쪼갤 자리가 없다는 뜻이에요.
2. 그 작업의 중간 산출물이 지금 어디에 있는지 찾아보세요. 대화 메시지 본문에만 있다면 파일이나 저장소로 내릴 첫 후보예요.
3. 쓰기·삭제·외부 알림을 하는 도구를 전부 적고, 그중 승인 없이 실행되는 것에 표시해 보세요. 그 표시가 곧 interrupt를 걸 자리예요.

결국 Deep Agents의 핵심은 실행을 끊고 다시 잇는 구조를 기본으로 깔아 두는 데 있어요. 더 똑똑한 에이전트를 만드는 일과는 다른 축이죠. 이 패턴을 들일지 말지는 모델을 고르는 문제가 아니라, 어떤 작업을 중간에 끊었다가 다시 이어 붙일 각오가 되어 있느냐의 문제예요.

## 참고 자료

아래 링크는 글을 올린 뒤 출처를 다시 짚으며 2026-09-08에 모두 직접 열어 문서 제목과 내용을 확인했어요. 본문 예제가 TypeScript라 JavaScript 문서를 기준으로 삼았고, deepagents의 개념 정의와 0.2 릴리스는 Python 쪽 문서와 블로그가 원본이라 둘을 함께 실었어요. 본문 주장을 직접 뒷받침하기보다 용어와 타입을 대조하는 데 쓴 자료에는 (보조)를 붙였어요.

- [Deep Agents overview (JavaScript)](https://docs.langchain.com/oss/javascript/deepagents/overview) — 기본 파일 도구와 context management, `npm install deepagents langchain @langchain/core` quickstart, 그리고 문서가 버전을 고정해 두지 않는다는 사실의 근거예요.
- [Subagents](https://docs.langchain.com/oss/javascript/deepagents/subagents) — subagent의 필수·선택 필드와 정의 예시, 같은 이름의 동기 subagent가 없으면 general-purpose subagent가 자동으로 추가된다는 문장의 근거예요.
- [Context engineering in Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/context-engineering) — composite backend가 경로별로 저장소를 가른다는 설명과 큰 도구 결과 오프로딩·summarization의 근거예요.
- [Human-in-the-loop](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop) — interruptOn과 checkpointer, approve/edit/reject/respond, respond를 side effect 도구 거절에 쓰지 말라는 경고, 같은 config로 재개하는 예시의 근거예요.
- [Models (JavaScript)](https://docs.langchain.com/oss/javascript/langchain/models) — JavaScript에서 모델 provider 접두사를 `google-genai:`처럼 하이픈으로 적는다는 근거예요.
- [Doubling down on Deep Agents (2025-10-28)](https://www.langchain.com/blog/doubling-down-on-deepagents) — 네 장치를 planning tool과 filesystem, subagents, detailed prompts로 꼽은 대목, 그리고 0.2가 deepagents 릴리스 번호이며 그 릴리스의 핵심이 Backend 추상화라는 주장의 근거예요.
- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) — orchestrator-worker 구조, 일반 chat 대비 약 4배·약 15배라는 토큰 배수, 멀티에이전트가 맞는 조건과 맞지 않는 조건의 근거예요.
- (보조) [Deep Agents overview (Python)](https://docs.langchain.com/oss/python/deepagents/overview) — deepagents가 LangChain 위에 서고 LangGraph를 실행 런타임으로 쓴다는 관계를 여기서 확인했어요.
- (보조) [Models (Python)](https://docs.langchain.com/oss/python/langchain/models) — 같은 자리를 `google_genai:`로 적는 Python 쪽 표기를 대조하는 데 썼어요.
- (보조) [deepagents — JavaScript API 레퍼런스](https://reference.langchain.com/javascript/deepagents) — 패키지가 내보내는 타입과 함수 이름을 대조하는 데 썼어요. 이 페이지에는 버전 번호가 표시되지 않아요.
