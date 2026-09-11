---
title: "CORS처럼 보인 구매확정 500의 실제 원인과 복구"
description: "CORS 문제처럼 보였던 구매확정 500을 추적해 운영 DDL과 레거시 PHP 코드의 스키마 계약 불일치를 찾아 복구한 과정이다."
pubDatetime: 2026-09-10T19:10:00+09:00
category: backend
---

운영 관리 페이지에서 구매확정을 요청할 때 발생한 500은 브라우저에서 CORS 문제처럼 보였어요. 하지만 HTTP 접근 로그와 PHP 예외를 함께 추적해 보니 실제 원인은 운영 DDL과 레거시 PHP 코드의 스키마 계약이 맞지 않았던 데 있었어요.

## 문제: 브라우저는 CORS를 가리켰지만 서버는 500을 반환하고 있었다

운영 관리 페이지에서 구매확정을 누르자 “구매확정에 실패했습니다”라는 메시지가 나타났고 구매 단계 표시도 갱신되지 않았어요.

브라우저 콘솔만 봤을 때는 CORS 문제처럼 보였어요. 같은 시각의 HTTP 접근 로그를 따로 살펴보니 상황이 달랐어요.

```text
OPTIONS /api/staff/purchases/confirmation 200
POST    /api/staff/purchases/confirmation 500
```

preflight 요청인 `OPTIONS`는 통과했지만 실제 구매확정을 처리하는 `POST`에서 500이 발생했어요.

`OPTIONS 200`만으로 모든 CORS 설정이 정상이라고 단정할 수는 없어요. 이 경우에는 같은 시각에 발생한 `POST 500`과 PHP 예외가 더 직접적인 근거였고, 진단의 초점도 브라우저 표시가 아니라 서버의 구매확정 처리 경로로 옮겼어요.

PHP 로그에는 이런 예외가 남아 있었어요.

```text
RuntimeException: resolveNativeOrganizationOwnerKey: native organization UUID 확보 실패
(legacyOrganizationKey=<legacy-organization-key>, table=organization_migration_data)
```

호출 흐름은 다음과 같았어요.

```text
PurchaseConfirmationController
→ PurchaseLedgerService::appendPurchase()
→ PurchaseLedgerRepository::insertEntry()
→ OrganizationMappingHelper::resolveNativeOrganizationOwnerKey()
```

구매확정 과정에서 외부 전송 주문을 확정하는 단계는 구매 내역을 ledger에 반영해요. 이때 `legacy:{id}` 형태의 레거시 조직 계정을 `organizations/{native organization UUID}` 형태의 소유자 참조 키로 바꿔요.

문제는 이 변환을 맡은 조직 매핑 헬퍼에서 발생했어요. 구매 단계 이력에 기록돼야 할 외부 전송 주문 확정 단계도 운영 DDL이 변경된 7월 31일 이후에는 생성되지 않았어요.

## 근본 원인: 데이터가 아니라 스키마 계약이 바뀌었다

2026년 7월 31일 운영 DDL에서는 다음 역할을 하는 테이블들의 외부 provider 정보를 별도 연결 테이블로 정규화했어요.

```text
message_organization_migration_data
content_organization_migration_data
```

기존 `provider_type`, `external_organization_key` 컬럼을 제거하고 다음 역할을 맡는 테이블로 옮겼어요.

```text
message_organization_provider_connection
content_organization_provider_connection
```

하지만 레거시 PHP 코드는 여전히 조직 정보 테이블을 직접 조회하고 있었어요.

```sql
SELECT organization_key
FROM content_organization_migration_data
WHERE provider_type = 'external_provider'
AND external_organization_key = ?
```

컬럼을 제거한 뒤부터 이 쿼리는 MySQL의 `Unknown column` 오류로 실패했어요.

해당 코드의 PHP PDO 설정도 영향을 미쳤어요. PDO가 `ERRMODE_WARNING`을 사용하고 있어 쿼리 실패가 언제나 예외로 바뀌지는 않았거든요. `execute()`나 `fetchColumn()`이 실패해도 `false`로 넘어갔고, 문제는 마지막 UUID 검증 단계에서야 `RuntimeException`으로 드러났어요.

로그에 나타난 “native organization UUID 확보 실패”는 UUID 생성 자체의 문제가 아니었어요. 이미 제거된 컬럼을 계속 조회해서 생긴 schema compatibility 문제였어요.

## provider 조회의 기준을 연결 테이블로 전환했다

관련 변경에서는 조직 매핑을 담당하는 PHP 파일 하나만 수정했어요. 조직 정보와 provider 연결 정보를 다시 분리한 것이 핵심이에요.

기존에는 다음 관계를 한 테이블에서 처리했어요.

```text
content_organization_migration_data
├─ organization_key
├─ organization_name
├─ provider_type
└─ external_organization_key
```

변경한 뒤에는 현재 스키마에 맞춰 두 테이블을 나눠 사용해요.

```text
content_organization_migration_data
└─ 조직 자체 정보
content_organization_provider_connection
└─ provider와 외부 조직 식별자의 연결 정보
```

기존 조직을 찾을 때는 연결 테이블에서 조직 식별자를 조회해요.

```sql
SELECT organization_key
FROM content_organization_provider_connection
WHERE provider_type = 'external_provider'
AND external_organization_key IN (?, ?)
AND deleted_timestamp IS NULL
ORDER BY LENGTH(external_organization_key) DESC
LIMIT 1
```

조회 후보에는 다음 두 형식을 함께 넣었어요.

```text
0:{legacyOrganizationKey}  # shard prefix가 포함된 새 형식
{legacyOrganizationKey}    # 기존 bare 형식
```

두 형식이 모두 있으면 `ORDER BY LENGTH(external_organization_key) DESC`로 새 형식을 우선해요. 스키마 변경과 함께 식별자 형식이 달라졌더라도 기존 데이터를 곧바로 배제하지 않기 위한 호환 처리예요.

연결 정보를 찾지 못하면 먼저 MySQL의 `UUID()`로 native organization ID를 확보해요. 그다음 조직 정보 테이블에는 조직 자체 정보만 저장해요.

```sql
INSERT IGNORE INTO content_organization_migration_data
(organization_key, organization_name, created_timestamp, updated_timestamp)
VALUES
(?, ?, NOW(3), NOW(3))
```

provider 정보는 연결 테이블에 따로 기록해요.

```sql
INSERT IGNORE INTO content_organization_provider_connection
(connection_key, organization_key, provider_type, external_organization_key, created_timestamp, updated_timestamp)
VALUES
(UUID(), ?, 'external_provider', ?, NOW(3), NOW(3))
```

제거된 컬럼을 되살리거나 임시로 우회하는 대신 변경된 데이터 모델에 맞춰 조회와 삽입의 책임을 분리했어요.

## 동시 요청과 조용한 쿼리 실패도 함께 고려했다

조직 생성은 여러 요청에서 동시에 실행될 수 있어요. 수정한 코드에서도 `INSERT IGNORE` 후 연결 정보를 다시 조회하는 기존 멱등 패턴을 유지했어요.

재조회에는 `LOCK IN SHARE MODE`를 사용했어요.

```sql
SELECT organization_key
FROM content_organization_provider_connection
...
LIMIT 1
LOCK IN SHARE MODE
```

다른 트랜잭션이 같은 provider 연결을 먼저 생성했을 때 현재 트랜잭션의 오래된 `REPEATABLE READ` 스냅샷이 아니라 최신 커밋 결과를 읽기 위한 처리예요. 첫 조회에는 잠금을 걸지 않았어요. 아직 행이 없는 구간에 불필요한 gap lock이 생기는 일을 피하기 위해서예요.

재조회가 실패했을 때 방금 생성한 `$nativeOrganizationKey`를 그대로 반환하지도 않았어요. `ERRMODE_WARNING` 환경에서는 실제 쿼리 실패가 조용히 넘어갈 수 있거든요. 검증하지 않은 ID로 처리를 이어가면 존재하지 않는 조직을 가리키는 소유자 참조 키가 ledger에 기록될 수 있어요.

최종 조직 식별자를 확인하지 못하면 기존과 마찬가지로 명시적으로 실패하도록 했어요.

## 운영 스키마와 구매확정 경로의 계약을 다시 맞췄다

수정 범위는 조직 매핑을 담당하는 PHP 파일 하나였고, 수십 줄을 추가하는 한편 기존 로직 일부를 삭제했어요.

이번 변경으로 다음 동작을 현재 스키마에 맞게 정리했어요.

- 제거된 조직 정보 테이블의 provider 컬럼을 더 이상 조회하지 않는다.
- provider 연결은 정규화된 조직-provider 연결 테이블에서 관리한다.
- 새 형식과 기존 형식의 외부 조직 식별자를 모두 조회한다.
- 신규 조직과 provider connection을 짝으로 생성한다.
- 동시 생성 이후에는 최신 연결 행을 다시 확인한다.
- 조회 실패 시 검증되지 않은 UUID가 ledger로 흘러가지 않게 한다.

이 변경은 2026년 8월 3일 기본 브랜치에 병합됐어요. 브라우저에서는 CORS처럼 보였지만 구매확정 장애의 실제 원인은 운영 DDL과 레거시 PHP 코드 사이의 스키마 계약 불일치였어요. 변경 사항은 500을 일으키던 서버 경로가 현재 스키마에 맞게 다시 동작하도록 복구했어요.

이번 사례에서 중요한 점은 브라우저에 표시된 오류 이름을 그대로 원인으로 받아들이지 않았다는 거예요. `OPTIONS`, 실제 `POST`, 같은 시각의 애플리케이션 예외를 따로 확인하고 호출 경로를 따라가니 프론트엔드 증상 뒤에 가려져 있던 schema compatibility 문제가 드러났어요.
