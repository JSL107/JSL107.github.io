import assert from "node:assert/strict";
import test from "node:test";

export const contract = {
  version: "1.2.0",
  maxAttempts: 3,
  leaseDuration: 10,
  taskTimeout: 30,
};

const keyOf = ({ taskId, eventId, action }) => `${taskId}:${eventId}:${action}`;
const clone = (value) => structuredClone(value);

const allowedTransitions = {
  running: new Set(["completed", "failed", "expired", "awaiting_approval", "manual_review"]),
  failed: new Set(["running", "awaiting_approval", "manual_review"]),
  awaiting_approval: new Set(["running", "failed", "manual_review"]),
  expired: new Set(["manual_review"]),
  manual_review: new Set(["running", "failed"]),
  completed: new Set(),
};

const stageTransitions = {
  plan: "build",
  build: "verify",
  verify: "review",
  review: "completed",
};

class StateStore {
  constructor(snapshot = null, { clock = () => Date.now() } = {}) {
    this.records = new Map();
    this.history = [];
    this.clock = clock;
    if (snapshot) {
      this.records = new Map(snapshot.records.map(([key, value]) => [key, clone(value)]));
      this.history = clone(snapshot.history);
    }
  }

  snapshot() {
    return clone({ records: [...this.records.entries()], history: this.history });
  }

  claim(input, owner, now, options = {}) {
    const idempotencyKey = keyOf(input);
    const existing = this.records.get(idempotencyKey);
    if (existing) return { claimed: false, state: clone(existing), lease: this.leaseOf(existing) };

    const state = {
      ...input,
      fixtureId: options.fixtureId ?? input.fixtureId ?? null,
      contractVersion: contract.version,
      idempotencyKey,
      status: "running",
      stage: "plan",
      version: 1,
      attempts: 0,
      leaseOwner: owner,
      leaseUntil: now + (options.leaseDuration ?? contract.leaseDuration),
      leaseToken: 1,
      timeoutAt: options.timeoutAt ?? now + contract.taskTimeout,
      verification: null,
      approval: null,
      completedReport: null,
      externalEffect: { status: "none", externalId: null, result: null, calledAt: null },
      failureHistory: [],
      transitionHistory: [],
    };
    this.records.set(idempotencyKey, state);
    this.history.push({ type: "claim", idempotencyKey, owner, now, version: state.version });
    return { claimed: true, state: clone(state), lease: this.leaseOf(state) };
  }

  claimAsync(input, owner, now, options) {
    return Promise.resolve().then(() => this.claim(input, owner, now, options));
  }

  leaseOf(state) {
    return { owner: state.leaseOwner, token: state.leaseToken };
  }

  getState(input) {
    return clone(this._get(input));
  }

  currentLease(input) {
    return this.leaseOf(this._get(input));
  }

  _get(input) {
    const state = this.records.get(keyOf(input));
    assert.ok(state, "state must be claimed before use");
    return state;
  }

  _assertLease(state, lease, now) {
    assert.deepEqual(lease, this.leaseOf(state), "stale lease is fenced");
    assert.ok(now < state.leaseUntil, "lease must be active");
  }

  _touch(state, entry) {
    state.version += 1;
    this.history.push({ ...entry, idempotencyKey: state.idempotencyKey, version: state.version });
  }

  reclaim(input, owner, now) {
    const state = this._get(input);
    if (state.status !== "running" || state.leaseUntil > now || now >= state.timeoutAt) {
      return { reclaimed: false, lease: this.leaseOf(state) };
    }
    state.leaseOwner = owner;
    state.leaseUntil = now + contract.leaseDuration;
    state.leaseToken += 1;
    this._touch(state, { type: "lease_reclaimed", owner, now });
    return { reclaimed: true, lease: this.leaseOf(state) };
  }

  transition(input, status, reason, lease, now) {
    const state = this._get(input);
    this._assertLease(state, lease, now);
    assert.ok(allowedTransitions[state.status]?.has(status), `${state.status} -> ${status} is not allowed`);
    assert.notEqual(status, "completed", "completed requires completeReview()");
    const from = state.status;
    state.status = status;
    const entry = { type: "transition", from, to: status, reason, now };
    state.transitionHistory.push(entry);
    if (["failed", "expired", "manual_review"].includes(status)) state.failureHistory.push(entry);
    this._touch(state, entry);
    if (status === "completed") {
      state.stage = "completed";
      state.completedReport = { status, idempotencyKey: state.idempotencyKey };
    }
    return clone(state);
  }

  moveToBuild(input, lease, now) {
    return this._moveStage(input, "build", lease, now);
  }

  moveToVerify(input, lease, now) {
    return this._moveStage(input, "verify", lease, now);
  }

  completeReview(input, lease, now, evidence) {
    const state = this._get(input);
    this._assertLease(state, lease, now);
    assert.equal(state.status, "running", "review completion requires running state");
    assert.equal(state.stage, "review", "review stage is required");
    assert.ok(evidence, "review evidence is required");
    assert.equal(state.verification?.overallExitCode, 0, "only a successful verification can complete");
    const stageEntry = { type: "stage", from: "review", to: "completed", evidence, now };
    state.transitionHistory.push(stageEntry);
    this._touch(state, stageEntry);
    state.status = "completed";
    state.stage = "completed";
    const transitionEntry = { type: "transition", from: "running", to: "completed", reason: "review passed", evidence, now };
    state.transitionHistory.push(transitionEntry);
    this._touch(state, transitionEntry);
    state.completedReport = { status: "completed", idempotencyKey: state.idempotencyKey, fixtureId: state.fixtureId, evidence };
    return clone(state);
  }

  _moveStage(input, nextStage, lease, now) {
    const state = this._get(input);
    this._assertLease(state, lease, now);
    assert.equal(stageTransitions[state.stage], nextStage, `${state.stage} -> ${nextStage} is not allowed`);
    const from = state.stage;
    state.stage = nextStage;
    const entry = { type: "stage", from, to: nextStage, now };
    state.transitionHistory.push(entry);
    this._touch(state, entry);
    return clone(state);
  }

  expireIfTimedOut(input, lease, now) {
    const state = this._get(input);
    this._assertLease(state, lease, now);
    if (now < state.timeoutAt || ["completed", "expired"].includes(state.status)) return clone(state);
    return this.transition(input, "expired", "task timeout reached", lease, now);
  }

  recordVerification(input, results, lease, now) {
    const state = this._get(input);
    this._assertLease(state, lease, now);
    assert.equal(state.status, "running", "verification requires running state");
    assert.equal(state.stage, "verify", "verification requires verify stage");
    const overallExitCode = results.some((result) => result.exitCode !== 0) ? 1 : 0;
    const fixtureIds = results.map((result) => result.fixtureId);
    assert.ok(fixtureIds.every(Boolean), "verification results require fixtureId");
    state.attempts += 1;
    state.verification = { results: clone(results), overallExitCode, recordedAt: now, fixtureIds };
    this._touch(state, { type: "verification_recorded", attempt: state.attempts, overallExitCode, fixtureIds, now });
    return { overallExitCode, attempts: state.attempts };
  }

  async runVerification(input, lease, now, fixtures) {
    const fixtureList = Array.isArray(fixtures) ? fixtures : fixtures.fixtures;
    const expectedOverallExitCode = fixtures?.expectedOverallExitCode;
    const timedOut = this.getState(input).timeoutAt <= now;
    if (timedOut) return { overallExitCode: null, attempts: this.getState(input).attempts, results: [], state: this.expireIfTimedOut(input, lease, now) };
    const results = [];
    for (const fixture of fixtureList) {
      const result = await fixture();
      if (fixture.expectedExitCode !== undefined) assert.equal(result.exitCode, fixture.expectedExitCode, `${fixture.label} exit code contract`);
      assert.equal(result.fixtureId, fixture.fixtureId, "fixture result fixtureId contract");
      results.push(result);
    }
    const overallExitCode = results.some((result) => result.exitCode !== 0) ? 1 : 0;
    if (expectedOverallExitCode !== undefined) assert.equal(overallExitCode, expectedOverallExitCode, "fixture overall exit code contract");
    const result = this.recordVerification(input, results, lease, now);
    const nextLease = this.leaseOf(this._get(input));
    if (result.overallExitCode === 0) {
      this._moveStage(input, "review", nextLease, now);
    } else if (result.attempts >= contract.maxAttempts) {
      this.transition(input, "awaiting_approval", "maxAttempts reached", nextLease, now);
    } else {
      this.transition(input, "failed", "verification exit code 1", nextLease, now);
    }
    return { ...result, results, state: this.getState(input) };
  }

  retry(input, lease, now) {
    const state = this._get(input);
    assert.ok(state.attempts < contract.maxAttempts, "retry cap reached");
    return this.transition(input, "running", "retry requested", lease, now);
  }

  approve(input, lease, now, approval) {
    const state = this._get(input);
    this._assertLease(state, lease, now);
    assert.equal(state.status, "running", "approval requires running state");
    assert.ok(approval?.actor && approval?.approvedAt && approval?.evidence, "approval metadata is required");
    assert.ok(approval.approvedAt <= now, "approval cannot be in the future");
    state.approval = { actor: approval.actor, approvedAt: approval.approvedAt, evidence: approval.evidence };
    this._touch(state, { type: "approval_recorded", actor: approval.actor, approvedAt: approval.approvedAt, now });
    return clone(state);
  }

  approveRetry(input, owner, now, approval) {
    const state = this._get(input);
    assert.equal(state.status, "awaiting_approval", "retry approval requires awaiting_approval state");
    assert.ok(approval?.actor && approval?.approvedAt && approval?.evidence, "approval metadata is required");
    assert.ok(approval.approvedAt <= now, "approval cannot be in the future");
    const lease = state.leaseUntil <= now ? this.reclaimReviewLease(state, owner, now) : this.leaseOf(state);
    state.approval = { actor: approval.actor, approvedAt: approval.approvedAt, evidence: approval.evidence };
    this._touch(state, { type: "approval_recorded", actor: approval.actor, approvedAt: approval.approvedAt, now });
    return this.transition(input, "running", "retry approved", lease, now);
  }

  async runExternalEffect(input, lease, now, effect, persist = () => {}) {
    const state = this._get(input);
    this._assertLease(state, lease, now);
    assert.equal(state.status, "running", "external effect requires running state");
    assert.ok(state.approval, "external effect requires approval");
    if (state.externalEffect.status === "confirmed") {
      return { claimedState: this.getState(input), result: clone(state.externalEffect.result), state: this.getState(input) };
    }
    assert.equal(state.externalEffect.status, "none", "external effect must be claimed once");
    state.externalEffect.status = "claimed";
    this._touch(state, { type: "external_claim", now, actor: state.approval.actor });

    const claimedState = this.getState(input);
    const calledAt = this.clock();
    let result;
    try {
      result = await effect();
    } catch (error) {
      state.externalEffect = { status: "failed", externalId: null, result: null, calledAt };
      this._touch(state, { type: "external_rejected", reason: error.message, now });
      this.transition(input, "failed", "external effect rejected", this.leaseOf(state), now);
      return { claimedState, result: null, error, state: this.getState(input) };
    }
    try {
      persist(result);
      state.externalEffect = { status: "confirmed", externalId: result.externalId, result: clone(result), calledAt };
      this._touch(state, { type: "external_result_saved", now });
    } catch (error) {
      this._touch(state, { type: "external_result_uncertain", reason: error.message, now });
      this.transition(input, "manual_review", "external result persistence failed", this.leaseOf(state), now);
    }
    return { claimedState, result, state: this.getState(input) };
  }

  recoverManualReview(input, owner, now, decision) {
    const state = this._get(input);
    assert.equal(state.status, "manual_review", "manual review is required");
    const lease = state.leaseUntil <= now ? this.reclaimReviewLease(state, owner, now) : this.leaseOf(state);
    if (decision === "resume") return this.transition(input, "running", "manual review resolved", lease, now);
    return this.transition(input, "failed", "manual review rejected", lease, now);
  }

  reclaimReviewLease(state, owner, now) {
    state.leaseOwner = owner;
    state.leaseUntil = now + contract.leaseDuration;
    state.leaseToken += 1;
    this._touch(state, { type: "review_lease_reclaimed", owner, now });
    return this.leaseOf(state);
  }
}

const makeFixture = ({ fixtureId, name, expectedExitCode, exitCode = expectedExitCode, stdout, stderr }) => {
  const fixture = async () => ({ fixtureId, name, exitCode, stdout, stderr });
  fixture.fixtureId = fixtureId;
  fixture.label = name;
  fixture.expectedExitCode = expectedExitCode;
  return fixture;
};

const oneFailureFixtures = {
  fixtures: [
    makeFixture({ fixtureId: "fixture-pass-1", name: "test_pass_1", expectedExitCode: 0, stdout: "PASS test_pass_1", stderr: "" }),
    makeFixture({ fixtureId: "fixture-fail-1", name: "test_fail_1", expectedExitCode: 1, stdout: "FAIL test_fail_1", stderr: "expected 1 to be 2" }),
    makeFixture({ fixtureId: "fixture-pass-2", name: "test_pass_2", expectedExitCode: 0, stdout: "PASS test_pass_2", stderr: "" }),
  ],
  expectedOverallExitCode: 1,
};

const successFixtures = {
  fixtures: [
    makeFixture({ fixtureId: "fixture-success-1", name: "test_pass_1", expectedExitCode: 0, stdout: "PASS test_pass_1", stderr: "" }),
    makeFixture({ fixtureId: "fixture-success-2", name: "test_pass_2", expectedExitCode: 0, stdout: "PASS test_pass_2", stderr: "" }),
  ],
  expectedOverallExitCode: 0,
};

const prepareVerify = (store, input, owner = "worker-a", now = 100) => {
  const claim = store.claim(input, owner, now);
  store.moveToBuild(input, claim.lease, now + 1);
  store.moveToVerify(input, claim.lease, now + 2);
  return { claim, lease: store.currentLease(input) };
};

test("same key is claimed once under concurrent Promise.all in one memory store", async () => {
  const store = new StateStore();
  const input = { taskId: "task-1", eventId: "event-1", action: "verify" };
  const claims = await Promise.all([
    store.claimAsync(input, "worker-a", 100),
    store.claimAsync(input, "worker-b", 100),
  ]);

  assert.equal(contract.version, "1.2.0");
  assert.equal(claims.filter((claim) => claim.claimed).length, 1);
  assert.equal(claims[0].state.idempotencyKey, "task-1:event-1:verify");
  assert.equal(store.records.size, 1);
});

test("expired lease is reacquired with a new fencing token and fences the stale worker", () => {
  const store = new StateStore();
  const input = { taskId: "task-2", eventId: "event-2", action: "build" };
  const first = store.claim(input, "worker-a", 100);
  const reclaimed = store.reclaim(input, "worker-b", 110);

  assert.equal(reclaimed.reclaimed, true);
  assert.equal(reclaimed.lease.owner, "worker-b");
  assert.equal(reclaimed.lease.token, first.lease.token + 1);
  assert.throws(() => store.transition(input, "failed", "stale worker", first.lease, 111), /stale lease is fenced/);
  assert.equal(store.transition(input, "failed", "new worker", reclaimed.lease, 111).status, "failed");
});

test("three-fixture verification records output and blocks completion on exit code 1", async () => {
  const store = new StateStore();
  const input = { taskId: "task-3", eventId: "fixture-3", action: "verify", fixtureId: "one-failure-three-fixtures" };
  const { lease } = prepareVerify(store, input);
  const result = await store.runVerification(input, lease, 103, oneFailureFixtures);

  assert.equal(oneFailureFixtures.fixtures.length, 3);
  assert.equal(result.overallExitCode, 1);
  assert.deepEqual(result.results.map(({ fixtureId, name, exitCode, stdout, stderr }) => ({ fixtureId, name, exitCode, stdout, stderr })), [
    { fixtureId: "fixture-pass-1", name: "test_pass_1", exitCode: 0, stdout: "PASS test_pass_1", stderr: "" },
    { fixtureId: "fixture-fail-1", name: "test_fail_1", exitCode: 1, stdout: "FAIL test_fail_1", stderr: "expected 1 to be 2" },
    { fixtureId: "fixture-pass-2", name: "test_pass_2", exitCode: 0, stdout: "PASS test_pass_2", stderr: "" },
  ]);
  assert.equal(result.state.status, "failed");
  assert.equal(result.state.fixtureId, "one-failure-three-fixtures");
  assert.deepEqual(result.state.verification.fixtureIds, ["fixture-pass-1", "fixture-fail-1", "fixture-pass-2"]);
  assert.deepEqual(store.history.find((entry) => entry.type === "verification_recorded").fixtureIds, result.state.verification.fixtureIds);
  assert.equal(result.state.completedReport, null);
  assert.equal(result.state.failureHistory.length, 1);
  assert.equal(result.state.transitionHistory.at(-1).to, "failed");

  const overallMismatchStore = new StateStore();
  const overallMismatchInput = { taskId: "task-3-mismatch", eventId: "fixture-3", action: "verify" };
  const { lease: overallMismatchLease } = prepareVerify(overallMismatchStore, overallMismatchInput);
  await assert.rejects(
    () => overallMismatchStore.runVerification(overallMismatchInput, overallMismatchLease, 103, { fixtures: oneFailureFixtures.fixtures, expectedOverallExitCode: 0 }),
    /fixture overall exit code contract/,
  );
  assert.equal(overallMismatchStore.getState(overallMismatchInput).attempts, 0);

  const expectedExitCodeMismatch = makeFixture({ fixtureId: "fixture-expected-exit-mismatch", name: "test_expected_exit_mismatch", expectedExitCode: 1, exitCode: 0, stdout: "PASS", stderr: "" });
  const exitCodeMismatchStore = new StateStore();
  const exitCodeMismatchInput = { taskId: "task-3-fixture-mismatch", eventId: "fixture-3", action: "verify" };
  const { lease: exitCodeMismatchLease } = prepareVerify(exitCodeMismatchStore, exitCodeMismatchInput);
  await assert.rejects(
    () => exitCodeMismatchStore.runVerification(exitCodeMismatchInput, exitCodeMismatchLease, 103, [expectedExitCodeMismatch]),
    /exit code contract/,
  );

  const mismatchedResultFixture = async () => ({ fixtureId: "fixture-result-id", name: "test_fixture_id_mismatch", exitCode: 0, stdout: "PASS", stderr: "" });
  mismatchedResultFixture.fixtureId = "fixture-input-id";
  mismatchedResultFixture.expectedExitCode = 0;
  mismatchedResultFixture.label = "test_fixture_id_mismatch";
  const fixtureIdMismatchStore = new StateStore();
  const fixtureIdMismatchInput = { taskId: "task-3-fixture-id-mismatch", eventId: "fixture-3", action: "verify" };
  const { lease: fixtureIdMismatchLease } = prepareVerify(fixtureIdMismatchStore, fixtureIdMismatchInput);
  await assert.rejects(
    () => fixtureIdMismatchStore.runVerification(fixtureIdMismatchInput, fixtureIdMismatchLease, 103, [mismatchedResultFixture]),
    /fixture result fixtureId contract/,
  );
  assert.equal(fixtureIdMismatchStore.getState(fixtureIdMismatchInput).attempts, 0);
});

test("successful fixtures reproduce plan-build-verify-review-completed", async () => {
  const store = new StateStore();
  const input = { taskId: "task-success", eventId: "fixture-success", action: "verify", fixtureId: "success-two-fixtures" };
  const { lease } = prepareVerify(store, input);
  const result = await store.runVerification(input, lease, 103, successFixtures);
  assert.equal(result.overallExitCode, 0);
  assert.equal(result.state.stage, "review");
  const completed = store.completeReview(input, store.currentLease(input), 104, "review fixture passed");
  assert.equal(completed.status, "completed");
  assert.equal(completed.stage, "completed");
  assert.deepEqual(completed.transitionHistory.filter((entry) => entry.type === "stage").map(({ from, to }) => `${from}->${to}`), [
    "plan->build", "build->verify", "verify->review", "review->completed",
  ]);
  assert.ok(completed.completedReport);
  assert.equal(completed.completedReport.fixtureId, "success-two-fixtures");
});

test("maxAttempts=3 stops retries at awaiting_approval without completing", async () => {
  const store = new StateStore();
  const input = { taskId: "task-4", eventId: "retry-cap", action: "verify" };
  let { lease } = prepareVerify(store, input);
  let result;
  for (let attempt = 0; attempt < contract.maxAttempts; attempt += 1) {
    result = await store.runVerification(input, lease, 103 + attempt, oneFailureFixtures);
    if (result.state.status === "awaiting_approval") break;
    lease = store.currentLease(input);
    store.retry(input, lease, 104 + attempt);
    lease = store.currentLease(input);
  }

  assert.equal(result.state.attempts, 3);
  assert.equal(result.state.status, "awaiting_approval");
  assert.equal(result.state.completedReport, null);
  assert.deepEqual(store.getState(input).transitionHistory.filter((entry) => entry.type === "transition").map(({ from, to }) => `${from}->${to}`), [
    "running->failed", "failed->running", "running->failed", "failed->running", "running->awaiting_approval",
  ]);
});

test("awaiting_approval resumes only with actor, approvedAt, and evidence", async () => {
  const store = new StateStore();
  const input = { taskId: "task-approval-retry", eventId: "retry-approval", action: "verify" };
  let { lease } = prepareVerify(store, input);
  for (let attempt = 0; attempt < contract.maxAttempts; attempt += 1) {
    const result = await store.runVerification(input, lease, 103 + attempt, oneFailureFixtures);
    if (result.state.status === "awaiting_approval") break;
    lease = store.currentLease(input);
    store.retry(input, lease, 104 + attempt);
    lease = store.currentLease(input);
  }
  const leaseBeforeApproval = store.currentLease(input);
  assert.throws(() => store.approveRetry(input, "reviewer-1", 106, { actor: "reviewer-1", approvedAt: 106 }), /approval metadata is required/);
  const resumed = store.approveRetry(input, "reviewer-1", 106, { actor: "reviewer-1", approvedAt: 105, evidence: "ticket-3" });
  assert.equal(resumed.status, "running");
  assert.deepEqual(store.currentLease(input), leaseBeforeApproval);
  assert.deepEqual(resumed.approval, { actor: "reviewer-1", approvedAt: 105, evidence: "ticket-3" });
});

test("approveRetry replaces an expired lease before resuming", async () => {
  const store = new StateStore();
  const input = { taskId: "task-approval-expired", eventId: "retry-approval-expired", action: "verify" };
  let { lease } = prepareVerify(store, input);
  for (let attempt = 0; attempt < contract.maxAttempts; attempt += 1) {
    const result = await store.runVerification(input, lease, 103 + attempt, oneFailureFixtures);
    if (result.state.status === "awaiting_approval") break;
    lease = store.currentLease(input);
    store.retry(input, lease, 104 + attempt);
    lease = store.currentLease(input);
  }

  const expiredLease = store.currentLease(input);
  const resumed = store.approveRetry(input, "reviewer-2", 111, { actor: "reviewer-2", approvedAt: 110, evidence: "ticket-expired-3" });

  assert.equal(resumed.status, "running");
  assert.deepEqual(store.currentLease(input), { owner: "reviewer-2", token: expiredLease.token + 1 });
  assert.notDeepEqual(store.currentLease(input), expiredLease);
});

test("transition guard rejects bypasses and increments version on accepted transitions", () => {
  const store = new StateStore();
  const input = { taskId: "task-guard", eventId: "states-1", action: "verify" };
  const { lease } = prepareVerify(store, input);
  const failed = store.transition(input, "failed", "exit code 1", lease, 103);
  assert.ok(failed.version > 3);
  assert.throws(() => store.transition(input, "completed", "bypass review", store.currentLease(input), 104), /failed -> completed is not allowed/);
  store.transition(input, "running", "retry", store.currentLease(input), 104);
  store.transition(input, "awaiting_approval", "retry cap", store.currentLease(input), 105);
  store.transition(input, "manual_review", "evidence missing", store.currentLease(input), 106);
  store.transition(input, "failed", "review rejected", store.currentLease(input), 107);

  const state = store.getState(input);
  assert.equal(state.status, "failed");
  assert.equal(state.failureHistory.length, 3);
  assert.ok(store.history.every((entry, index, history) => index === 0 || entry.version > history[index - 1].version));
});

test("direct transition to completed is rejected even from the running review stage", async () => {
  const store = new StateStore();
  const input = { taskId: "task-complete-bypass", eventId: "completed-bypass", action: "verify" };
  const { lease } = prepareVerify(store, input);
  await store.runVerification(input, lease, 103, successFixtures);

  assert.throws(() => store.transition(input, "completed", "bypass completeReview", store.currentLease(input), 104), /completed requires completeReview\(\)/);
  assert.equal(store.getState(input).status, "running");
  assert.equal(store.getState(input).stage, "review");
});

test("timeoutAt is evaluated by runVerification and transitions to expired without running fixtures", async () => {
  const store = new StateStore();
  const input = { taskId: "task-timeout", eventId: "timeout-1", action: "verify" };
  const claim = store.claim(input, "worker-a", 100, { timeoutAt: 105 });
  let called = false;
  const result = await store.runVerification(input, claim.lease, 105, [async () => { called = true; return { name: "should_not_run", exitCode: 0 }; }]);

  assert.equal(called, false);
  assert.equal(result.state.status, "expired");
  assert.equal(result.state.timeoutAt, 105);
  assert.equal(result.state.failureHistory[0].to, "expired");
});

test("approval metadata is required before an external effect can be called", async () => {
  const store = new StateStore();
  const input = { taskId: "task-approval", eventId: "send-approval", action: "send" };
  const claim = store.claim(input, "worker-a", 100);
  let calls = 0;
  await assert.rejects(() => store.runExternalEffect(input, claim.lease, 101, async () => { calls += 1; return { externalId: "never" }; }), /external effect requires approval/);
  assert.equal(calls, 0);

  const approved = store.approve(input, claim.lease, 102, { actor: "reviewer-1", approvedAt: 101, evidence: "ticket-42" });
  assert.deepEqual(approved.approval, { actor: "reviewer-1", approvedAt: 101, evidence: "ticket-42" });
  const outcome = await store.runExternalEffect(input, claim.lease, 103, async () => { calls += 1; return { externalId: "provider-approval", accepted: true }; });
  assert.equal(calls, 1);
  assert.equal(outcome.state.externalEffect.status, "confirmed");
});

test("external effect is claimed before the call and saved after a successful call", async () => {
  const store = new StateStore(null, { clock: () => 1002 });
  const input = { taskId: "task-5", eventId: "send-1", action: "send" };
  const claim = store.claim(input, "worker-a", 100);
  store.approve(input, claim.lease, 101, { actor: "reviewer-1", approvedAt: 101, evidence: "ticket-1" });
  const order = [];
  const outcome = await store.runExternalEffect(input, claim.lease, 102, async () => {
    order.push(store.getState(input).externalEffect.status);
    return { externalId: "provider-1", accepted: true };
  }, () => order.push("persist"));

  assert.deepEqual(order, ["claimed", "persist"]);
  assert.equal(outcome.state.externalEffect.status, "confirmed");
  assert.equal(outcome.state.externalEffect.externalId, "provider-1");
  assert.equal(outcome.state.externalEffect.calledAt, 1002);
});

test("repeated external-effect requests reuse the confirmed result without calling the provider twice", async () => {
  const store = new StateStore();
  const input = { taskId: "task-effect-idempotent", eventId: "send-idempotent", action: "send" };
  const claim = store.claim(input, "worker-a", 100);
  store.approve(input, claim.lease, 101, { actor: "reviewer-1", approvedAt: 101, evidence: "ticket-idempotent" });
  let calls = 0;
  const effect = async () => { calls += 1; return { externalId: "provider-idempotent", accepted: true }; };

  const first = await store.runExternalEffect(input, claim.lease, 102, effect);
  const second = await store.runExternalEffect(input, claim.lease, 103, effect);

  assert.equal(calls, 1);
  assert.deepEqual(second.result, first.result);
  assert.equal(second.state.externalEffect.status, "confirmed");
});

test("external provider rejection is recorded as failed without retrying the provider", async () => {
  const store = new StateStore(null, { clock: () => 1002 });
  const input = { taskId: "task-effect-reject", eventId: "send-reject", action: "send" };
  const claim = store.claim(input, "worker-a", 100);
  store.approve(input, claim.lease, 101, { actor: "reviewer-1", approvedAt: 101, evidence: "ticket-reject" });
  let calls = 0;
  const outcome = await store.runExternalEffect(input, claim.lease, 102, async () => {
    calls += 1;
    throw new Error("provider rejected");
  });

  assert.equal(calls, 1);
  assert.equal(outcome.result, null);
  assert.equal(outcome.state.externalEffect.status, "failed");
  assert.equal(outcome.state.externalEffect.calledAt, 1002);
  assert.equal(outcome.state.status, "failed");
  assert.equal(outcome.state.failureHistory.at(-1).to, "failed");
  assert.equal(store.history.filter((entry) => entry.type === "external_rejected").length, 1);
});

test("external result persistence failure is uncertain, does not retry, and enters manual_review", async () => {
  const store = new StateStore(null, { clock: () => 1002 });
  const input = { taskId: "task-6", eventId: "send-2", action: "send" };
  const claim = store.claim(input, "worker-a", 100);
  store.approve(input, claim.lease, 101, { actor: "reviewer-1", approvedAt: 101, evidence: "ticket-2" });
  const outcome = await store.runExternalEffect(input, claim.lease, 102, async () => ({ externalId: "provider-2", accepted: true }), () => { throw new Error("database unavailable"); });

  assert.equal(outcome.state.externalEffect.status, "claimed");
  assert.equal(outcome.state.externalEffect.calledAt, null);
  assert.equal(outcome.state.status, "manual_review");
  assert.equal(outcome.state.attempts, 0);
  assert.equal(store.history.filter((entry) => entry.type === "external_claim").length, 1);
  assert.equal(store.history.filter((entry) => entry.type === "external_result_uncertain").length, 1);
});

test("manual_review can recover with a fresh lease and keeps transition history", () => {
  const store = new StateStore();
  const input = { taskId: "task-7", eventId: "review-1", action: "verify" };
  const claim = store.claim(input, "worker-a", 100, { timeoutAt: 105 });
  store.transition(input, "manual_review", "human review requested", claim.lease, 101);
  const recovered = store.recoverManualReview(input, "reviewer-1", 111, "resume");
  store.expireIfTimedOut(input, store.currentLease(input), 120);
  store.transition(input, "manual_review", "human review requested again", store.currentLease(input), 120);
  store.recoverManualReview(input, "reviewer-2", 124, "reject");

  assert.equal(recovered.status, "running");
  assert.equal(store.getState(input).status, "failed");
  assert.deepEqual(store.getState(input).transitionHistory.map(({ from, to }) => `${from}->${to}`), [
    "running->manual_review", "manual_review->running", "running->expired", "expired->manual_review", "manual_review->failed",
  ]);
  assert.ok(store.history.every((entry, index, history) => index === 0 || entry.version > history[index - 1].version));
});

test("a serialized memory snapshot restores state in a new StateStore instance", () => {
  const original = new StateStore();
  const input = { taskId: "task-restart", eventId: "restart-1", action: "verify", fixtureId: "restart-fixture" };
  const claim = original.claim(input, "worker-a", 100);
  original.moveToBuild(input, claim.lease, 101);
  const restored = new StateStore(original.snapshot());

  assert.deepEqual(restored.getState(input), original.getState(input));
  assert.equal(restored.getState(input).fixtureId, "restart-fixture");
  assert.equal(restored.history.length, original.history.length);
});
