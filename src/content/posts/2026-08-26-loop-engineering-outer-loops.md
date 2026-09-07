---
title: "일찍 멈추는 에이전트를 다시 움직이게 하는 루프·하네스·그래프"
description: "코딩 에이전트는 이미 루프로 움직이지만 컨텍스트가 차오르면 스스로 일찍 멈춰요. 여기에 하네스와 그래프를 붙이면 반복만이 아니라 도구·권한·상태와 작업 흐름까지 설계할 수 있어요."
pubDatetime: 2026-08-26T09:38:00+09:00
category: backend
---
테스트 세 개 중 하나가 여전히 빨간데도 "다 고쳤습니다"라는 보고를 받아본 적 있나요? 에이전트는 목표를 받아 도구를 호출하고 결과에 따라 다음 행동을 정하는 소프트웨어예요. 스스로 작업을 끝내고 제어를 돌려주면 다음 확인은 제가 시작해야 하죠.

이 글에서 [loop engineering](https://addyosmani.com/blog/loop-engineering)은 에이전트의 반복 실행·검증·종료를 바깥에서 설계하는 방식이라는 뜻이에요. 핵심은 특정 프로젝트의 성과가 아니라, 일찍 끝난 작업을 어떤 신호로 다시 실행하고 어디서 멈출지 정하는 일이에요.

코딩 에이전트를 오래 돌리고 싶은 개발자라면 안쪽 실행과 바깥 검증을 구분하고, 자신의 문제에 맞는 장치를 고를 수 있어요. 아래 개념은 공개 문서와 외부 사례를 바탕으로 정리했고, 마지막 절의 로컬 계약 예제와 개인 설정만 직접 실행·확인했어요.

## 에이전트는 이미 루프로 돌고 있다

코딩 에이전트는 모델이 현재 상태를 읽고 판단한 뒤 도구를 호출하고, 그 결과를 다음 판단의 재료로 삼는 순서로 움직여요. 도구 호출 없이 응답하면 한 회차를 끝내요.

이 글에서는 이 회차를 루프라고 부를게요. 실행 환경과 기본 도구·권한·상태를 제공하는 틀은 하네스, 여러 단계의 분기와 재진입 경로를 표현한 구조는 그래프라고 하겠습니다.

Claude Code는 이 한 바퀴를 턴(turn)이라고 불러요. [작성자 관찰] 제가 본 "auth.ts의 실패하는 테스트를 고쳐줘" 같은 단순한 요청은 서너 턴 안에 끝나고, 테스트를 돌리고 파일을 읽어 고친 뒤 마지막에는 "고쳤습니다"라는 텍스트만 남겨요. 서너 턴 안에 끝난다는 관찰만으로 모든 작업의 턴 수를 일반화할 수는 없어요.

하네스가 기본 루프를 제공하므로 저는 매번 이 안쪽 실행기를 만들 필요가 없어요. 따라서 바깥에서는 실행기가 끝났는지가 아니라 요구한 테스트와 산출물이 실제로 충족됐는지를 확인해야 해요.

## 왜 일찍 멈추나

안쪽 루프의 종료 조건을 들여다보면 문제가 있어요. 모델이 스스로 "다 했다"고 판단하니 일한 사람이 자기 일을 직접 채점하는 구조인 셈인데, [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)도 장기 실행 앱용 하네스를 설계하며 같은 점을 관찰했어요.

> [의역] 에이전트는 확신에 차서 자기 작업을 칭찬하는 경향이 있다. 사람이 보면 품질이 명백히 그저 그런 경우에도 그렇다.

[출처 요약] 같은 글에서는 이를 "컨텍스트 불안(context anxiety)"이라고 부르는데, 컨텍스트(context, 모델이 한 번에 참고하는 대화와 작업 정보) 창이 차오를수록 모델이 작업을 일찍 끝내려 한다는 뜻이에요. 오래된 대화를 요약해 자리를 만들어도 이 증상은 가라앉지 않았어요.

Anthropic 팀은 요약 대신 컨텍스트를 통째로 비우고 새 에이전트로 초기화했어요. 이 선택은 검증을 맡는 평가자와 실행기를 분리하고, 컨텍스트가 낡았을 때 기존 대화가 아니라 저장된 작업 상태를 기준으로 다음 실행을 시작하게 하는 근거가 돼요.

## 안쪽 루프와 바깥 검증 루프

안쪽 루프 자체를 고칠 수는 없어도 외부 검증을 연결할 수는 있어요. 에이전트가 "다 했습니다"라고 말하는 순간 외부 조건을 확인하고, 아직 끝나지 않았다면 새 회차로 이어주는 구조가 바깥 루프예요. 이 전환은 [Peter Steinberger](https://addyosmani.com/blog/loop-engineering/)의 한 문장에도 그대로 담겨 있어요.

> [의역] 이제 코딩 에이전트에게 프롬프트를 치지 마세요. 에이전트에게 프롬프트를 치는 **루프를 설계하세요**.

Claude Code를 이끄는 [Boris Cherny](https://addyosmani.com/blog/loop-engineering/)도 자기 일을 비슷하게 설명했어요. Claude에게 직접 프롬프트를 치는 대신, 프롬프트를 치는 루프를 돌린다는 뜻이죠.

이 개념은 2026년 6월 여러 글에서 정리되기 시작했어요. Addy Osmani와 Kilo도 각각 [에세이](https://addyosmani.com/blog/loop-engineering/)와 [프레임](https://kilo.ai/articles/what-is-loop-engineering)으로 설명했어요. [작성자 해석] 두 글에서 제가 가져온 핵심은 이름의 기원보다 반복을 설계하는 관점이에요.

### 프롬프트와 루프의 역할이 달라지는 지점

프롬프트를 잘 쓰는 일은 여전히 중요해요. 첫 지시가 정확해야 헛도는 탐색이 줄고 초기 계획도 나아지거든요. 프롬프트 작성자는 한 번의 지시와 첫 응답 품질을 살피고, 루프 설계자는 그 지시가 반복해서 실행되는 작업 흐름을 다뤄요.

외부 검증 루프는 최종 결과가 조건을 만족하는지 확인해요. 프롬프트 작성자는 사람의 피드백으로 첫 응답을 다듬지만, 검증 루프는 테스트·로그·스크린샷·지표를 근거로 결과를 판정해요. 저는 실패 원인을 "질문이 모호했나"에만 두지 않고 "일찍 멈췄나, 잘못 검증했나, 상태를 잃었나"까지 살펴보므로 두 작업은 경쟁 관계가 아니라 서로 다른 층에서 함께 필요해요.

## 어떤 조건으로 루프가 다시 시작되나

도구를 병렬로 나열하기보다, **무엇이 다음 실행을 일으키는가**로 고르면 이해가 쉬워요. 트리거는 다음 실행을 시작하는 신호이고, 중단 조건과 사용 목적을 함께 정해야 해요.

`/goal`은 완료 조건을 적어 두고 현재 세션에서 판정하는 기능이에요. `/goal`은 대화에 남은 증거를 바탕으로 조건을 판정하므로, 작업자가 실제 테스트 명령과 종료 코드를 기록해야 해요. [공식 문서](https://code.claude.com/docs/en/goal)

`Stop hook`은 작업이 멈추는 시점에 자동으로 실행하는 검사·스크립트이고, 설정 파일에 남아 모든 세션에 적용돼요.

완료 조건이 아니라 **시간**이 신호라면 열린 세션의 `/loop`를 써요. 반대로 파일 상태를 읽고 새 세션으로 이어가야 하면 셸 루프(Ralph)가 맞아요. Ralph는 파일과 Git 기록을 다음 회차의 입력으로 삼는 셸 방식으로, [공개 사례](https://ghuntley.com/ralph/)의 형태를 이 글에서 그렇게 부를게요.

세션 밖에서 정해진 시각에 시작해야 하면 스케줄을 선택해요. cron은 `분 시 일 월 요일`처럼 실행 시각을 표현하는 일정 문법이에요. [공식 도움말](https://code.claude.com/docs/en/scheduled-tasks)

로컬 스케줄은 파일에 접근할 수 있지만 기계가 켜져 있어야 해요. 클라우드 루틴은 기계가 꺼져도 시작할 수 있지만 로컬 파일에는 접근하지 못해요. 실행 위치와 파일 접근 중 무엇이 필요한지에 따라 선택하면 돼요.

CI(코드 변경을 자동으로 빌드하고 테스트하는 지속적 통합)나 에러 트래커의 **사건**이 생겼을 때만 반응해야 하면 Channels를 써요. Channels는 외부 이벤트를 열린 세션으로 전달하는 기능이며, 현재 문서의 research preview(시험 공개 단계) 조건과 발신자 허용목록을 따라야 해요. [공식 문서](https://code.claude.com/docs/en/channels)

### `/goal`: 완료 조건을 평가하는 루프

조건을 문장으로 적어두면 매 턴이 끝날 때마다 evaluator(완료 여부를 판정하는 모델)가 판단하고, 결과는 ‘아직 아님’, ‘됐다’, ‘불가능’으로 나뉘어요. Claude API(프로그램으로 Claude를 호출하는 인터페이스)에서 기본 판정 모델로 Haiku(빠른 확인에 쓰는 가벼운 모델)를 둔다는 설명은 provider(모델을 제공하는 서비스)·버전·설정에 따라 달라질 수 있으니 실행 전 공식 문서를 다시 확인해야 해요.

```text
/goal all tests in test/auth pass and the lint step is clean
```

`/goal`은 세션 범위에서 Stop hook을 감싼 기능이라 evaluator와 Stop hook이 같은 종료 지점에서 작동하지만 적용되는 수명은 달라요. evaluator가 도구를 직접 부르지 못하고 대화에 남은 출력만 보므로, 에이전트는 실제 명령과 결과를 먼저 기록해야 해요. 조건문에는 측정 가능한 종료 상태와 증명 방법을 적어야 하며, "`npm test`가 0으로 끝난다"처럼 명령과 종료 코드를 지정하고 "다른 테스트 파일은 수정하지 않는다"처럼 보호할 경계도 밝혀야 해요. 제자리걸음이 계속될 때만 "또는 20턴 뒤 중단" 같은 선택적 반복 상한을 더해 사람에게 제어권을 돌려줘요.

### 같은 자리에 있는 Codex의 Goal

제품을 비교하려는 글은 아니에요. Codex의 goal은 결과뿐 아니라 검증 방법, 건드릴 경계, 막혔을 때의 중단 기준까지 묶는 스레드 범위의 완료 계약에 가까워요. [Codex 문서](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)

> [의역] 목표는 지속시키되, 판정은 증거가 하게 하라.

좋은 goal은 결과·검증 방법·제약·파일과 도구의 경계·반복 정책·중단 기준을 함께 적어요. 예산이 끝나면 완료로 처리하지 말고 진행 상황과 막힌 지점을 남겨야 하며, 한 줄 수정이나 마감선이 모호한 작업을 억지로 오래 돌리는 용도로 쓰면 안 돼요.

### `/loop`: 시간 기반 반복

시간이 되면 조건을 판정하지 않고 프롬프트를 다시 실행해요. `/loop`는 세션 안의 예약 실행 기능이에요. [공식 도움말](https://code.claude.com/docs/en/scheduled-tasks)

여기서 PR(코드 변경 검토 요청)을 확인하는 작업을 예로 들면 다음과 같아요.

```text
/loop 5m check my PR, address review comments, and fix failing CI
```

간격을 생략하면 에이전트가 관찰한 상황에 따라 1분에서 1시간 사이의 다음 간격을 정해요. `/loop`는 열린 세션 안에서만 살아서 터미널을 닫으면 멈추고, 놓친 실행을 나중에 몰아서 보충하지도 않아요.

`/loop` 스케줄은 [공식 도움말](https://code.claude.com/docs/en/scheduled-tasks)에 따르면 7일이 지나면 마지막으로 한 번 실행한 뒤 스스로 삭제돼요. 여러 세션이 몰리지 않도록 예정 시각에는 작업 ID에서 정한 오프셋도 더해져요. 7일 후 마지막 실행과 자동 삭제는 버전에 따라 달라질 수 있으니 실제 운영 전 문서를 다시 확인해야 해요.

그래서 `/loop`는 정교한 운영 스케줄러보다 열린 세션용 시간 예약에 가까워요. 기본 지시는 `.claude/loop.md`에 고정할 수 있고, 실행 중 바꾼 내용은 다음 회차부터 반영돼요.

### 셸

가장 단순한 재진입 구조예요.

```bash
while :; do cat PROMPT.md | claude-code ; done
```

Geoffrey Huntley가 2025년에 쓴 [글](https://ghuntley.com/ralph/)에 나온 형태예요. 이름을 심슨 가족의 랄프 위검에서 따왔다는 설명과 파일 상태를 읽어가며 계속 시도한다는 특징은 해당 글의 사례로 소개할게요.

핵심은 진행 상황을 컨텍스트가 아니라 파일과 git 기록에 남기는 데 있어요. 매 회차 새 세션이 이전 상태를 디스크에서 읽으므로 세션이 죽어도 작업 기록은 남아요. 한 회차에는 한 작업만 시키고, 테스트와 빌드의 종료 코드를 중단 기준으로 삼으면 돼요.

### 스케줄과 cron: 세션 밖 일정 실행

이 기준으로 세션 밖 일정을 고를 때는 클라우드 루틴의 최소 간격이 1시간으로 제한된다는 점을 확인하고, 필요한 호출 빈도가 그 제한에 맞는지 먼저 따져야 해요.

### Channels: 외부 이벤트 트리거

시간 기반 반복과 스케줄은 정해진 시각마다 확인하므로, 3분마다 PR을 보는 루프처럼 아무 일 없는 회차가 생겨요. 사건이 있을 때만 움직여야 한다면 Channels가 CI나 에러 트래커 이벤트를 열린 세션으로 전달해요. MCP(외부 도구와 서비스를 연결하는 프로토콜) 서버가 그 통로가 될 수 있어요.

`Channels`로 Telegram이나 Discord를 연결하면 운영자는 휴대폰에서 질문을 보내고 대화방에서 답을 받아요. Channels로 연결된 작업 에이전트는 그동안에도 제 기계의 실제 파일을 대상으로 실행을 이어가요.

아직 리서치 프리뷰라 세션이 열려 있어야 이벤트가 도착하고, [공식 문서](https://code.claude.com/docs/en/channels)의 안내처럼 발신자 허용목록으로 잠가야 해요.

폴링(정해진 간격으로 상태를 다시 확인하는 방식)이 필요한지부터 가르면 대부분의 헛도는 회차를 줄일 수 있어요. 완료 조건·시간·외부 사건·실패 재진입 중 필요한 신호를 고르면, 하네스와 그래프에서 그 신호를 연결할 위치도 정할 수 있어요.

## 하네스·그래프·루프를 함께 구성하기

시간 트리거와 외부 사건은 실행을 시작할 뿐 완료를 판정하지 않아요. 오케스트레이터(작업 단계와 상태를 관리하는 실행 관리자)가 작업을 배분하면 하네스는 작업 에이전트에게 파일·도구·권한·상태를 제공하고, 그래프 정의는 작업 에이전트가 단계와 재진입 지점 사이에서 선택할 경로를 정해요.

evaluator는 실행 결과가 완료 조건을 만족하는지 확인해요. Anthropic의 장기 실행 앱 예시도 계획·구현·평가 담당자를 나누고 중간 결과를 파일로 남겨요.

![하네스 안에서 그래프가 흐르고 필요한 구간에서 루프가 되돌아가는 구조](/images/2026-09-loop-engineering/loop-harness-graph.svg)

이 SVG(확장 가능한 벡터 그래픽)와 로컬 코드 예제는 이 저장소의 현재 Git 작업 디렉터리(working tree)에 함께 둔 재현 자료예요. 아직 공개 `main`에 포함된 파일이 아니므로, 독자가 저장소에서 바로 받을 수 있는 공개 링크로 소개하지 않아요.

하네스·그래프·루프의 관계를 그린 개념도는 실행 가능한 설정이 아니라 세 요소가 어떻게 결합되는지 보여줘요.

```text
/schedule 매시간: #project-feedback 채널에서 버그 리포트를 확인한다.
/goal 이번 회차에 찾은 모든 리포트가 분류·처리·회신될 때까지 멈추지 않는다.
버그를 고칠 때는 워크플로로 세 가지 해법을 각각의 격리된 Git 작업 공간에서 병렬로 탐색하고, 심판 에이전트가 적대적으로 검토하게 한다.
```

일정 트리거가 작업을 시작하면 오케스트레이터는 세 격리 작업 공간에 에이전트를 배치해 각각의 해법을 탐색하게 하고, 각 작업 공간의 에이전트는 하네스가 허용한 파일·도구·권한만 사용해요. 심판 에이전트는 세 결과를 검토하고, `goal`은 완료 조건을 확인해요.

## 루프, 하네스, 그래프는 서로 다른 질문에 답한다

세 요소를 운영 질문으로 나누면 하네스는 무엇을 허용할지, 루프는 언제 다시 시작하고 멈출지, 그래프는 어느 단계로 이동할지를 결정해요. 이 구분이 있어야 실행 환경과 반복 정책, 단계 전이를 한 덩어리로 섞지 않을 수 있어요.

그래프는 작업 단계와 상태를 관리하는 실행 관리자가 작업자를 배치하고, 실패 뒤 돌아갈 위치와 병합 지점을 고정할 때 특히 유용해요. 그래프를 두면 전체를 처음부터 반복하지 않고 실패한 단계에서 다시 시작하는 경로를 남길 수 있어요.

이 구분을 구체화한 예가 LangGraph예요. LangGraph는 상태(state)·작업 단위(node)·연결(edge)로 작업 흐름을 구성하며, 상태 객체가 정보를 들고 노드가 일하고 엣지가 다음 작업 단위를 골라요. 여기서 그래프는 지식 그래프가 아니라 작업·에이전트·상태의 전이를 그린 워크플로예요. 설명의 기준은 [LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api)예요.

`Graph Engineering`은 이 전이를 하위 작업·병렬 실행·독립 검증·지속 상태까지 포함하는 실행 그래프로 명시하자는 최근 논의의 이름이에요. 표준화된 제품명이나 단일 구현을 뜻하지 않으며, [Graph Engineering survey](https://arxiv.org/abs/2608.21156)를 읽고 이 글의 맥락에 맞게 정리한 작성자 해석이에요.

이 관점에서 하네스 설계는 저장소 지식·추적 가능한 기록·완료 기준·검증과 복구 경계를 고정하는 일까지 포함해요. OpenAI의 [harness engineering](https://openai.com/index/harness-engineering/)은 이 조건을 다룬 인접 사례로 참고할 수 있어요.

Symphony는 issue tracker(작업 요청을 관리하는 도구)를 control plane(작업을 배분하고 상태를 관리하는 기준면)으로 삼고, 작업별 workspace(작업 공간)를 격리하는 운영 사례예요. 다만 Symphony를 Graph Engineering의 구현이라고 부를 근거는 없어요.

Steve Yegge의 [Gas Town](https://yegge.ai/essays/welcome-to-gas-town/)도 역할과 상태를 세분화한 별도 사례로 볼 수 있어요.

검증하지 않은 적용 예시로는, 경쟁사 조사에서 하네스에 검색 도구·문서 저장 공간·네트워크 권한을 두고 그래프에 기획자 → 병렬 조사자 → 통합자 → 검사자의 순서를 두는 구성을 들 수 있어요. [작성자 해석] 앞서 제시한 경쟁사 조사 예시의 검사 단계가 실패하면 전체를 처음부터 돌리지 않고 실패한 조사나 통합 단계로 돌아가는 식이에요.

```text
하네스
└─ 그래프
   ├─ 기획 → 조사자 A ─┐
   ├─      조사자 B ───┼→ 통합 → 검사
   └─      조사자 C ─┘              ├─ 통과 → 완료
                                   └─ 실패 → 해당 단계로 되돌림
```

역할을 나누면 작업자 사이에 전달할 약속과 상태가 늘어나고, 실패 지점과 운영 비용도 함께 늘어나요. 병렬 처리나 단계별 도구, 단계 단위 격리가 정말 필요한지 먼저 확인하는 편이 좋아요. 처음에는 3~5개 node로 실행을 관찰하고 규모를 키우면 돼요.

규모를 키우기 전에는 오케스트레이터가 중간 상태 저장·재시작·중복 이벤트·worktree(작업을 격리하는 Git 작업 공간)·외부 부작용 전 승인을 차례로 확인해야 해요. 이 경계를 정해 둬야 다음 회차가 어떤 상태를 읽고 외부 동작 앞에서 어디에 멈추는지 설명할 수 있고, 실패한 단계를 안전하게 다시 시작할 수 있어요.

이 검사를 건너뛰면 병렬 결과가 잘못 합쳐지거나 재시작 지점이 달라져 다음 회차가 엉뚱한 상태에서 출발할 수 있어요. 검증자는 edge 조건과 병렬 결과 병합을 살피고, 오케스트레이터는 재진입 지점과 상태·검증 경계를 고정한 뒤 그래프를 키워야 해요. 서브에이전트(상위 에이전트가 맡긴 하위 작업을 수행하는 별도 에이전트)의 중첩 상한은 버전에 따라 달라질 수 있어요.

## 루프의 실패 패턴

구성 요소와 노드를 늘릴수록 구조적 실패도 함께 늘어나요. [Kilo가 대표 실패 모드로 정리한](https://kilo.ai/articles/what-is-loop-engineering) 네 가지는 `thrashing`(겉돌기), `overfitting to tests`(테스트 과적합), `context drift`(맥락 이탈), `unsafe autonomy`(안전하지 않은 자율성)이에요.

목표 문장이 모호하거나 검증 기준이 흔들리면 작업자는 수정 방향을 잃고, 고쳤다가 되돌리는 `thrashing`이 생길 수 있어요. 검증 기준이 테스트에만 묶이면 에이전트는 테스트를 통과시키는 데 집중하므로, 테스트는 초록이어도 사람이 원한 기능이 빠지는 `overfitting to tests`로 이어져요.

작성자가 중간에 파일을 바꾸거나 새 사실을 추가했는데 작업 에이전트가 그 내용을 다시 읽지 않으면, 오래된 가정으로 계속 작업하는 `context drift`가 생겨요. 여기에 승인 없이 파괴적인 명령까지 허용하면 검증이 부실해서 생기는 비용을 넘어 권한 경계 밖의 실제 손실, 즉 `unsafe autonomy`로 이어질 수 있어요.

## 검증자를 작성자와 분리하기

[Osmani](https://addyosmani.com/blog/loop-engineering/)는 루프 설계에서 가장 유용한 구조적 이동을 "작성하는 에이전트와 검사하는 에이전트를 나누는 것"이라고 정리했어요. [Anthropic 하네스](https://www.anthropic.com/engineering/harness-design-long-running-apps)도 계획 담당자, 구현 담당자, 평가 담당자로 역할을 나눴어요.

구현 담당자가 파일을 쓰면 평가 담당자가 그 결과를 읽고 별도의 근거로 확인하는 구조예요.

Anthropic은 만드는 쪽의 자기 평가를 낮추기보다 별도 평가자를 회의적으로 튜닝하는 편이 다루기 쉽다고 설명해요. 공개된 게임 제작 실험의 비교 결과는 아래 표에 정리했어요.

### 만드는 값은 비싸고 채점하는 값은 싸다

Anthropic이 공개한 게임 제작 실험은 계획·구현·검증을 포함한 하네스 적용 여부를 비교해요.

| 조건 | 시간 | 비용 | 결과 |
| --- | ---: | ---: | --- |
| 하네스 없음 | 20분 | 9달러 | 화면에 개체는 나왔지만 입력에 반응하지 않음 |
| 하네스 적용 | 6시간 | 200달러 | 게임이 실제로 동작함 |

이 표에서 확인할 수 있는 정량 지표는 시간과 비용이고, 결과 열은 동작 여부를 가른 이진 판정이에요. 이 자료만으로 하네스가 모든 과제의 품질이나 비용 효율을 높인다고 해석할 수는 없어요.

하네스 적용 전후 비교를 다시 확인하려면 같은 과제·환경·입력 시나리오를 고정하고, 개체가 입력에 반응하는지를 관찰 가능한 통과 조건으로 판정해야 해요. 원 실험의 반복 횟수와 판정 로그, 세부 실행 환경은 이 글에서 확인하지 못했어요. 품질 향상률·다른 과제로의 일반화·장기 안정성도 미측정이에요.

같은 자료의 음악 편집기 사례에서 공개한 단계별 시간과 비용은 다음과 같아요.

| 단계 | 시간 | 비용 |
| --- | ---: | ---: |
| 계획 | 4.7분 | 0.46달러 |
| 1차 빌드 | 2시간 7분 | 71.08달러 |
| 1차 검수 | 8.8분 | 3.24달러 |
| 2차 빌드 | 1시간 2분 | 36.89달러 |
| 2차 검수 | 6.8분 | 3.09달러 |
| 3차 빌드 | 10.9분 | 5.88달러 |
| 3차 검수 | 9.6분 | 4.06달러 |
| 전체 | 3시간 50분 | 124.70달러 |

음악 편집기 사례의 검증자는 실행 중인 UI(사용자 화면)와 API(프로그램끼리 통신하는 규칙)에서 실제 결함을 찾았어요.

사각형 채우기·Delete 키·FastAPI의 세 결함이 비용 표와 동일한 실행의 후속인지까지는 원문에서 확인하지 못했어요. 같은 자료에 실린 별도 사례라는 범위에서만 소개할게요.

`mouseUp`은 마우스 버튼을 놓을 때 실행되는 이벤트이고, `selection`은 현재 선택 상태, `selectedEntityId`는 선택한 개체의 식별자예요. FastAPI는 파이썬 웹 프레임워크이고, `frame_id`는 프레임 식별자예요. `422`는 요청 형식 오류를 나타내는 웹 응답 코드예요.

- 사각형 채우기 도구가 드래그 시작점과 끝점에만 타일을 놓았어요. `fillRectangle` 함수가 `mouseUp`에서 제대로 불리지 않았어요.
- Delete 키 핸들러는 `selection`과 `selectedEntityId`가 모두 설정돼야 동작했어요. 개체를 클릭하면 후자만 설정됐어요.
- FastAPI는 `'reorder'`를 `frame_id` 정수로 매칭해 422를 냈어요. 문자열을 정수로 파싱할 수 없다는 응답이었어요.

사각형 채우기 도구·Delete 키 핸들러·FastAPI의 세 결함은 "UI 개선이 필요해요" 같은 두루뭉술한 말이 아니라, 개발자가 추가 조사 없이 곧바로 손댈 수 있을 만큼 구체적이에요.

## 검증할 수 있는 만큼만

구성 범위를 넓히다 보면 자율성도 함께 늘리고 싶어져요. 하지만 운영자는 검증할 수 있는 범위 안에서만 권한을 넓혀야 하고, [Osmani](https://skills.addy.ie/loops/)는 이 원칙을 back pressure(검증 가능한 만큼만 자율성을 주는 압력)라고 불러요. 기준이 뚜렷하고 결과를 관찰할 수 있는 테스트 통과 여부나 성능 지표 확인은 자동 판정에 맡기기 쉽지만, 보안·인증·공개 API 설계·과금·마이그레이션처럼 틀렸을 때 비용이 큰 결정은 사람이 봐야 해요.

권한은 발견과 보고에서 시작해 좁은 수정 경로로 넓히고, 마지막에 제한된 무인 실행을 검토하는 순서가 안전해요. 그래도 운영자의 부담은 사라지지 않아요. 에이전트 수를 수십 개로 늘려도 검토자의 주의력은 병렬화되지 않으므로, 자동 루프의 결과를 다시 확인하지 않으면 잘못된 결과가 완료로 굳어지고 최종 처리량은 사람이 검토할 수 있는 양에 묶여요.

## 루프는 어떻게 스스로 멈추나

자율성을 주려면 멈춤도 시스템 계약 안에 넣어야 해요. 제가 관심 있게 보는 건 오류 이름보다 시스템이 다음 회차를 계속할지 취소할지를 구분하는 방식이에요. `/goal`의 evaluator는 인증 풀림, 크레딧 소진, 컨텍스트 압축 실패, 모델 사용 불가처럼 복구하지 않으면 반복될 오류를 사용자가 고쳐야 하는 실패로 판단하고, 이런 경우 Claude Code는 목표를 지워요. 호스트가 자격 증명을 자동으로 복구하면 목표가 유지될 수도 있어요. 반대로 속도 제한·서버 과부하처럼 잠시 뒤 사라질 실패는 목표를 유지해요.

백그라운드 작업이 남아 있으면 evaluator는 판정을 미뤄요. Claude Code는 30분이 지난 뒤 한 번 확인하고, 그다음에는 1시간, 이후에는 2시간 간격으로 확인해 불필요한 판정을 줄여요. 조건문은 4,000자까지 쓸 수 있고 세션당 목표는 하나뿐이라 새 목표를 걸면 이전 목표가 교체돼요. 이 운영 경계는 사고를 줄이는 장치일 뿐이므로, 작업 완료는 테스트 결과나 로그로 따로 확인해야 해요.

## 하네스 구성은 다시 평가해야 한다

구성 요소를 잘 배치하는 것만으로 끝나지 않는 이유가 하나 더 있어요. [Anthropic 글](https://www.anthropic.com/engineering/harness-design-long-running-apps)에는 스프린트(짧게 나눈 작업 구간)를 잘게 쪼개는 구조를 넣었다가 없앤 이야기가 나와요. 모델이 한 세대 좋아지면서 두 시간을 쪼개지 않고 한 번에 달릴 수 있게 됐고, 그 부품이 더는 필요하지 않았거든요.

제가 붙인 구성 요소 하나하나는 "모델이 이건 못 할 것"이라는 판단이라, 모델이 바뀌면 그 판단도 다시 재야 해요. 모델이 좋아져도 필요한 안전장치가 모두 사라지는 건 아니고, 맡길 위치가 바뀐다고 하더라고요.

## 내가 만든 시스템에도 이 구조가 있었다

개인 프로젝트로 Slack 기반 멀티 에이전트 시스템을 굴리고 있어요. 개인 설정값은 작성자 개인 기록이며, 원본 설정 파일은 비공개라 독립 재현·검증이 불가능하고 성과 측정값도 아니에요.

| 설정 항목 | 값과 단위 | 확인일·범위 | 측정하지 않은 것 |
| --- | --- | --- | --- |
| 정기 실행 항목 | 33종 | 2026-09-04 설정 항목 전체를 센 값 | 장기 실행 횟수·성공률·비용 |
| `agent/code-reviewer` 주기 | `*/3 * * * *`, 3분 간격 | 2026-09-04 해당 실행 슬롯 설정 | 실제 실행 횟수와 누락 여부 |
| 같은 PR 쿨다운 | 10분 | 2026-09-04 해당 슬롯 설정 | 쿨다운 뒤 재실행 결과 |
| 외부 재시도 | 최초 실행 뒤 24시간 동안 3회 | 2026-09-04 해당 슬롯 설정 | 내부 재시도와 합친 최대 시도 수 |
| 에이전트 CLI(명령줄 인터페이스) 내부 재시도 | 최초 호출을 제외하고 2회 | 2026-09-04 해당 슬롯 설정 | provider별 실제 호출·성공률 |

외부 재시도와 내부 재시도를 곱하거나 합친 최대 시도 수는 장치의 중첩·취소 규칙을 확인하지 않아 계산하지 않았어요.

Slack 기반 멀티 에이전트 시스템에서는 설계자와 구현자, 결정론 게이트, 리뷰 에이전트의 역할을 분리해 두었어요. 작업이 실패하면 전체를 처음부터 돌리지 않고 실패한 단계로 돌아가도록 구성했어요.

외부 동작은 사람 승인 뒤에 실행하도록 묶었어요. 개인 시스템의 장기 성공률은 측정하지 않았어요.

개인 시스템의 실행 결과와 구분해, 같은 구조를 재현할 때 사용할 **로컬 계약 예제**를 함께 뒀어요. 이 예제는 외부 provider를 호출하지 않고 테스트 코드의 `effect()` 함수와 `persist()` 콜백으로 외부 호출과 결과 저장을 모사해요. 실제 제품을 흉내 내지 않고 상태 전이와 검증 경계만 작게 구현했어요. 로컬 계약 예제의 `manual_review` 상태는 자동 진행을 멈추고 사람이 확인하는 단계예요.

### 입력 계약

`JSON`은 키와 값을 묶는 텍스트 형식이고, fixture는 테스트에 넣는 고정 입력이에요. 로컬 계약 예제의 입력은 fixture 함수 배열 또는 `{ fixtures, expectedOverallExitCode }` 시나리오 객체이며, `expectedOverallExitCode`는 전체 fixture 결과의 기대 종료 코드예요.

`makeFixture()`는 입력 객체를 호출 가능한 함수로 만들고, 그 함수는 비동기 실행 결과를 `Promise`로 돌려줘요. `runVerification()`은 배열이나 시나리오 객체의 fixture를 실행해 각 결과의 `expectedExitCode`와 전체 `expectedOverallExitCode`를 확인해요. 아래 JSON은 이 입력 계약과 상태·단계를 함께 보여주는 설명용 메타데이터이고, 실행 함수 자체는 아니에요.

```json
{
  "contractVersion": "1.2.0",
  "taskId": "loop-contract-2026-09-04-001",
  "eventId": "fixture-three-tests-one-failure-001",
  "fixtureId": "one-failure-three-fixtures",
  "action": "verify",
  "fixtures": [
    {"fixtureId": "fixture-pass-1", "name": "test_pass_1", "expectedExitCode": 0},
    {"fixtureId": "fixture-fail-1", "name": "test_fail_1", "expectedExitCode": 1},
    {"fixtureId": "fixture-pass-2", "name": "test_pass_2", "expectedExitCode": 0}
  ],
  "expectedOverallExitCode": 1,
  "maxAttempts": 3,
  "states": ["running", "failed", "awaiting_approval", "expired", "manual_review", "completed"],
  "stages": ["plan", "build", "verify", "review", "completed"]
}
```

### 상태와 lease

하네스의 `Map`은 키로 상태를 찾는 메모리 저장소예요. 외부효과 선점과 결과 저장을 구현한 파일은 저장소 상대 경로 `examples/loop-engineering-reference-harness/contract.test.js`에서 확인할 수 있어요.

아래 상태 JSON은 현재 작업의 lease와 외부효과 상태를 보여주는 예시예요.

```json
{
  "contractVersion": "1.2.0",
  "taskId": "loop-contract-2026-09-04-001",
  "eventId": "fixture-three-tests-one-failure-001",
  "fixtureId": "one-failure-three-fixtures",
  "action": "verify",
  "idempotencyKey": "loop-contract-2026-09-04-001:fixture-three-tests-one-failure-001:verify",
  "stage": "plan",
  "status": "running",
  "version": 1,
  "attempts": 0,
  "leaseOwner": "worker-a",
  "leaseUntil": 110,
  "leaseToken": 1,
  "timeoutAt": 130,
  "externalEffect": {"status": "none", "externalId": null, "result": null, "calledAt": null},
  "failureHistory": [],
  "transitionHistory": [],
  "approval": null
}
```

`idempotencyKey`는 같은 이벤트의 중복 처리를 막는 키예요. 이 키는 `taskId:eventId:action`으로 안정적으로 만들고 타임스탬프나 난수를 섞지 않아요. 상태 저장소는 `(taskId, eventId, action)` 조합에 unique 제약(같은 조합을 하나만 허용하는 규칙)을 둬야 해요.

오케스트레이터는 선점과 `running` 전환을 CAS(compare-and-swap, 읽은 상태가 그대로일 때만 갱신하는 원자적 비교·교환)처럼 처리해야 해요. 구현은 한 메모리 `Map`에서 두 Promise 요청을 조건부로 처리해 같은 입력을 한 번만 선점하는 상황을 모사해요.

두 Promise 요청의 단일 프로세스 메모리 선점 검증은 메모리 계약에 한정돼요. 실제 데이터베이스 CAS나 여러 프로세스 간 락의 원자성은 검증하지 않아요.

`running`에는 현재 작업자 `leaseOwner`와 작업 권한인 lease의 만료 시각 `leaseUntil`을 두고, 상태의 `leaseToken`으로 이전 lease를 구분해요. `leaseOf()`가 반환하는 lease 객체는 상태의 `leaseToken`을 `token`이라는 필드로 담아요.

`worker-a`의 lease가 만료되면 `worker-b`가 한 번 회수하고 상태의 `leaseToken`을 증가시켜요. 그러면 회수된 `worker-a`의 lease 객체는 fencing에서 거부되고, 새 `token`을 받은 `worker-b`만 진행할 수 있어요.

전체 `timeoutAt`이 지나면 작업을 자동 재시작하지 않고 `expired`로 이동해요. `runVerification()`은 검증에 들어갈 때 이 시각을 확인해, 이미 만료됐으면 fixture를 실행하지 않아요.

### 검증 결과와 상태 전이

정상 경로는 `plan → build → verify → review → completed`예요. 작업자는 먼저 claim으로 작업을 선점한 뒤 `moveToBuild()`와 `moveToVerify()`를 거쳐 검증 단계로 이동하고, `runVerification()`은 검증이 성공했을 때 `review`로 옮겨요. 이어 `completeReview()`가 검토 근거와 성공한 검증 결과를 확인해야 작업을 `completed`로 바꾸고 완료 보고를 만들 수 있어요.

검증자는 각 fixture와 전체 시나리오의 기대 종료 코드를 실제 결과와 비교하고, 비교를 통과한 결과에 fixture별 식별자·이름·종료 코드·표준 출력·표준 오류를 기록해요. 기대값이 틀리면 `runVerification()` 자체가 실패하므로 검증 기록과 상태 전이를 남기지 않고, 실제 fixture 결과가 실패한 경우에는 작업을 `failed`에 멈춰 완료 보고를 만들지 않아요.

실패한 작업은 최초 시도를 포함해 세 번까지 다시 실행할 수 있고, 세 번째 실패 뒤에는 `awaiting_approval`에서 자동 재시도를 멈춰요.

승인에는 주체·시각·근거가 필요해요. 유효한 lease에서는 기존 `leaseOwner`와 lease 객체의 `token`을 재사용하고, lease가 만료된 경우에는 `approveRetry()`가 `leaseToken`을 증가시켜 새 `token`과 소유자를 발급한 뒤 `running`으로 복귀해요.

사람은 `expired` 작업을 `manual_review`로 옮겨 산출물과 외부 기록을 대조해요.

### 외부효과·종료 코드·실행 기록

외부효과는 승인 뒤 한 번만 `claimed`로 선점해요. 이미 `confirmed`인 결과를 다시 요청하면 provider를 호출하지 않고 저장된 결과를 재사용해요.

provider가 거부하면 `externalEffect.status`를 `failed`로 기록하고 `externalEffect.calledAt`에 호출 시각을 남긴 뒤 작업도 `failed`로 전이해요. provider 응답을 저장하는 데 성공하면 `confirmed`, `externalId`, `result`, `externalEffect.calledAt`을 함께 기록해요.

로컬 계약 예제에서 provider 호출 뒤 `persist()`가 실패하면 예제는 외부효과를 `claimed`에 남기고 `externalEffect.calledAt`을 `null`로 둔 채 작업 상태를 `manual_review`로 옮겨요. 예제는 저장 성공 여부를 알 수 없으므로 provider를 자동으로 다시 부르지 않아요.

예제의 범위는 승인 뒤 외부효과를 어떤 상태로 기록하고, 저장이 불확실할 때 어디서 사람에게 넘기는지 재현하는 데 있어요.

실행 기록에는 환경 정보를 먼저 남겨요. 저장소 루트는 `/Users/juneseok/repos/JSL107.github.io`이고, 실제 checkout의 커밋은 `git rev-parse HEAD`로 확인해요. `node --version`과 `uname -a`의 결과도 함께 기록해요.

사용한 CLI 버전은 `--version`으로 남겨요. provider 이름·인증 방식·권한 모드도 실행 조건에 포함하지만, 이 글에서는 개인 시스템의 실제 Claude Code·CLI 버전·provider·권한을 확인하지 않았어요.

결과 기록에는 입력과 실행 명령, 시작·종료 시각, 표준 출력·표준 오류, 상태 JSON과 로그 경로를 남겨요. 실행 로그의 기본 위치는 `artifacts/loop-engineering-reference-harness/node-test.log`예요.

프로세스 종료 코드와 내부 판정은 구분해 기록해요. `node --test`의 프로세스 종료 코드 `0`은 계약 테스트 전체의 통과를 뜻하고, `runVerification()`이 fixture 결과를 모아 기록하는 내부 `overallExitCode`는 실패 시나리오에서 `1`, 성공 시나리오에서 `0`이에요. 따라서 실패 fixture의 내부 코드가 의도대로 `1`이어도 그 값을 검증하는 테스트가 통과하면 테스트 프로세스는 `0`으로 끝나요.

```bash
cd /Users/juneseok/repos/JSL107.github.io
mkdir -p artifacts/loop-engineering-reference-harness
node --test examples/loop-engineering-reference-harness/contract.test.js \
  2>&1 | tee artifacts/loop-engineering-reference-harness/node-test.log
```

2026-09-04 재실행에서는 테스트 출력과 fixture별 상태를 이렇게 관찰했어요.

| 입력·실행 | 기대 상태 | 실제 관찰값 |
| --- | --- | --- |
| 전체 `node --test` 실행 | 모든 계약 테스트 통과, 종료 코드 0 | 17개 통과, 종료 코드 0 |
| 같은 `(taskId, eventId, action)` 두 번 입력 | 한 번 선점하고 두 번째 요청은 기존 상태 반환 | `task-1:event-1:verify` 한 개와 중복 선점 거부 확인 |
| `worker-b`가 만료된 `worker-a`의 lease를 회수 | `leaseOwner` 변경과 새 fencing token, stale worker 차단 | `worker-a → worker-b`, token 증가와 `worker-a`의 이후 갱신 거부 확인 |
| 실패 후 `maxAttempts: 3`까지 재진입 | `failed → running → awaiting_approval`, `completed` 금지 | 총 3회 시도, 최종 `awaiting_approval`, 완료 전이 없음 확인 |
| 유효 lease에서 `approveRetry` | 기존 `leaseOwner`·`leaseToken` 재사용 | `worker-a/token 1` 유지, 승인 뒤 `running` 확인 |
| 만료 lease에서 `approveRetry` | 새 lease·fencing token 발급 뒤 `running` 복귀 | `reviewer-2/token 2` 발급, 승인 뒤 `running` 확인 |
| 성공 fixture 실행 | `plan → build → verify → review → completed` | `success-two-fixtures`, `test_pass_1`, `test_pass_2` 실행 후 완료 보고 생성 |
| 검증 진입 시 `timeoutAt` 도달 | fixture 실행 없이 `expired`, 자동 재시작 금지 | `now = timeoutAt`에서 fixture 호출 0회와 `expired` 확인 |
| 승인 전 외부효과 실행 | provider 함수 호출 차단 | 승인 누락 호출 0회, `{ actor, approvedAt, evidence }` 저장 후 `confirmed` 확인 |
| provider 함수 reject | 호출 결과를 실패로 기록하고 재호출 금지 | provider 호출 1회, `externalEffect = failed`, 상태 `failed` 확인 |
| 확인된 외부효과 재요청 | 저장된 결과 재사용, provider 중복 호출 금지 | provider 호출 1회, 두 번째 요청에서 기존 결과 반환 확인 |
| 외부효과 claim 뒤 결과 저장 실패 | 자동 재시도 없이 `manual_review` | `externalEffect.status = claimed` 유지와 `manual_review` 전이 확인 |
| `transition(..., completed)` 직접 호출 | `completeReview()` 없는 완료 우회 차단 | 직접 호출 거부, 상태 `running/review` 유지 확인 |
| `expired` 후 검토 요청 | `expired → manual_review`, 자동 재시작 금지 | 두 상태의 순서 확인 |
| 새 `StateStore(snapshot)` 생성 | 메모리 snapshot 범위에서 상태·이력 복원 | 새 인스턴스의 `fixtureId`, 상태, 이력 일치 확인 |
| 개인 시스템 33종·10분·24시간 3회·CLI 2회 | 설정값만 기록 | 실행 횟수·성공률·비용은 확인하지 않음 |

외부 동작 앞에는 사람 승인 단계가 남아 있어요. 운영자는 승인 카드의 TTL(time to live, 승인 정보가 유효한 기간)이 지나면 공개 저장소 커밋이나 외부 발송처럼 되돌리기 어려운 동작을 멈추도록 정책을 정해야 해요.

장치는 문제 유형뿐 아니라 현재 확인할 수 있는 범위까지 함께 보고 골라야 해요.

| 문제 유형 | 선택 장치 | 선택 이유 | 현재 측정 여부 |
| --- | --- | --- | --- |
| 완료 여부가 불명확함 | `/goal` 또는 Stop hook | 종료 조건을 세션 또는 설정 범위에서 검사 | 참조 계약 상태 전이는 실행 확인 |
| 열린 세션에서 반복 확인이 필요함 | `/loop` | 시간 간격으로 같은 프롬프트를 다시 실행 | `agent/code-reviewer`의 3분 주기 설정 확인; 실행 횟수 미측정 |
| 파일 상태를 다음 회차에 이어야 함 | 셸 루프(Ralph) | 새 세션이 파일·Git 기록을 읽어 컨텍스트를 이어감 | 실행 결과는 미측정 |
| 정해진 시각에 시작해야 함 | 로컬 스케줄 또는 cron | 기계·파일 접근 조건에 맞춰 일정 실행 | 설정 항목 수만 확인 |
| 외부 사건이 생길 때만 반응해야 함 | Channels | CI·에러 트래커 이벤트를 열린 세션에 전달 | 개인 시스템에서 실행 결과는 미측정 |
| 실패 단계만 재실행하거나 병렬 처리해야 함 | 그래프 | 단계·분기·재진입·병합 지점을 상태와 함께 고정 | 검증자는 단계 전이·재진입을 확인하지만 병렬 실행은 측정하지 않음 |

문제와 검증 기준을 사람이 함께 정해 두면 루프를 운영할 수 있어요. 실제 시스템에 적용할 때는 앞서 말한 실행 기록을 먼저 남기고, 미확인 상태에서는 자동 재시도보다 `manual_review`를 선택해야 해요.

## 마무리

도입부의 테스트 세 개 중 하나가 빨간데도 "다 고쳤습니다"라고 보고하는 문제는, 에이전트의 한 회차가 끝났다는 사실을 완료의 증거로 착각할 때 생겨요.

로컬 하네스에서는 실패 fixture가 `failed`에 멈추고, 성공 fixture만 검토를 거쳐 `completed`에 도달해요.

실제 시스템에서는 먼저 검증 범위와 근거를 기록한 다음, 승인 주체·시점과 외부효과를 호출할 수 있는 경계를 함께 적어 둬야 해요. 그래야 루프가 계속 도는지만이 아니라 무엇을 확인했고 어디서 사람에게 제어권을 돌렸는지까지 설명할 수 있어요.

## 출처

제품 동작과 제한은 문서 확인 시점과 버전에 따라 달라질 수 있어요. 자료는 2026년 9월 4일에 직접 확인했어요. 인스타그램은 보조 자료이며, 접근되지 않더라도 공개 문서와 본문 설명만으로 핵심 주장을 확인할 수 있도록 구성했어요.

| 제목 | 자료 링크 | 본문 주장 대응 | 확인일 |
| --- | --- | --- | --- |
| Loop Engineering | [직접 링크](https://addyosmani.com/blog/loop-engineering/) | 프롬프트를 직접 반복하기보다 프롬프트를 실행하는 루프를 설계한다는 관점, 작성자와 검증자 분리 | 2026-09-04 |
| Harness design for long-running application development | [직접 링크](https://www.anthropic.com/engineering/harness-design-long-running-apps) | 컨텍스트 불안, planner·generator·evaluator 구조, 비용 비교와 UI·FastAPI 결함 사례 | 2026-09-04 |
| Keep Claude working toward a goal | [직접 링크](https://code.claude.com/docs/en/goal) | `/goal`·Stop hook의 완료 판정, evaluator, 세션 범위와 재시작 | 2026-09-04 |
| Run prompts on a schedule | [직접 링크](https://code.claude.com/docs/en/scheduled-tasks) | `/loop`·cron·스케줄의 실행 조건, 세션 수명과 7일 만료 | 2026-09-04 |
| Push events into a running session with channels | [직접 링크](https://code.claude.com/docs/en/channels) | Channels의 외부 이벤트 전달, 열린 세션·허용목록·research preview 조건 | 2026-09-04 |
| Using Goals in Codex | [직접 링크](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) | 목표의 수명·계속 진행 정책·예산과 증거를 묶는 완료 계약 | 2026-09-04 |
| Subagents | [직접 링크](https://code.claude.com/docs/en/sub-agents) | 서브에이전트 중첩과 동시 실행 상한 | 2026-09-04 |
| Graph API overview | [직접 링크](https://docs.langchain.com/oss/python/langgraph/graph-api) | state·node·edge로 작업 흐름을 표현하는 방식 | 2026-09-04 |
| Graph Engineering in the Era of LLM Agents: From Individual Intelligence to System Intelligence | [직접 링크](https://arxiv.org/abs/2608.21156) | Graph Engineering을 표준이 아닌 최근 논의로 한정하고 상태·전이·복구를 종합한 해석 | 2026-09-04 |
| Harness engineering: leveraging Codex in an agent-first world | [직접 링크](https://openai.com/index/harness-engineering/) | repository knowledge, agent legibility, acceptance criteria, validation/recovery loop | 2026-09-04 |
| An open-source spec for Codex orchestration: Symphony | [직접 링크](https://openai.com/index/open-source-codex-orchestration-symphony/) | issue tracker를 control plane으로 보고 workspace 격리와 상태를 함께 다룬 인접 운영 사례 | 2026-09-04 |
| Welcome to Gas Town | [직접 링크](https://yegge.ai/essays/welcome-to-gas-town/) | 역할·상태·세션을 세분화한 사례 | 2026-09-04 |
| Loop engineering with agent-skills | [직접 링크](https://skills.addy.ie/loops/) | back pressure 원칙과 작성자·검증자 분리 | 2026-09-04 |
| What Is Loop Engineering? | [직접 링크](https://kilo.ai/articles/what-is-loop-engineering) | 반복·관찰·조정과 대표 실패 모드 | 2026-09-04 |
| Ralph Wiggum as a "software engineer" | [직접 링크](https://ghuntley.com/ralph/) | 파일 상태를 바탕으로 새 세션을 반복 실행하는 셸 루프의 외부 사례 | 2026-09-04 |
| Loop Engineering 로컬 재현 예제 구현·계약 테스트 | `examples/loop-engineering-reference-harness/contract.test.js` | 메모리 조건부 갱신 모사, 단계 전이, timeoutAt, 승인 전 외부효과 차단, fixture 결과 | 2026-09-04 |
| Loop·하네스·그래프 개념도 SVG | `public/images/2026-09-loop-engineering/loop-harness-graph.svg` | 본문의 개념도 | 2026-09-04 |
| 짐코딩, 프롬프트 → 하네스 → 루프, 그다음이 그래프 엔지니어링 | [직접 링크](https://www.instagram.com/p/DcA4atTE_W3/?img_index=7) | 루프·하네스·그래프 관계를 생각하게 한 보조 자료. 접근 불가여도 핵심 주장에 의존하지 않음 | 2026-09-04 |
