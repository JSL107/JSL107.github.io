# Loop Engineering 로컬 재현 예제

이 예제는 개인 시스템의 실행 성과를 재현하지 않아요. 추가 패키지와 네트워크 없이 한 프로세스의 메모리 저장소로 조건부 갱신, lease fencing, 상태 전이, 외부효과 경계를 확인하는 최소 계약이에요. 저장소에 함께 둔 로컬 재현 예제이므로 운영 데이터베이스나 실제 provider의 동작을 대신하지 않아요.

검증 범위는 다음과 같아요.

- `(taskId, eventId, action)` 조합을 한 `StateStore`에서 한 번만 선점하고, `version`과 `transitionHistory`를 갱신해요. 여러 프로세스의 원자성이나 데이터베이스 unique 제약은 포함하지 않아요.
- `plan → build → verify → review → completed` 경로, 실패 재진입, `maxAttempts=3`, timeout 만료, lease 재발급과 stale worker 차단을 확인해요.
- 검증 입력은 fixture 함수 배열이나 `{ fixtures, expectedOverallExitCode }` 형태의 시나리오 객체예요. 이 예제의 시나리오 객체에는 `makeFixture()`가 만든 함수가 들어가고, 각 fixture에는 `fixtureId`와 `name`, `expectedExitCode`가 붙어요. 실행 결과에도 `fixtureId`, `name`, `exitCode`, `stdout`, `stderr`를 그대로 기록해요. `runVerification()`은 함수 내부에서 각 fixture의 `expectedExitCode`, 입력 fixture와 반환 결과의 `fixtureId` 일치 여부, 시나리오의 `expectedOverallExitCode`를 실제 실행 결과와 비교해요. 기대값이 틀리면 검증 기록이나 상태 전이를 남기지 않고 `runVerification()` 자체가 실패해요. 결과의 fixture ID는 `state.verification.fixtureIds`와 `verification_recorded` 이력에도 같은 순서로 남아요.
- 승인 단계에서는 `{ actor, approvedAt, evidence }` 메타데이터의 존재만 확인해요. 인증·권한·자기승인 방지는 구현하지 않아요. 승인 전 외부효과 차단, provider reject, 확인된 결과 재사용, 결과 저장 실패의 `manual_review` 전이를 확인해요.
- `StateStore.snapshot()`을 새 인스턴스에 전달하는 메모리 상태 복원을 확인해요. 파일·데이터베이스 영속화와 프로세스 장애 뒤 자동 복구는 구현하지 않아요.

## 실행 조건

- Node.js 22 이상
- 실행 디렉터리: 저장소 루트 `/Users/juneseok/repos/JSL107.github.io`
- 외부 provider, 인증, 네트워크, 추가 패키지 불필요

```bash
cd /Users/juneseok/repos/JSL107.github.io
node --test examples/loop-engineering-reference-harness/contract.test.js
```

테스트 파일에는 17개 계약 테스트가 있어요. 이번 실행 결과는 17개 통과, `node --test` 테스트 프로세스 종료 코드 `0`이에요. 이 프로세스 종료 코드는 계약 테스트 전체의 성공 여부이고, fixture 결과를 모아 기록하는 내부 `overallExitCode`와는 달라요. 실패 fixture 시나리오의 내부 `expectedOverallExitCode`는 `1`, 성공 fixture 시나리오는 `0`이며, 실패 시나리오를 검증하는 테스트까지 통과했기 때문에 전체 테스트 프로세스는 `0`으로 끝나요. 실행 기록에는 고정된 Node.js 버전 대신 실행 환경의 `node --version`을 함께 적어요. 잘못된 전체·개별 기대값이나 fixture ID 불일치를 전달했을 때 `runVerification()`이 실패하고 상태를 건드리지 않는 회귀도 포함해요.

`timeoutAt`과 `leaseUntil`은 재현성을 위해 숫자로 된 논리 시각을 사용해요. 검증 실행에 진입할 때 `now >= timeoutAt`이면 fixture를 실행하지 않고 `expired`로 전이해요. `approveRetry()`는 유효 lease를 재사용하고, 만료 lease를 전달한 경우에만 새 소유자와 fencing token으로 교체해요. 두 분기는 각각 테스트에서 실제로 호출해 구분해요.

`transition(input, "completed", ...)` 직접 호출은 거부돼요. 검증 성공과 검토 근거를 확인하는 `completeReview()`만 `completed`를 기록해요. 외부효과는 승인 뒤 `claimed`로 선점하고, provider 호출 직전 주입된 현재 시각을 `calledAt`으로 기록하며 호출과 결과 저장 순서를 이력에 남겨요. provider가 거부하면 실제 호출 시각과 함께 `failed`로 남기고, 결과 저장이 실패하면 호출 결과의 저장 여부를 알 수 없으므로 `calledAt: null`인 `claimed` 상태로 보존한 뒤 재호출하지 않고 `manual_review`로 남겨요.

## 결과 기록

실행 결과를 남길 때는 저장소 루트에서 다음처럼 기록 파일을 만들 수 있어요. 이 파일은 예제에 포함되지 않는 실행 산출물이에요.

```bash
mkdir -p artifacts/loop-engineering-reference-harness
node --test examples/loop-engineering-reference-harness/contract.test.js \
  2>&1 | tee artifacts/loop-engineering-reference-harness/node-test.log
```

기록에는 `node --version`, 실행 디렉터리, 명령, 시작·종료 시각, 테스트 프로세스 종료 코드, fixture별 `exitCode`·`stdout`·`stderr`, 내부 `overallExitCode`, 상태와 이력 요약을 함께 적어요.
