---
title: "Slack 에이전트의 운영 지표에 Semantic Layer를 두는 이유"
description: "Slack 에이전트가 운영 DB의 숫자를 답할 때 Semantic Layer로 질문 범위를 제한하고 지표 정의를 고정하는 방법을 살펴봅니다."
pubDatetime: 2026-11-17T19:45:00+09:00
category: backend
---

Slack에서 “지난주 에이전트 실패율이 왜 올랐어?”라고 물었을 때, 봇이 빠르게 그럴듯한 오답을 내놓는 건 답이 늦는 것보다 위험해요. 같은 DB를 봐도 실패율의 분모를 전체 실행으로 잡을지 재시도 후 최종 실행으로 잡을지, fallback을 성공으로 셀지 실패로 셀지에 따라 숫자가 달라지니까요.

이 글은 공식 문서와 예제를 읽고 개념을 정리한 글이에요. 특정 Semantic Layer 제품을 운영해 본 결과는 아니고, Slack 기반 업무 에이전트와 PostgreSQL·Prisma 구조에 적용한다면 어디까지 쓸 수 있고 어떤 한계가 있는지 살펴봐요.

## 자연어 SQL은 유연하지만 실패 모양이 좋지 않아요

Text-to-SQL을 쓰면 사용자는 SQL을 몰라도 되고 개발자는 질문마다 대시보드를 만들지 않아도 돼요. LangChain의 SQL agent 예제에서는 에이전트가 테이블을 나열하고 스키마를 살핀 뒤 SQL을 만들어요. 실행 전에는 query checker로 검토하고 실행 결과를 설명해요.

문제는 “실행되는 SQL”이 반드시 “맞는 SQL”은 아니라는 거예요. 조인 키가 애매하거나 이벤트 로그처럼 row grain이 복잡할 때, 또는 성공·실패 상태가 여러 컬럼에 나뉘어 있을 때는 SQL이 정상 실행돼도 의미가 틀릴 수 있어요. 특히 Slack에서 “성공률은 92%예요”라는 답을 받으면 사용자가 계산식을 의심하기는 어려워요.

LangChain 예제의 query checker는 NOT IN과 NULL, UNION과 UNION ALL, 배타 범위에 BETWEEN을 쓰는 실수처럼 SQL을 작성할 때 흔히 생기는 오류를 다시 살피게 해요.

```python
@tool
def sql_db_query_checker(query: str) -> str:
    """Use this tool to double check if your query is correct before executing it.
    Always use this tool before executing a query with sql_db_query!"""
    trigger_prompt = """{query}
Double check the sqlite query above for common mistakes, including:
- Using NOT IN with NULL values
- Using UNION when UNION ALL should have been used
- Using BETWEEN for exclusive ranges
- Data type mismatch in predicates
- Properly quoting identifiers
"""
```

Slack 질문을 받아 운영 DB를 조회하는 워커 앞에 둘 만한 안전장치예요. 다만 checker가 줄여주는 건 SQL 문법과 흔한 패턴의 오류이지, “fallback을 성공으로 볼 것인가” 같은 비즈니스 정의까지 대신 정해주지는 못해요.

### 전체 스키마를 넘기는 방식은 질문이 커질수록 흔들려요

LlamaIndex의 Text-to-SQL 예제에서는 `SQLDatabase(engine, include_tables=["city_stats"])`처럼 조회할 테이블을 미리 지정해요. 테이블을 지정하지 않으면 전체 스키마 컨텍스트를 가져올 수 있는데 그 내용이 LLM의 입력 한계를 넘거나 잘못된 테이블을 고르는 원인이 될 수 있다고 설명해요.

```python
from llama_index.core import SQLDatabase
from llama_index.llms.openai import OpenAI

llm = OpenAI(temperature=0.1, model="gpt-4.1-mini")
sql_database = SQLDatabase(engine, include_tables=["city_stats"])
```

도시 이름, 인구, 국가만 담긴 테이블에 “캐나다 도시는?”이라고 묻는 것과 운영 에이전트 DB에 “실패율”을 묻는 것은 달라요. 실행 기록, 증거 로그, 라우팅 실패, 모델 fallback, Slack 이벤트, 작업 보고 초안이 서로 다른 테이블에 있다면 스키마 이름만으로 어느 상태를 집계해야 할지 맞히기 어려워요.

production Slack 명령에는 read-only role, table allowlist, statement timeout, 실행 전 dry-run 로그를 두고 필요하면 승인 단계도 둬야 해요. 운영 DB에 질의하는 일은 답을 만드는 동시에 데이터에 접근하는 일이니까요.

## Semantic Layer는 SQL 작성을 개념 선택으로 바꿔요

Semantic Layer에서는 LLM이 `SELECT ... JOIN ... GROUP BY ...`를 자유롭게 작성하는 대신, 질문에 맞는 metric과 dimension을 고르게 해요. metric은 측정값이고 dimension은 그 값을 쪼개 보는 기준이에요. entity는 조인할 수 있는 대상, relationship은 테이블 사이를 잇는 규칙이에요.

dbt Semantic Layer는 이 구조를 MetricFlow 위에서 설명해요. semantic model은 dbt model에 붙이는 YAML 메타데이터로 정의하고 entity와 dimension은 컬럼 수준에 두며 metric은 측정 가능한 값을 나타내요. 최신 spec에서는 semantic modeling을 켠 model 옆에 `metrics:`를 둬요.

```yaml
models:
  - name: the_name_of_the_model # Model name
    semantic_model:
      enabled: true
      name: the_name_of_the_semantic_model # Optional: semantic model name, defaults to model name
      agg_time_dimension: dimension_name # Required

    columns:
      - name: entity_column_name
        entity:
          type: primary # or foreign
          name: entity_name
          description: entity description

      - name: dimension_column_name
        dimension:
          type: categorical # or time
          name: dimension_name
          description: dimension description

    metrics:
      - name: metric_name
        description: metric description
        type: simple
        label: Metric Label
        agg: sum # Required
        expr: column_name # Optional, defaults to metric name
```

Slack 운영 에이전트라면 먼저 `agent_run_success_rate` 같은 지표를 정의할 수 있어요. 그러면 LLM은 “성공률”이라는 말을 듣고 임의로 로그 테이블을 뒤지는 대신, 정의된 성공률 metric과 `day`, `agent_type`, `provider`처럼 허용된 dimension을 골라요. SQL은 결정론적인 query engine이 만들어요.

### 커버되지 않은 질문은 오류로 남겨요

dbt의 2026 benchmark 글에서는 Text-to-SQL과 Semantic Layer의 실패 방식이 다르다고 봐요. Text-to-SQL은 그럴듯한 오답을 낼 수 있지만 Semantic Layer는 다루지 않는 질문에 명시적으로 실패해요. Slack 답변에 필요한 건 모든 질문에 곧바로 답하는 능력보다 믿고 공유할 수 있는 숫자예요.

Semantic Layer에서도 LLM이 metric을 잘못 고르면 결과가 틀릴 수 있어요. 다만 조인 경로와 집계 방식, 시간 기준은 모델링한 정의 안에 들어가요. 운영 기능에서는 “틀린 SQL을 실행했다”보다 “정의되지 않은 지표라 답하지 않았다”가 더 나은 실패예요.

| 선택지 | 얻는 것 | 내주는 것 | 어울리는 상황 |
| --- | --- | --- | --- |
| Text-to-SQL | 넓은 질문 범위, 빠른 탐색 | 조인·집계 오답 가능성 | 개발자용 ad hoc 분석 |
| Semantic Layer | 일관된 지표, 명시적 실패 | 사전 모델링 비용, 낮은 커버리지 | Slack 명령·운영 리포트 |
| 고정 SQL 템플릿 | 가장 예측 가능함 | 질문 유연성 거의 없음 | 핵심 KPI 몇 개만 제공 |

업무 보고나 운영 품질 분석에 쓸 숫자라면 어떤 질문에는 답하지 않을지 정하고 계산 정의를 고정하는 편이 나아요.

## 제품들은 의미 계층을 API 경계로 올리고 있어요

Snowflake Cortex Analyst는 자연어로 질문을 받지만 요청에는 semantic model file, inline semantic model, semantic view, 또는 여러 semantic source 중 하나를 넣어야 해요. 질문을 어느 의미 계층에서 해석할지도 함께 넘기는 구조예요.

```plain text
POST /api/v2/cortex/analyst/message
Content-Type: application/json

{
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "which company had the most revenue?"
        }
      ]
    }
  ],
  "semantic_model_file": "@my_db.my_schema.my_stage/my_semantic_model.yaml"
}
```

Slack 메시지는 자연어여도 백엔드에서는 어떤 의미 모델로 해석할지 명시해야 해요. 운영 지표 질문에는 운영 semantic catalog를, 업무 로그 질문에는 업무 로그 semantic catalog를 쓰는 식이에요. 사용자가 catalog 이름을 고를 필요는 없지만 시스템 내부의 라우터는 질문을 알맞은 경계로 보내야 해요.

Snowflake 문서에 따르면 Semantic View에는 logical table, dimension, fact, metric, relationship을 담을 수 있고 synonym, description, verified example, custom instruction 같은 메타데이터로 정확도를 높여요. 권한은 Snowflake RBAC와 연결돼요. PostgreSQL·Prisma 환경에서 이 구조를 그대로 복제할 필요는 없지만 의미 정의와 권한 집행을 함께 설계하는 방향은 가져올 수 있어요.

Semantic Layer를 붙인다고 DB 보안까지 자동으로 해결되지는 않아요. 임의 SQL을 실행할 위험이 남을 수 있으니 read-only 권한, 허용 테이블, timeout, 감사 로그는 따로 필요해요.

## 내 시스템에 맞는 곳과 아직 먼 곳

Slack 기반 업무 에이전트라면 실행 기록을 근거로 운영 상태를 알려주는 기능에 먼저 적용할 만해요. 모든 에이전트 실행의 시작·종료·성공·실패와 실행마다 남긴 증거가 있다면 성공률, fallback 비율, CLI 지연 시간을 지표로 만들 수 있어요. 질문 범위가 좁고 운영 판단에 자주 쓰이니 계산 정의를 고정할 가치가 있어요.

PR 리뷰를 만들거나 자연어로 일정을 등록하는 기능은 DB의 숫자를 집계하기보다 외부 입력을 읽고 문서나 판단을 만드는 일이 중심이에요. 업무 로그 초안은 그 중간에 있어요. 저장된 실행 기록과 GitHub 작업, 전날 계획을 바탕으로 주간 보고 초안을 만들면서 “이번 주 완료율”이나 “리뷰 반영 대기 건수”를 넣는다면 Semantic Layer가 도움이 돼요. 숫자는 Semantic Layer에서 가져오고, 서술 품질과 문장 톤, 회고 요약은 LLM이 맡을 수 있어요.

### 처음 정의할 지표는 세 개면 충분해요

첫째는 에이전트 실행 성공률이에요. 특정 기간의 전체 실행을 분모로, 최종 상태가 성공인 실행을 분자로 둘 수 있어요. 재시도를 별도 실행으로 셀지 원 실행에 묶을지는 정의해야 해요.

둘째는 모델 fallback 비율이에요. 기본 모델 호출이 실패해 보조 모델로 넘어간 실행의 비율이라, 모델 품질보다는 운영 안정성을 보는 지표에 가까워요. schema가 강제된 요청처럼 fallback을 일부러 금지한 케이스를 분모에서 뺄지도 정해야 해요.

셋째는 CLI 평균 지연 시간이에요. 시작 시각과 종료 시각의 차이를 평균내는데 timeout 실패를 포함하느냐에 따라 값이 크게 달라질 수 있어요. dimension은 `agent kind`, `model provider`, `day` 정도로 제한하고 filter도 기간과 에이전트 종류 위주로 좁히는 편이 안전해요.

```typescript
type MetricDefinition = {
  name: string;
  description: string;
  dimensions: string[];
  allowedFilters: string[];
};

const operationalMetrics: MetricDefinition[] = [
  {
    name: "agent_run_success_rate",
    description: "선택한 기간의 에이전트 실행 중 최종 상태가 성공인 비율",
    dimensions: ["day", "agent_kind", "trigger_type"],
    allowedFilters: ["started_at", "agent_kind", "trigger_type"],
  },
  {
    name: "fallback_rate",
    description: "기본 모델 호출 후 보조 모델로 넘어간 실행의 비율",
    dimensions: ["day", "agent_kind", "primary_provider"],
    allowedFilters: ["started_at", "agent_kind", "primary_provider"],
  },
  {
    name: "average_cli_latency",
    description: "CLI 호출 시작부터 종료까지 걸린 평균 시간",
    dimensions: ["day", "agent_kind", "provider"],
    allowedFilters: ["started_at", "agent_kind", "provider"],
  },
];
```

위 코드는 특정 공식 문서의 예제가 아니라 필요한 catalog의 모양을 TypeScript로 적어본 설계 스케치예요. 공식 예제에서 metric·dimension·filter 개념을 가져왔지만 실제 Prisma schema와 맞는지는 따로 확인해야 해요.

## 아직 쓰지 말아야 할 조건과 다음 확인 작업

Semantic Layer는 질문이 반복되고 계산 정의를 합의할 수 있을 때 유용해요. “어제 새로 생긴 테이블을 한번 훑어보자”거나 “장애 원인을 찾으려고 임시 조인을 여러 번 바꿔보자” 같은 상황에서는 Text-to-SQL이 더 빠를 수 있어요. 그럴 때는 production Slack 명령과 분리된 개발자용 탐색 도구가 맞아요.

metric 이름을 정하고 entity를 고르고 dimension을 제한하고 예시 질문을 붙이는 데도 모델링 비용이 들어요. 운영 대시보드나 반복되는 질문, 숫자를 믿고 내려야 하는 의사결정이 없다면 아직 이 레이어를 만들 이유는 약해요.

다음에는 현재 운영 DB에 세 지표를 계산할 컬럼이 있는지 확인해야 해요. 성공·실패 상태와 fallback 여부, CLI 시작·종료 시각이 같은 grain으로 남아 있지 않다면 로그 구조부터 정리해야 해요.

그다음에는 Slack 답변에 숫자를 내보내기 전에 정의된 metric만 허용하는 dry-run을 만들 수 있어요. 질문이 catalog 밖에 있다면 SQL을 만들지 않고 어떤 지표가 없어서 답하지 못했는지 알려주는 방식이에요.

## 출처

- https://docs.getdbt.com/blog/semantic-layer-vs-text-to-sql-2026
- https://docs.getdbt.com/docs/build/semantic-models
- https://docs.getdbt.com/reference/metric-properties
- https://docs.langchain.com/oss/python/langchain/sql-agent
- https://developers.llamaindex.ai/python/examples/index_structs/struct_indices/sqlindexdemo
- https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-analyst
- https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-analyst/rest-api
