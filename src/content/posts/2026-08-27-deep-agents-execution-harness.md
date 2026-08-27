---
title: "Deep Agents는 프레임워크보다 실행 하네스다"
description: "Deep Agents의 planning, filesystem, subagents, human-in-the-loop를 장기 에이전트 작업의 실행 구조라는 관점에서 살펴본다."
pubDatetime: 2026-08-27T19:06:00+09:00
category: backend
---

## 한 번의 호출로 끝나지 않는 일이 늘어날 때

Slack에서 에이전트에게 “오늘 할 일 정리해 줘”라고 시키는 정도라면 구조는 단순해요. 입력을 받고 필요한 데이터를 몇 번 조회한 다음, 모델을 한 번 호출해 결과를 Slack에 돌려줘요. NestJS usecase 하나가 요청을 받아 ModelRouter를 호출하고 결과를 포맷팅하면 끝나요.

“지난 PR 몇 개를 보고 이번 주 업무 로그를 만들고, 누락된 테스트 리스크를 따로 정리하고, 블로그 후보까지 뽑아 줘” 같은 요청은 한 번의 LLM 호출로 다루기 어려워요. GitHub 결과가 길어지고 리뷰 메모가 쌓이는 데다 초안도 여러 번 바뀌니까요. 일부 단계가 실패하더라도 전체 작업을 재개할 수 있어야 해요.

이때 병목은 “어떤 모델을 붙일까”가 아니에요. 이미 라우터가 있고 에이전트 역할도 나뉘었다면, 이제 실행 구조를 고민해야 해요.

긴 작업을 어떻게 쪼갤지, 중간 산출물을 어디에 둘지 정해야 해요. 하위 작업을 어떤 컨텍스트에서 실행하고, 위험한 도구 호출을 어디서 멈출지도 결정해야 하죠. Deep Agents 패턴은 바로 이 지점에서 의미가 생겨요.

## Deep Agents는 더 똑똑한 루프가 아니라 실행 하네스다

LangChain 문서는 Deep Agents를 “agent harness”로 설명해요. 기존 tool-calling loop를 버리는 구조는 아니에요. LLM이 메시지를 보고 도구를 호출한 뒤, 결과를 읽고 다음 행동을 정하는 기본 루프는 그대로 두면서 장기 작업에 필요한 장치를 기본으로 붙여요.

LangChain이 반복해서 언급하는 구성요소는 planning, filesystem, subagents, detailed prompts예요. JavaScript reference도 deepagents를 “batteries-included agent harness”라고 부르며, 기본 기능으로 write_todos, 파일 도구, task subagent, smart defaults, context management를 나열해요.

공식 JavaScript reference의 quickstart를 보면 별도 도구나 프롬프트를 거의 붙이지 않고도 createDeepAgent를 만들 수 있어요.

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

여기서 눈여겨볼 부분은 “summary.md에 쓰라”는 지시예요. 일반적인 채팅 에이전트는 긴 조사 결과를 대화창에 계속 밀어 넣지만, Deep Agents의 접근법은 중간 산출물을 파일로 내려요.

대화 컨텍스트는 모든 원문을 담는 곳이 아니에요. 지금 판단하는 데 필요한 압축 정보만 들고 있는 조정면에 가깝죠.

## 계획, 파일, 서브에이전트가 맞물리는 방식

첫 번째 장치는 planning이에요. JavaScript reference의 “What’s Included”에는 planning 도구로 write_todos가 명시돼 있어요.

사람이 보기 좋은 체크리스트라기보다 장기 작업의 현재 상태를 모델이 계속 갱신하도록 돕는 작업 상태예요. 긴 작업에서는 무엇을 끝냈고 무엇이 남았으며 다음 행동이 무엇인지 쉽게 흐려지거든요. todo 상태는 이런 흐림을 줄여줘요.

두 번째 장치는 virtual filesystem이에요. 문서에 따르면 Deep Agents에는 ls, read_file, write_file, edit_file, glob, grep 같은 파일 도구가 들어 있어요. read_file은 offset/limit로 큰 파일의 일부만 읽고, glob은 **/*.py 같은 패턴을 찾아요. sandbox backend가 있으면 execute도 사용할 수 있어요.

LangChain 블로그는 0.2에서 filesystem backend가 더 중요해졌다고 설명해요. 이전에는 LangGraph state 위의 virtual filesystem이었지만, 0.2부터는 Backend 추상화로 LangGraph State, LangGraph Store, 실제 로컬 파일시스템, composite backend를 붙일 수 있어요.

filesystem은 단순한 첨부 저장소가 아니에요. 조사 원문과 diff 분석 로그, 초안, 검증 결과, 실패한 도구 호출의 흔적을 파일로 내리면 메인 대화 컨텍스트가 덜 오염돼요.

LangChain 블로그에서 언급한 large tool result eviction도 같은 방향이에요. 큰 도구 결과가 토큰 임계값을 넘으면 파일시스템으로 덤프하고, 오래된 대화 이력은 summarization으로 압축하죠.

세 번째 장치는 subagent예요. Deep Agents의 subagents 문서는 subagent가 “context quarantine”에 유용하다고 설명해요.

하위 에이전트는 메인 에이전트의 컨텍스트를 더럽히지 않고 독립된 컨텍스트 창에서 작업한 뒤 결과만 돌려줘요. 전문 역할을 붙일 수도 있지만, 더 본질적인 가치는 격리와 압축이에요.

subagent 설정에는 별도 필드가 있어요. 문서에서는 name, description, systemPrompt를 필수로 정해요. 필요하면 tools, model, middleware, interruptOn, skills, responseFormat, permissions도 줄 수 있어요.

```typescript
const agent = createDeepAgent({
  model: "openai:gpt-5.5",
  subagents,
});
```

기본 general-purpose subagent도 자동으로 추가돼요. 이 subagent는 파일 도구를 기본으로 갖고, 같은 모델과 도구를 쓰되 독립된 컨텍스트에서 실행돼요.

동기 subagent는 메인 에이전트가 결과를 받을 때까지 기다려요. 더 긴 작업이나 병렬 작업, 중간 조정, 취소가 필요하면 async subagents를 보라고 문서에서 안내하죠.

## 사람이 끼어야 하는 지점도 하네스의 일부다

장기 작업에서 위험한 순간은 모델이 “그럴듯한 다음 행동”을 너무 자연스럽게 고를 때예요. 파일 삭제나 알림 발송, 외부 시스템 변경 같은 도구 호출에는 자동 실행보다 승인 지점이 필요해요.

Deep Agents의 human-in-the-loop 문서는 interruptOn으로 특정 도구를 호출하기 전에 멈추는 방식을 설명해요. 이때는 checkpointer가 필요해요. 멈춘 실행 상태를 저장해 두었다가 사람이 승인·수정·거절한 뒤 같은 config로 재개해야 하거든요.

공식 예시에서는 remove_file, fetch_file, notify_email 도구마다 다른 interrupt 정책을 둬요. remove_file은 기본 승인 흐름을 켜고, fetch_file은 끄며, notify_email은 approve/reject만 허용해요.

```typescript
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";

const checkpointer = new MemorySaver();

const agent = createDeepAgent({
  model: "google_genai:gemini-3.6-flash",
  tools: [removeFile, fetchFile, notifyEmail],
  interruptOn: {
    remove_file: true,
    fetch_file: false,
    notify_email: { allowedDecisions: ["approve", "reject"] },
  },
  checkpointer,
});
```

결정 타입도 중요해요. 문서는 approve, edit, reject, respond를 구분해요. 특히 respond는 사람이 도구 역할을 대신해 답할 때 쓰며, side effect가 있는 도구를 거절할 때는 쓰지 말라고 경고해요. 모델이 그 응답을 성공한 도구 결과로 해석할 수 있기 때문이죠.

## 멀티에이전트는 공짜 성능 향상이 아니다

Deep Agents 패턴을 보면 모든 작업을 subagent로 나누고 싶어져요. 하지만 Anthropic의 multi-agent research system 글은 비용 문제를 분명히 짚어요. 이 연구 시스템은 lead agent가 전략을 세우고 여러 subagent가 병렬로 조사한 뒤 압축된 결과를 돌려주는 orchestrator-worker 구조예요.

내부 평가에서는 multi-agent research가 single-agent보다 좋은 결과를 냈다고 보고했어요. 동시에 토큰 사용량도 크게 늘었다고 밝혔어요. 일반 chat보다 agent는 약 4배, multi-agent system은 약 15배 토큰을 쓸 수 있거든요.

subagent는 기본값이 아니라 정책으로 다뤄야 해요. Anthropic은 넓은 정보 공간, 한 컨텍스트 창을 넘는 자료, 병렬 탐색, 복잡한 도구, 고가치 의사결정에 적합하다고 봐요.

모든 하위 작업이 같은 공유 컨텍스트를 봐야 하거나 의존성이 촘촘하고 병렬화하기 어렵다면 맞지 않아요. coding task는 research보다 병렬화할 수 있는 작업이 적을 때가 많다고도 언급해요.

이 한계는 실무 설계에 바로 이어져요. “역할이 많으니 멀티에이전트”가 아니라, 중간 결과가 너무 크고 독립적으로 탐색할 수 있으며 실패해도 회수 가능한지부터 봐야 해요. 단순 포맷팅이나 짧은 파라미터 추출, 작은 diff 리뷰에는 굳이 Deep Agents식 하네스를 태우지 않는 편이 나아요.

## 현재 시스템에 대입하기

현재 구조와 바로 맞닿는 중심은 agent-run이에요. 이미 에이전트 실행의 라이프사이클을 기록하는 축이라면, 새 프레임워크를 통째로 들이기보다 AgentRun 아래에 실행 상태를 확장하는 편이 자연스러워요.

todo 상태와 artifact 경로, child run 관계, human approval interrupt 지점을 AgentRun에 연결할 수 있어요. Anthropic식 lead/subagent 관계도 이미 존재하는 parentId 같은 실행 관계와 잘 맞죠.

agent/pm은 planning과 궁합이 좋아요. daily plan은 결과물처럼 보이지만, 실제로는 여러 입력을 우선순위에 따라 재배열하는 작업이에요. write_todos에 해당하는 내부 상태가 있으면 “오늘 계획 생성”을 “계획 초안 → 근거 보강 → 누락 확인 → 최종안”으로 바꿀 수 있어요.

agent/cto는 subagent orchestration과 맞닿아 있어요. PM 작업을 BE worker로 분배한다면 모든 하위 작업의 원문을 한 컨텍스트에 넣기보다, worker 실행을 child run으로 격리하고 압축된 결과만 회수하는 편이 나아요.

agent/be, agent/be-test, agent/be-schema, agent/code-reviewer는 독립 subagent 후보가 될 수 있지만, 늘 병렬화해야 한다는 뜻은 아니에요. schema 변경 제안과 Jest spec 생성은 같은 diff를 보더라도 산출물이 달라 분리할 가치가 있어요. 반대로 작은 수정 하나에 모든 worker를 켜면 토큰만 낭비해요.

agent/blog, agent/work-reviewer, autopilot, ops-supervisor는 filesystem 기반 artifact store의 효과를 크게 볼 수 있어요. 초안과 회고 메모, 후보 목록, 검증 로그처럼 중간 산출물이 많은 작업이기 때문이에요.

Slack 응답에는 최종 요약과 링크만 남기고, 긴 조사 메모와 초안 이력은 파일이나 저장소에 내려두는 편이 더 안정적이에요.

sandbox와 agent/be-sandbox는 execute와 human approval의 경계에 닿아 있어요. 테스트 실행과 코드 생성, 파일 수정 제안은 자동화할 가치가 크지만 side effect도 있거든요. preview 단계와 apply 단계를 나누고, 쓰기·삭제·외부 알림 도구는 interrupt 지점으로 취급하는 편이 안전해요.

## 적용할 때 남는 기준

AgentRun에 바로 붙일 최소 필드는 todo 상태, artifact 경로, child run 관계, human approval interrupt 지점 네 가지면 충분해요. 처음부터 범용 LangGraph clone을 만들 필요는 없어요. 현재 실행 기록 위에 장기 작업의 “작업판”을 얹는 정도로 시작하면 돼요.

subagent를 켜는 정책도 필요해요. Anthropic의 글을 기준으로 breadth-first 탐색, 대량 자료, 독립 검증, 고가치 산출물에는 켜고, 짧은 단일 작업이나 강한 공유 컨텍스트가 필요한 작업에는 꺼요. 이 정책이 없으면 Deep Agents 패턴은 안정성 장치가 아니라 토큰을 태우는 장치가 되죠.

결국 Deep Agents의 핵심은 더 똑똑한 에이전트를 만드는 데 있지 않아요. 긴 작업을 계획하고 중간 산출물을 컨텍스트 밖에 보관하며, 하위 작업을 격리하고 위험한 행동 앞에서 멈추게 하는 실행 하네스에 있어요.

출처:

- https://docs.langchain.com/oss/python/deepagents/overview
- https://reference.langchain.com/javascript/deepagents
- https://docs.langchain.com/oss/javascript/deepagents/overview
- https://docs.langchain.com/oss/javascript/deepagents/subagents
- https://docs.langchain.com/oss/javascript/deepagents/context-engineering
- https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop
- https://www.langchain.com/blog/doubling-down-on-deepagents
- https://www.anthropic.com/engineering/multi-agent-research-system
