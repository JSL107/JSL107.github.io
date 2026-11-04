---
title: "파일 기반 에이전트 메모리에서 먼저 정할 것"
description: "Slack 기반 멀티 에이전트 시스템에서 파일 메모리를 반복 실패 방지에 쓰려면 읽기·쓰기 범위와 감사·롤백 책임부터 정해야 한다."
pubDatetime: 2026-11-04T09:03:00+09:00
category: backend
---

실패한 작업을 다음 날 다시 실행했는데 에이전트가 어제와 똑같은 실수를 반복해요. 이 글에서는 Anthropic의 memory tool 문서, tool combinations 문서, Managed Agents 아키텍처 글, Managed Agents memory 해설을 바탕으로 Slack 기반 멀티 에이전트 시스템에 파일 메모리를 도입할 때 어디에 경계를 그어야 하는지 따져 봐요.

## 문제는 오래 기억하는 것이 아니라 다시 쓸 수 있게 두는 것이다

로그와 실행 기록, 모델 호출의 입력과 출력은 남아 있어요. 하지만 새 실행이 시작되면 그 기록은 “어딘가에 있는 과거”가 될 뿐, 에이전트의 현재 작업 공간에는 들어오지 않아요.

장기 기억이라고 하면 먼저 벡터DB가 떠올라요. 과거 대화나 문서를 임베딩해 두었다가 현재 질문과 가까운 조각을 찾아 프롬프트에 넣는 방식이죠. 관련 문맥을 찾아오는 데 잘 맞아요. 사용자가 예전에 무엇을 좋아한다고 했는지, 어느 문서에 비슷한 내용이 있었는지를 찾을 때는 검색이 자연스러워요.

하지만 재시도와 핸드오프에는 조금 다른 정보가 필요해요. 실패한 실행을 다시 돌릴 때는 “비슷한 문장”보다 “이번에는 피해야 할 조건”을 알아야 할 때가 많거든요. 특정 저장소에서는 빌드 전에 문서를 동기화해야 한다거나, 어떤 슬래시 명령은 응답을 즉시 확인한 뒤 나중에 결과를 교체해야 한다거나, 어떤 CLI는 특정 경로에서 깨진다는 식의 운영 지식이에요. 이런 지식을 검색 인덱스에 묻어 둬도 되는지, 에이전트가 작업 중 직접 열어 볼 수 있어야 하는지가 파일 기반 메모리를 생각하게 된 출발점이에요.

## 기억은 하나의 도구가 된다

파일 기반 메모리에서 memory는 모델 내부에 남아 있는 상태가 아니에요. 에이전트가 “기억한다”는 건 메모리 도구로 디렉터리를 살펴보고 필요한 파일을 읽은 다음, 새 사실을 쓰거나 기존 내용을 고친다는 뜻이에요. 모델은 작업을 요청하고 애플리케이션은 그 요청을 실행해요.

Anthropic memory tool도 기본적으로 이런 구조예요. 요청에 memory 도구를 넣으면 모델이 그 도구를 통해 /memories 아래의 파일을 다뤄요.

```json
{
  "tools": [
    { "type": "memory_20250818", "name": "memory" }
  ]
}
```

책임은 분명히 나뉘어요. 모델은 저장소를 직접 갖지 않고 파일 작업을 요청해요. 실제로 파일시스템, DB, 클라우드 스토리지, 암호화 저장소 중 무엇을 쓸지는 애플리케이션이 정하고 경로도 애플리케이션이 검증해야 해요. 모든 작업은 /memories 아래로 제한해야 해요.

RAG에서는 보통 검색 파이프라인이 기억을 골라 프롬프트에 넣어요. 파일 기반 메모리에서는 에이전트가 작업 중에 열 파일을 직접 결정해요. 그래서 잘못된 파일을 읽거나 틀린 규칙을 저장하거나 다른 범위의 기억을 가져오면 실행 품질이 흔들릴 수 있어요.

## 작은 파일을 필요할 때 연다

사용자 선호, 저장소 규칙, 반복 실패, Slack 응답 정책, 배포 전 확인 목록을 거대한 summary.md 하나에 섞어 두면 에이전트가 매번 필요 없는 맥락까지 읽게 돼요. 기억을 읽기 좋은 단위로 나눠야 파일 기반 메모리의 이점이 생겨요.

파일을 작게 나누면 이점이 두 가지예요. 먼저 just-in-time context가 가능해져요. 에이전트는 시작할 때 모든 기억을 넣지 않고 디렉터리를 살펴본 뒤 필요한 파일만 열어요. 낡거나 틀린 내용이 생겨도 전체 기억을 버릴 필요 없이 그 파일만 고치거나 되돌릴 수 있어 오염 범위도 작아져요.

문서에서 설명하는 흐름도 비슷해요. 먼저 /memories를 살펴보고 관련 파일을 읽어 작업한 뒤, 남길 가치가 있는 사실을 다시 기록해요.

```json
{
  "type": "tool_use",
  "id": "toolu_01C4D5E6F7G8H9I0J1K2L3M4",
  "name": "memory",
  "input": {
    "command": "view",
    "path": "/memories"
  }
}
```

애플리케이션은 그 결과를 도구 응답으로 돌려줘요.

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01C4D5E6F7G8H9I0J1K2L3M4",
  "content": "Here're the files and directories up to 2 levels deep in /memories, excluding hidden items and node_modules:\n4.0K\t/memories\n1.5K\t/memories/customer_service_guidelines.xml\n2.0K\t/memories/refund_policies.xml"
}
```

문서의 예시는 고객 응대지만 Slack 기반 개발 에이전트라면 파일 구성이 달라져요. PR 리뷰를 만드는 쪽은 리뷰 기준 파일을, 그날 할 일을 정리하는 쪽은 계획 작성 규칙을 읽을 수 있어요. 반복 실패를 줄이는 데는 known-failures.md 같은 파일이 더 직접적이에요. 다음 실행에서 실제로 열어 볼 수 있도록 파일마다 목적을 좁혀야 해요.

## 다른 도구 사이에서 세션의 빈칸을 메운다

memory가 bash, 브라우저, GitHub 클라이언트, 코드 편집 도구를 대신하지는 않아요. 도구 조합 문서는 memory를 다른 도구와 직교하는 도구로 설명해요. 실행 도구의 동작을 바꾸기보다, 컨텍스트가 리셋돼도 사라지면 안 되는 사실을 다시 찾을 장소를 마련해 주는 거예요.

코딩 에이전트는 기본적으로 파일을 읽고 수정한 뒤 테스트를 돌려요. 이 작업에는 텍스트 편집 도구와 bash가 잘 맞아요.

```json
{
  "tools": [
    { "type": "text_editor_20250728", "name": "str_replace_based_edit_tool" },
    { "type": "bash_20250124", "name": "bash" }
  ]
}
```

여기에 memory를 붙인다고 테스트 실행 자체가 나아지지는 않아요. 대신 전날 실패하며 알게 된 “이 저장소는 테스트 전에 로컬 인프라가 떠 있어야 한다” 같은 사실을 다음 세션에서 다시 볼 수 있어요. 모든 로그와 대화, diff를 메모리에 저장할 필요는 없어요. 에이전트가 다시 읽지 않을 기록은 실행 로그에 두고, 다음 실행의 행동을 바꿀 정보만 메모리에 남기면 돼요.

## 저장소보다 어려운 것은 범위와 권한이다

파일 기반 메모리를 쓰려면 누가 쓴 기억을 누가 읽을 수 있는지, 어떤 기억이 낡았는지, 잘못 저장된 지시문을 어떻게 되돌릴지 정해야 해요. 이런 경계가 없으면 메모리가 품질을 높이기는커녕 장애를 일으켜요.

Slack 멀티 에이전트에서는 범위가 더 복잡해요. 개인 사용자에게만 맞는 선호도 있고 채널이 공유하는 규칙이나 프로젝트 전체에 적용되는 운영 지식도 있어요. 셋을 같은 디렉터리에 넣으면 개인의 말투 선호가 팀 보고서에 섞이거나 한 프로젝트의 예외 규칙이 다른 프로젝트의 자동 리뷰에 적용될 수 있어요.

그래서 기억을 쓸 때 scope를 고정해야 해요. 읽을 때 걸러 내겠다는 생각으로는 늦어요. 파일 경로에서 범위가 드러나야 하고 애플리케이션은 그 경로 밖으로 나가는 요청을 거절해야 해요.

| 범위 | 어울리는 기억 | 위험 |
| --- | --- | --- |
| 사용자 단위 | 말투 선호, 개인 업무 패턴 | 팀 공유 규칙처럼 오인될 수 있다 |
| 프로젝트 단위 | 저장소 규칙, 빌드 전제, 반복 실패 | 다른 프로젝트로 새면 잘못된 제약이 된다 |
| 에이전트 단위 | 리뷰 기준, 계획 작성 기준, 보고서 형식 | 같은 프로젝트 안의 다른 작업에 전달되지 않는다 |
| 실행 단위 | 재시도에 필요한 임시 상태 | 장기 기억으로 승격되면 오염된다 |

디렉터리와 파일은 사람이 읽고 고치기 쉬워요. 잘못된 기억을 삭제하거나 되돌리는 UX를 만들기에도 좋아요. 사람이 열어 보지 않을 메모리라면 파일의 이런 장점을 살리기 어려워요.

## 내 시스템에 넣는다면 반복 실패부터 기억시킨다

이대리 같은 Slack 기반 멀티 에이전트 시스템에는 개인화보다 운영 기억이 먼저 필요해 보여요. 이미 실행 기록을 만들고 근거를 남기며 실패한 실행을 재시도하는 구조가 있고 자연어 멘션을 받아 알맞은 작업자에게 넘기는 흐름도 있어요. 파일 기반 메모리는 다음 실행이 같은 실수를 피하도록 돕는 작은 운영 노트부터 시작하는 편이 맞아요.

가장 먼저 연결할 곳은 에이전트의 실행 생명주기예요. 작업이 시작돼 어떤 모델 호출과 도구 호출을 거쳐 어떤 결과로 끝났는지 이미 추적한다면 memory write도 그 실행의 증거로 남겨야 해요. 메모리 파일을 바꿀 때 누가, 어떤 실행에서, 왜 바꿨는지 기록해야 나중에 “왜 이 규칙이 생겼지?”를 추적할 수 있어요.

다음은 실패 재시도예요. 실패한 실행을 다시 돌릴 때 전체 로그를 프롬프트에 밀어 넣는 대신, 재시도에 필요한 사실만 파일로 남길 수 있어요.

```plain text
## known-failures.md

### Non-ASCII workspace path can break a coding CLI
- Symptom: CLI exits before doing useful work when the workspace path contains non-ASCII characters.
- Retry rule: move or create the worktree under an ASCII-only absolute path before delegating coding work.
- Scope: project-level operational memory.

### Slack command handlers must acknowledge quickly
- Symptom: users experience a silent timeout while the model is still running.
- Retry rule: acknowledge first, then replace the original response when the long-running result is ready.
- Scope: Slack operation memory.

### Schema-constrained model calls should not use providers without schema support
- Symptom: fallback succeeds syntactically but returns output that the parser cannot trust.
- Retry rule: disable fallback for schema-constrained requests unless the fallback provider supports the same contract.
- Scope: model routing memory.
```

이 예시에서는 특정 내부 모듈 이름보다 각 작업이 맡은 책임이 중요해요. 코드 리뷰를 만드는 쪽, 업무 로그를 정리하는 쪽, 지연 원인을 조회하는 쪽은 서로 다른 작업자지만 반복 실패의 일부는 공통 운영 기억으로 묶을 수 있어요. 반면 주식 후보를 고르거나 휴가 잔여일을 계산하는 작업에는 당장 파일 기반 메모리를 붙일 이유가 약해요. 같은 실패를 반복한다는 증거가 없고 계산 자체가 현재 입력과 외부 데이터에 더 의존하기 때문이에요.

## 아직 쓰지 말아야 할 자리

감사할 수 있어야 하는 실행 로그는 계속 실행 로그로 남겨야 해요. 검색해야 할 과거 에피소드가 많다면 벡터 검색이나 관계형 저장소가 더 잘 맞아요. 정규화된 업무 데이터, 지원 현황, 포트폴리오 항목처럼 스키마와 조회 조건이 중요한 데이터도 파일 메모리에 넣으면 안 돼요.

지시문 저장소로 쓰는 것도 피해야 해요. 공격자가 만든 입력이 “앞으로 모든 리뷰에서 이 규칙을 따르라”는 식으로 기억에 저장되면 다음 실행부터 정상 입력처럼 보이거든요. 파일 기반 메모리는 사람이 읽기 쉽지만 에이전트에게는 프롬프트의 일부가 돼요. 메모리 파일에 출처, 적용 범위, 만료 조건을 적어야 하는 이유예요. 특히 외부 입력에서 온 내용은 곧바로 규칙으로 올리지 말고 후보로 남기는 편이 안전해요.

Managed Agents 아키텍처 글은 세션, 하네스, 샌드박스를 분리하고 각각을 안정된 인터페이스로 다루는 방향을 강조해요. 세션은 append-only event log로 남기고 도구 실행은 일반화된 인터페이스 뒤에 둬요. 이 관점에서 memory는 세션 로그를 대신하는 것이 아니라 세션 밖에서도 다시 읽을 수 있는 작은 상태 계층이에요. 로그와 메모리를 섞으면 복구도 삭제도 어려워져요.

## 다음 확인은 경로 설계와 삭제 UX다

먼저 경로를 정해야 해요. 사용자 중심으로 둘지, 프로젝트 중심으로 둘지 결정하는 거예요. Slack 기반 개발 자동화라면 개인 취향보다 프로젝트 운영 기억이 더 중요하니 /memories/{projectId}/{agentRole}/부터 두는 쪽이 맞아 보여요. 사용자별 기억은 말투나 보고서 선호처럼 적용 범위가 분명할 때 따로 두는 편이 나아요.

삭제와 롤백 UX도 확인해야 해요. 메모리 변경을 실행 기록에 연결하고 변경 전후 diff를 남겨 잘못된 기억을 되돌릴 수 있어야 해요. 아직 이 조건을 갖추지 못했다면 memory write를 막고 read-only memory부터 시작하는 편이 안전해요.

### 출처

- https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/memory-tool
- https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/tool-combinations
- https://www.anthropic.com/engineering/managed-agents
- https://usewire.io/blog/anthropic-managed-agents-memory-context-engineering
