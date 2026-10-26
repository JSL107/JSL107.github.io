---
title: "Slack 에이전트의 기억 계층으로 Graphiti 검토하기"
description: "Graphiti의 시간 기반 사실 모델을 Slack 에이전트 기억에 적용할 수 있는지 살펴보고, 작은 실험에서 확인할 설계와 운영 조건을 정리한다."
pubDatetime: 2026-10-26T19:45:00+09:00
category: backend
---

Slack 에이전트가 오래된 사실과 새 사실을 함께 다뤄야 한다면, Graphiti가 기억 계층의 후보가 될 수 있을까요? 이 글은 운영 후기가 아니에요. 공식 README와 문서, Quick Start 예제, Zep의 소개 글과 temporal knowledge graph 논문을 읽고 도입 전에 확인할 설계를 정리한 조사 글이에요.

## 프롬프트에 쌓인 기억은 충돌할 수 있다

Slack에서 일하는 에이전트는 사용자가 오늘 할 일을 물으면 GitHub 할 일 목록을 읽고 전날 계획과 최근 실행 근거를 더해 모델에 넘길 수 있어요. PR 리뷰를 만들 때도 diff, 기존 코멘트, 재시도 이력, 사용자의 선호를 한 번에 넣으면 그럴듯한 답이 나와요.

문제는 이런 방식이 오래 버티기 어렵다는 거예요. “이 이슈는 오늘 처리한다”는 문장은 내일이면 사실이 아닐 수 있고, “이 사용자는 짧은 답변을 좋아한다”는 선호도 상황에 따라 달라질 수 있어요. 오래된 사실을 요약에 덮어쓰거나 더 긴 프롬프트에 계속 쌓으면, 기억이 답변의 근거가 되면서 동시에 충돌을 일으켜요.

## Graphiti는 사실이 유효했던 시간을 남긴다

Graphiti는 대화, 업무 이벤트, 문서를 temporal Context Graph로 바꿔요. 일반적인 RAG가 문서를 chunk로 나눠 임베딩한 뒤 비슷한 조각을 찾는다면, Graphiti는 원본 입력을 episode로 저장하고 거기서 entity와 relationship, 즉 fact를 뽑아 그래프에 넣어요. fact가 “언제 참이었는가”도 함께 다루고요.

사용자가 한 팀에서 다른 팀으로 옮겼다고 해볼게요. 요약 메모리에는 “현재 소속”만 남을 수도 있고, 과거 문장과 현재 문장이 검색 결과에 함께 나올 수도 있어요. Graphiti의 모델에서는 오래된 관계를 삭제하는 대신 invalid 처리할 수 있어요. 현재 상태를 물으면 지금 유효한 관계를, 특정 시점의 상태를 물으면 그때 유효했던 관계를 찾는 식이에요.

공식 설명에서 기본 단위는 원본 입력인 episode, 사람·조직·이슈 같은 entity, entity 사이의 fact 또는 relationship이에요. episode는 사실의 출처를 추적할 수 있도록 원자료로 남고, Slack 메시지나 JSON 이벤트에서 뽑아낸 fact도 해당 episode와 연결돼요.

### 기록된 시간과 유효했던 시간

Graphiti가 다루는 시간은 created_at 하나로 끝나지 않아요. Zep의 기술 글에 따르면 edge에는 created_at, expired_at, valid_at, invalid_at이 있어요. 앞의 둘은 Graphiti 데이터베이스가 관계를 언제 알게 됐고 언제 만료 처리했는지를, 뒤의 둘은 현실 세계에서 그 관계가 언제부터 언제까지 참이었는지를 나타내요.

“어제는 A를 하기로 했다”는 사실을 오늘 읽었다고 해서 실제 기준 시점이 오늘로 바뀌지는 않아요. 업무 로그, 일일 계획, GitHub 이슈 상태, PR 리뷰 답변은 기록한 시점과 그 내용이 가리키는 시점이 다를 수 있어요. Graphiti는 episode의 reference_time을 받아 상대적인 시간 표현을 해석하는 데 써요. 사실의 생애주기를 남기면 비용은 더 들지만, 나중에 판단 근거를 되짚어 볼 여지가 생겨요.

## Slack 시스템에 연결하는 경계

공식 Quick Start에 따르면 graphiti-core는 Python 3.10 이상이 필요해요. 그래프 저장소로는 Neo4j 5.26 이상 또는 FalkorDB 1.1.2 이상을 써요. 기본 LLM과 embedding provider는 OpenAI이고, 문서에는 Azure OpenAI, Gemini, Anthropic, Groq, Ollama도 나와요.

설치 명령은 간단해요.

```bash
pip install graphiti-core
# 또는
uv add graphiti-core
```

하지만 TypeScript·NestJS 백엔드에서는 npm 패키지 하나를 추가하는 것으로 끝나지 않아요. Python sidecar나 내부 HTTP 서비스로 경계를 잡는 편이 자연스러워요. Slack 이벤트를 받는 서버는 그대로 두고, 기억을 수집하고 검색하는 별도 worker가 Graphiti와 Neo4j 또는 FalkorDB를 연결하는 구성을 생각할 수 있어요.

Quick Start 예제에서는 환경변수에서 Neo4j 연결 정보를 읽어 Graphiti 객체를 만든 다음, 인덱스와 제약 조건을 한 번 구성해요.

```python
graphiti = Graphiti(neo4j_uri, neo4j_user, neo4j_password)

try:
    # Initialize the graph database with graphiti's indices. This only needs to be done once.
    await graphiti.build_indices_and_constraints()

    # Additional code will go here

finally:
    # Close the connection
    await graphiti.close()
    print('\nConnection closed')
```

Slack 시스템에 적용한다면 앱의 매 요청 처리보다는 기억 sidecar의 bootstrap에 해당해요. 인덱스 생성은 매 요청마다 돌리지 않고, DB 연결은 worker lifecycle에 맞춰 종료해야 해요.

### episode에 담을 입력

정보를 넣는 기본 API는 add_episode예요. episode는 text, message, json을 지원하므로 대화형 입력에는 message, 구조화된 업무 이벤트에는 json이 맞아요. 공식 문서의 message 예시는 다음과 같아요.

```python
await graphiti.add_episode(
    name="Customer_Support_Interaction_1",
    episode_body=(
        "Customer: Hi, I'm having trouble with my Allbirds shoes. "
        "The sole is coming off after only 2 months of use.\n"
        "Support: I'm sorry to hear that. Can you please provide your order number?"
    ),
    source=EpisodeType.message,
    source_description="Customer support chat",
    reference_time=datetime(2024, 3, 15, 14, 45),
)
```

예시에 나온 고객지원 대화는 Slack에서는 사용자가 명령이나 자연어 멘션으로 보낸 요청 원문에 대응해요. 오늘 할 일 정리, PR 리뷰, 업무 로그 초안 요청이 episode가 될 수 있어요. 공개 글에서는 실제 회사명, 사용자명, 업무 데이터 대신 episode 경계만 다뤄요.

구조화된 JSON도 넣을 수 있어요. 공식 문서에서는 상품 데이터를 예로 들지만, Slack 에이전트에 더 가까운 사례는 GitHub 할 일 스냅샷이나 실행 근거 레코드예요.

```python
import json

product_data = {
    "id": "PROD001",
    "name": "Men's SuperLight Wool Runners",
    "color": "Dark Grey",
    "sole_color": "Medium Grey",
    "material": "Wool",
    "technology": "SuperLight Foam",
    "price": 125.00,
    "in_stock": True,
    "last_updated": "2024-03-15T10:30:00Z"
}

await graphiti.add_episode(
    name="Product Update - PROD001",
    episode_body=json.dumps(product_data),
    source=EpisodeType.json,
    source_description="Allbirds product catalog update",
    reference_time=datetime.now(),
)
```

이 시스템에서는 “할 일 후보 목록”, “에이전트 실행 결과”, “PR 리뷰에서 사용한 diff 요약”이 입력이 돼요. JSON 문서는 LLM context window 안에 들어갈 만큼 작아야 해서, 큰 데이터 덤프를 한 episode에 몰아넣는 방식은 적합하지 않아요.

## 검색 범위는 group_id와 함께 정해야 한다

Graphiti는 검색할 때 vector search만 쓰지 않아요. 공식 소개에 따르면 semantic search, full-text 또는 BM25, graph traversal을 섞어 ranked retrieval을 만들어요. Quick Start의 graphiti.search(query)는 관계 edge를 대상으로 semantic similarity와 BM25 검색을 조합해요.

```python
results = await graphiti.search('Who was the California Attorney General?')

for result in results:
    print(f'UUID: {result.uuid}')
    print(f'Fact: {result.fact}')
    if hasattr(result, 'valid_at') and result.valid_at:
        print(f'Valid from: {result.valid_at}')
    if hasattr(result, 'invalid_at') and result.invalid_at:
        print(f'Valid until: {result.invalid_at}')
    print('---')
```

Slack 에이전트는 검색 결과를 프롬프트에 넣을 근거로 쓸 수 있어요. 오늘 할 일 정리에서는 현재 할 일 후보에 가까운 fact를, 업무 로그에서는 최근 실행 근거와 완료된 작업을, PR 리뷰에서는 해당 PR과 관련된 과거 리뷰 선호나 반복 지적을 찾는 식이에요. center node 기반 reranking으로 특정 node와의 graph distance에 따라 결과를 다시 정렬할 수도 있어요. 같은 “리뷰 스타일”이라도 특정 사용자의 최근 선호와 가까운 fact를 앞세울 때 쓸 수 있죠.

Graphiti MCP 서버 README는 group_id filtering으로 관련 데이터를 조직화하는 기능을 소개해요. 모든 데이터를 같은 그래프에 섞으면 권한과 맥락이 흐려질 수 있고, 너무 잘게 나누면 필요한 과거 근거를 찾지 못해요.

경계 후보는 사용자, Slack 채널 또는 스레드, 업무 주제예요. 개인 선호와 이력서·포트폴리오 관련 기억은 사용자 단위로, 특정 스레드의 의사결정은 스레드 단위로 묶는 게 자연스러워요. GitHub 이슈나 PR의 실행 근거에는 작업 단위 group이 맞을 수 있어요. group 경계가 검색 가능 범위와 개인정보 노출 범위를 함께 결정하므로, 첫 실험에 넣을 episode 종류를 고를 때 같이 정해야 해요.

## 적용할 곳과 원천 데이터를 남길 곳

Graphiti가 가장 잘 맞아 보이는 곳은 Slack 요청과 실행 결과를 쌓아 두었다가 비슷한 요청이 오면 과거 근거를 찾는 장기 기억 저장소예요. 요약이나 유사도 검색에 치우친 기억에서 “그때는 맞았지만 지금은 아닌 사실”을 분리하는 후보가 돼요.

비슷한 episode 쌍의 의미 충돌을 판정하는 기능과도 연결돼요. 예전 선호와 새 선호가 충돌하면 둘 중 하나를 삭제하는 대신 validity window를 조정하는 식이에요. 그날 할 일 정리, 업무 로그나 주간보고 초안, PR 리뷰에서도 필요한 근거만 꺼내는 데 검색 결과를 활용할 수 있어요.

휴가 잔여일처럼 계산 규칙이 명확하고 결정론적으로 답해야 하는 기능에는 Graphiti가 과해요. 주식 가격, 백테스트 결과, 시장 데이터처럼 숫자의 정합성이 중요한 영역에서는 원천 DB와 계산 코드가 우선이에요. 외부 문서 크롤러의 결과를 Graphiti에 넣을 수는 있지만, 크롤러 자체를 대체할 이유는 약해요.

## 수집 비용과 운영 책임

Graphiti의 비용은 수집 단계에서 먼저 드러나요. episode에서 entity와 relationship을 추출하고 중복과 시간 정보를 확인하는 과정에 LLM 호출이 들어가요. 공식 Quick Start도 concurrency와 rate limit을 별도로 다뤄요. 기본 SEMAPHORE_LIMIT은 10이고, 429가 나면 낮춰야 해요.

Slack 요청 경로에서 ingestion을 동기 처리하면 응답이 늦어질 수 있어요. 즉시 답해야 하는 요청에서는 필요한 기억만 검색하고, 새 episode 수집은 queue로 넘기는 비동기 설계가 필요해요.

Graphiti는 오픈소스 엔진이고 Zep은 관리형 context infrastructure에 가까워요. 사용자·스레드 관리, 운영 대시보드, API 로그, SLA, 대규모 그래프 운영이 OSS Graphiti만으로 자동 해결되지는 않아요. NestJS 서버와 내부 운영 화면에 직접 붙일 수 있다면 운영 책임도 직접 맡게 돼요.

LLM 설정 문서는 structured output을 잘 지원하는 서비스가 Graphiti에 유리하다고 설명해요. 작은 로컬 모델이나 구조화 출력이 약한 provider를 쓰면 JSON/schema 오류, episode ingestion 실패, 낮은 그래프 품질로 이어질 수 있어요. 추출이 안정적인지 확인해야 하는 이유예요.

## 작은 실험에서 확인할 것

첫 실험에는 Slack 사용자 요청 원문, 에이전트 실행 근거, GitHub 할 일 스냅샷, 이 세 종류의 episode가 적합해 보여요. 이 입력으로 message와 JSON episode를 모두 시험할 수 있어요. 개인화 기억까지 처음부터 섞으면 group 경계와 삭제 정책을 판단하기 어려워질 수 있어요.

오늘 할 일 정리, 업무 로그 초안, PR 리뷰 중 하나를 골라 기존 prompt 구성과 Graphiti 검색 context 구성을 같은 조건에서 비교해야 해요. 토큰 수와 근거 누락, 오래된 사실의 충돌이 실제로 줄어드는지 확인할 수 있어요. 그 결과를 바탕으로 Python sidecar, graph DB, LLM 비용, group 경계, 비동기 ingestion을 검토한 뒤 기억 계층의 도입 범위를 판단할 수 있어요.

## 참고한 출처

- https://github.com/getzep/graphiti
- https://www.getzep.com/platform/graphiti
- https://help.getzep.com/graphiti/
- https://help.getzep.com/graphiti/getting-started/quick-start
- https://help.getzep.com/graphiti/core-concepts/adding-episodes
- https://help.getzep.com/graphiti/working-with-data/searching
- https://help.getzep.com/graphiti/configuration/llm-configuration
- https://github.com/getzep/graphiti/blob/main/mcp_server/README.md
- https://blog.getzep.com/beyond-static-knowledge-graphs
- https://arxiv.org/html/2501.13956v1
