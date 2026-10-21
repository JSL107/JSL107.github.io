---
title: "Langfuse 4로 에이전트 실행 단계를 관측하기"
description: "Langfuse 4의 observation 모델을 에이전트 실행에 적용할 때 필요한 추적 설계, 평가 기준, 운영 조건을 살펴본다."
pubDatetime: 2026-10-17T09:00:00+09:00
category: infra
---

Slack 명령 하나가 실패했는데 로그에는 “PM Agent 실행 실패”만 남아 있다면, 운영자는 원시 로그를 다시 뒤져야 해요. GitHub issue 조회가 느렸는지, LLM 호출이 빈 응답을 냈는지, parser가 JSON을 읽지 못했는지, Slack 응답 전송에서 막혔는지 바로 알 수 없으니까요.

이 글은 Langfuse 4 공식 문서, OpenTelemetry 연동 문서, 4 버전 changelog, evaluation 문서, self-hosting 문서와 공식 GitHub 저장소를 읽고 정리한 조사 글이에요. 직접 붙여 운영한 후기는 아니고, 이 시스템에 어디부터 적용할 만할지 판단한 내용도 담았어요.

## 실행 로그 안의 작업 단위를 봐야 한다

기존 백엔드에서는 보통 request log, job log, domain event, 혹은 AgentRun 같은 실행 레코드를 남겨요. 운영 이력을 기록하기에는 충분한 방식이에요. 누가 어떤 trigger로 어떤 agent를 실행했고, 성공했는지 실패했는지, 최종 output은 무엇이었는지 남길 수 있으니까요.

LLM 에이전트에서는 “성공”과 “실패” 사이가 그렇게 단순하지 않아요. 응답은 성공했어도 비용이 갑자기 늘 수 있고, 최종 JSON은 parse됐어도 근거가 부실할 수 있어요. GitHub 조회에 성공했지만 diff가 너무 커서 prompt가 잘렸을 수도 있죠. Slack 사용자는 똑같이 “느리다”고 느껴도 실제 병목은 CLI provider, external API, parser, retry step 중 하나일 수 있어요.

Langfuse 4는 이런 중간 단계를 살펴볼 수 있게 해요. trace는 한 요청이나 작업 전체를 묶고, observation은 그 안에서 실제로 벌어진 개별 단계를 나타내요. LLM call, tool call, retrieval, internal step을 observation으로 기록하면 실행을 구성하는 단계를 직접 검색하고 집계할 수 있어요.

Langfuse의 data model에서 trace는 사용자 요청이나 작업 하나를 나타내요. 사용자가 Slack에서 오늘 할 일을 묻고 에이전트가 GitHub assigned task를 읽어 daily plan을 생성했다면, 그 흐름을 하나의 trace로 묶을 수 있어요. 그 안의 Slack handler, GitHub lookup, model routing, CLI completion, parser, response formatting은 각각 observation이 될 수 있죠. observation에는 latency, input, output, metadata, error를 붙일 수 있고, generation 타입에서는 model, token usage, cost 같은 LLM 정보도 다룰 수 있어요.

4 버전에서는 trace-level attribute가 각 observation row에도 복사돼요. user_id, session_id, tags, metadata가 trace 루트뿐 아니라 observation마다 붙는 거죠. 덕분에 특정 agentType의 LLM 호출이나 특정 Slack channel에서 발생한 parser 실패, 특정 release 이후 latency가 튄 tool call을 필터링할 수 있어요.

| 기존 실행 로그 관점 | Langfuse 4 observation 관점 |
| --- | --- |
| AgentRun 한 건이 성공/실패를 가진다 | AgentRun 안의 단계들이 각각 성공/실패·latency를 가진다 |
| 최종 output 중심으로 본다 | input/output/error/metadata를 단계별로 본다 |
| 장애 분석에 유용하다 | 장애 분석과 품질 평가를 같은 데이터 위에서 이어간다 |
| 집계 기준이 실행 단위에 묶인다 | LLM call, tool call, parser 등 관측 단위로 집계한다 |

데이터 모델이 바뀌면 운영할 때 던질 수 있는 질문도 달라져요. “어제 agent-run 실패가 몇 건인가?”에서 더 나아가 “어제 code-reviewer의 generation observation 중 cost 상위 10개는 무엇인가?”, “be-fix webhook에서 GitHub lookup은 정상인데 parser만 실패한 비율은 얼마인가?”도 물을 수 있어요.

## TypeScript 앱에서는 OpenTelemetry 입구를 먼저 잡아야 한다

TypeScript의 최신 연동 흐름은 @langfuse/tracing, @langfuse/otel, OpenTelemetry NodeSDK를 조합하는 방식이에요. Langfuse가 OpenTelemetry 위에 올라가 있으니 NestJS에서도 앱 entrypoint 쪽에서 instrumentation을 먼저 등록하는 편이 맞아요. 공식 quickstart의 최소 설치와 초기화는 다음 형태예요.

```bash
npm install @langfuse/tracing @langfuse/otel @opentelemetry/sdk-node
```

```typescript
// instrumentation.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

export const sdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
});

sdk.start();
```

```plain text
LANGFUSE_SECRET_KEY = "sk-lf-..."
LANGFUSE_PUBLIC_KEY = "pk-lf-..."
LANGFUSE_BASE_URL = "https://cloud.langfuse.com"
```

NestJS라면 이 코드를 main.ts보다 먼저 import되는 파일에 두는 게 자연스러워요. controller나 usecase가 실행되기 전에 OpenTelemetry context가 준비돼야 Slack handler에서 시작한 trace 아래에 GitHub client, model-router, CLI provider observation을 같은 흐름으로 묶을 수 있으니까요.

이 시스템에서는 AgentRunService.execute를 root trace로 삼는 게 가장 알맞아요. 모든 에이전트 실행이 이미 begin → run → finish lifecycle을 거치고, agentType, triggerType, runId 같은 메타데이터도 여기에 모이거든요. 그 아래에 github, model-router, agent/code-reviewer, agent/work-reviewer, slack 같은 모듈의 observation을 추가하면 돼요.

Langfuse는 observation type을 제공해요. span은 일반 작업 구간, generation은 LLM 생성, tool은 외부 도구나 함수 호출, agent는 흐름을 결정하는 에이전트 구성요소, retriever는 조회 단계, evaluator는 평가 단계에 쓸 수 있어요. TypeScript 예시에서는 startActiveObservation에 asType을 넘겨요.

```typescript
import { startActiveObservation } from "@langfuse/tracing";

await startActiveObservation(
  "agent-workflow",
  async (agentObservation) => {
    agentObservation.update({
      input: { query: "What's the weather in Paris?" },
      metadata: { strategy: "tool-calling" }
    });

    const result = await processWithTools(query);

    agentObservation.update({ output: result });
  },
  { asType: "agent" }
);
```

공식 예시의 “weather in Paris”는 이 시스템에 대입하면 agent/pm의 daily plan 생성이나 agent/code-reviewer의 PR 리뷰 생성에 해당해요. processWithTools(query) 자리에는 GitHub assigned task 조회, PR diff 조회, CLI provider 호출, output parser 호출을 포함한 usecase가 들어가고요. 각 도구 호출은 tool observation으로 분리할 수 있어요.

```typescript
await startActiveObservation(
  "weather-api-call",
  async (toolObservation) => {
    toolObservation.update({
      input: { location: "Paris", units: "metric" },
    });

    const weather = await weatherService.getWeather("Paris");

    toolObservation.update({ output: weather });
  },
  { asType: "tool" }
);
```

이 예시는 OctokitGithubClient의 PR detail 조회나 assigned issue 조회, Slack response 전송 같은 단계와 가까워요. GitHub API 호출은 LLM 품질과 별개로 실패하거나 느려질 수 있어 tool로 분리할 가치가 있어요. 반면 agent/vacation처럼 LLM을 자연어 파라미터 추출에만 쓰고 핵심 계산은 결정론인 모듈이라면, 추출 부분만 generation으로 두고 계산은 일반 span으로 두면 충분해요.

metadata를 필터와 metric의 기준으로 쓰려면 trace 루트에만 붙여서는 부족해요. 나중에 필터링할 agentType, triggerType, runId 같은 값은 모든 observation에 전파되도록 처음부터 설정해야 해요.

## 운영 trace를 평가 데이터로 잇기

LLM 시스템의 장애가 늘 exception으로 드러나지는 않아요. 모델이 친절하게 답했지만 내용이 틀릴 수 있고, JSON schema는 맞아도 중요한 근거를 빠뜨릴 수 있어요. Langfuse evaluation은 online과 offline을 함께 다뤄요. production trace에 score를 붙여 품질 추이를 살피고, 실패 사례를 dataset으로 올린 뒤 experiment로 prompt·model·code 변경을 비교해요. CI/CD gate로 회귀를 막는 단계까지 이어져요.

운영 중인 trace에서 실패 사례를 dataset으로 만들 수 있다면 운영과 실험이 같은 데이터 모델을 쓰게 돼요. “어제 Slack에서 이상한 답변이 나왔다”는 사례를 다음 PR에서 같은 입력 세트로 다시 실행하고 threshold를 넘는지 확인하는 식이에요.

이 시스템에서는 agent/code-reviewer, agent/work-reviewer, agent/pm이 먼저 후보고요. 세 모듈 모두 output 품질이 중요하고 같은 입력으로 회귀 평가를 만들 수 있어요. 반면 agent/delay-report처럼 결정론 조회의 비중이 큰 모듈은 LLM 평가보다 SQL/도메인 invariant 테스트가 먼저예요.

Langfuse의 CI/CD experiment 문서는 dataset, evaluator, threshold를 묶어 배포 전 회귀를 막는 흐름을 제시해요. GitHub Actions에서는 langfuse/experiment-action을 사용하고, 실험 코드는 Python 또는 TypeScript로 작성할 수 있어요. TypeScript experiment는 다음과 같은 형태예요.

```typescript
import type { ExperimentTaskParams, RunnerContext } from "@langfuse/client";

// Define a task that calls your agent with each dataset item.
async function myTask(item: ExperimentTaskParams) {
  // ...
}

export async function experiment(context: RunnerContext) {
  return await context.runExperiment({
    name: "PR gate",
    task: myTask,
  });
}
```

GitHub Actions 쪽에서는 dataset 이름과 experiment 경로를 넘겨요.

```yaml
- uses: langfuse/experiment-action@
  with:
    langfuse_public_key: ${{ secrets.LANGFUSE_PUBLIC_KEY }}
    langfuse_secret_key: ${{ secrets.LANGFUSE_SECRET_KEY }}
    langfuse_base_url: https://cloud.langfuse.com
    experiment_path: experiments/support-agent-gate
    dataset_name: support-agent-regression-set
    github_token: ${{ github.token }}
```

예시의 support-agent-regression-set은 이 시스템에서 code-reviewer/regression, pm/daily-plan-regression, work-reviewer/worklog-regression 같은 dataset으로 생각할 수 있어요. production에서 실제로 실패한 observation을 dataset item으로 올리고, PR마다 같은 입력을 다시 실행해 score를 비교하는 식이에요.

dataset이 없다면 CI gate는 껍데기에 그쳐요. 먼저 어떤 실패 사례를 고를지 기준을 정해야 해요. agent/code-reviewer에서는 “diff를 읽지 못한 리뷰”, “근거 없는 지적”, “JSON parser 실패”, “리뷰 없음인데 문제 있음으로 판단” 같은 케이스가 dataset 후보예요.

## self-host와 짧은 작업의 운영 조건

Langfuse는 오픈소스이고 self-host할 수 있어요. 공식 GitHub 저장소에서는 LLM observability, evals, metrics, prompt management, datasets, playground, integrations를 제공하는 AI engineering platform으로 소개해요. 라이선스는 기본적으로 MIT지만 ee 폴더에는 예외가 있어요.

4 버전 self-hosting 문서는 web, worker, Postgres, ClickHouse, Redis/Valkey cache, S3/blob store 계열 구성을 전제로 설명해요. ClickHouse는 traces, observations, scores 같은 분석성 데이터를 맡고, worker는 event를 비동기로 처리해요. ClickHouse와 Postgres를 포함한 infrastructure component는 UTC로 설정해야 해요. non-UTC timezone에서는 query가 잘못되거나 빈 결과를 반환할 수 있거든요.

| 선택지 | 맞는 상황 | 부담 |
| --- | --- | --- |
| Langfuse Cloud | 빠르게 붙여 trace/eval loop를 검증할 때 | 외부 서비스로 데이터가 나간다 |
| Docker Compose self-host | 로컬 실험, 낮은 규모 테스트 | 고가용성·백업·스케일링 없음 |
| Kubernetes/Cloud Terraform | 운영 규모와 보안 요구가 있을 때 | ClickHouse/worker/cache까지 운영해야 한다 |

이 시스템을 개인이나 소규모로 운영한다면 Cloud나 로컬 Docker Compose로 trace 설계를 검증하는 편이 나아요. Slack 메시지, GitHub diff, 업무 로그처럼 민감한 텍스트가 observation input/output에 들어갈 수 있으니 무엇을 저장하지 않을지 먼저 정해야 해요.

Langfuse SDK는 성능을 위해 trace를 동기로 전송하지 않아요. 비동기 batch 전송은 request latency를 줄여주지만, 프로세스가 빨리 종료되면 observation을 잃을 수 있어요. 공식 quickstart에도 short-lived application에서는 shutdown 또는 flush가 필요하다고 나와 있어요. TypeScript quickstart의 종료 처리는 다음 형태예요.

```typescript
import { sdk } from "./instrumentation";
import { startActiveObservation } from "@langfuse/tracing";

async function main() {
  await startActiveObservation("my-first-trace", async (span) => {
    span.update({
      input: "Hello, Langfuse!",
      output: "This is my first trace!",
    });
  });
}

// Shutdown flushes events and is required for short-lived applications
main().finally(() => sdk.shutdown());
```

NestJS HTTP 서버처럼 오래 떠 있는 프로세스라면 종료 hook에서 shutdown을 보장하면 돼요. BullMQ worker, Firebase Function, one-shot CLI job은 job이 끝나자마자 프로세스가 내려가면서 아직 전송하지 못한 observation을 잃을 수 있어요. 이 시스템에서는 autopilot, job-application-nudge-cron, resume-calibration-cron, study-brief-cron 같은 cron/worker성 모듈과 CLI provider 주변을 특히 살펴야 해요. “에이전트가 실패했는데 Langfuse에는 trace가 없다”면 flush가 빠졌을 가능성도 있어요.

## agent-run에서 시작할 적용안

이 시스템에서는 agent-run에서 시작하는 게 좋아요. 이미 모든 에이전트 실행 lifecycle을 감싸고 EvidenceRecord도 기록하니까요. Langfuse trace의 root를 AgentRunService.execute에 두면 기존 실행 이력과 새 observation model을 함께 쓸 수 있어요. root trace metadata 후보는 5개예요.

- agentType
- triggerType
- slackTeamId / slackChannelId
- githubPrOrIssue
- runId

runId는 기존 DB row와 Langfuse trace를 이어주는 키가 돼요. agentType과 triggerType은 observation을 집계할 때 기본 축이 되고, Slack/GitHub 식별자는 운영자가 실제 사용 장면으로 되돌아가는 데 필요해요. metadata 값 제한과 개인정보 노출 위험이 있으니 긴 Slack thread 원문이나 diff 전체를 metadata에 넣으면 안 돼요.

첫 적용 후보는 agent/code-reviewer, agent/work-reviewer, agent/pm이에요. 이들은 LLM 호출 결과의 품질이 중요하고 GitHub/Slack/CLI provider/parser가 함께 움직여요. model-router와 github도 공통 하위 모듈이라 함께 감싸면 여러 agent에서 재사용할 수 있어요. 반면 backtest, market-data, paper-trading처럼 도메인 계산이나 외부 데이터 파이프라인 성격이 강한 모듈에는 일반 OpenTelemetry나 metrics dashboard가 더 직접적일 수 있어요.

AgentRunService.execute를 root로 둔다면 다음에는 observation 이름을 정해야 해요. slack.command.ack, github.pr.get, model-router.route, cli.codex.complete, parser.daily-plan.parse처럼 이름을 안정적으로 유지해야 dashboard와 evaluator가 흔들리지 않아요.

dataset에 올릴 기준도 모듈별로 정해야 해요. agent/code-reviewer는 “실제 diff와 무관한 리뷰”, agent/pm은 “GitHub task 반영 누락”, agent/work-reviewer는 “정량 근거 없는 보고”가 실패 사례 후보예요. 모든 실패 trace를 올리기 전에 이 기준을 정해야 score, dataset, experiment, CI gate를 연결할 수 있어요.

## 참고 문서

- https://langfuse.com/docs/observability/sdk/overview
- https://langfuse.com/integrations/native/opentelemetry
- https://langfuse.com/changelog
- https://langfuse.com/docs/observability/data-model
- https://langfuse.com/docs/observability/features/observation-types
- https://langfuse.com/docs/observability/features/metadata
- https://langfuse.com/docs/evaluation/overview
- https://langfuse.com/docs/evaluation/experiments/datasets
- https://langfuse.com/docs/evaluation/experiments/experiments-ci-cd
- https://langfuse.com/self-hosting
- https://github.com/langfuse/langfuse
