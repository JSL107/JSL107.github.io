---
title: "에이전트의 코드 실행 경계 설계하기"
description: "Slack 기반 멀티 에이전트 시스템에서 코드 실행을 격리할 범위와 실행 기록·실패 처리를 검토한다."
pubDatetime: 2026-10-24T19:43:00+09:00
category: infra
---

Slack에서 에이전트에게 PR 리뷰를 맡길 때 diff를 읽는 데서 그치지 않고 의존성을 설치해 테스트까지 돌리려면 실행 공간을 어디에 둘지 정해야 해요. 이 글은 Cloudflare Sandbox, Cloudflare Agents의 Sandbox 도구 문서, E2B의 sandbox와 coding agents 문서, Modal Sandboxes 문서를 바탕으로 지금 만들고 있는 Slack 기반 LLM 멀티 에이전트 시스템의 실행 경계를 검토한 글이에요. 직접 운영해 본 후기는 아니에요.

모델 호출이 실패하면 응답이 비었는지, JSON 파싱이 깨졌는지, 토큰이 만료됐는지처럼 문제를 나눠 볼 수 있어요. 그런데 npm install이 멈추거나 테스트가 무한 루프에 빠지고 패키지 설치 중 외부 네트워크에 접근한다면, 실행 공간을 어디까지 믿을 수 있는지가 문제예요.

여기에 sandboxed code execution boundary가 필요해요. 에이전트가 만든 코드와 shell command, 패키지 설치, 테스트 실행을 운영 서버나 개발자 로컬이 아닌 격리된 Linux 공간에서 돌리는 경계예요. 기존에는 CLI provider를 보호하려고 임시 HOME을 주고 안전한 환경 변수만 넘기며 prompt를 stdin으로 전달해 프로세스 단위의 오염을 줄였어요. sandbox boundary를 두면 파일시스템·네트워크·프로세스·리소스까지 실행 런타임 밖으로 분리할 수 있어요.

## 모델 호출보다 작업 공간이 먼저 문제다

에이전트 시스템을 만들 때는 어떤 모델을 부를지부터 생각하기 쉬워요. 하지만 실제 실행을 붙이면 모델이 낸 계획을 어디에 체크아웃할지, 생성한 파일을 어디에 둘지, 테스트 로그와 빌드 산출물을 얼마나 보존할지, 실패한 뒤 같은 공간에서 이어갈지까지 정해야 해요.

Cloudflare Sandbox에서는 Workers 애플리케이션이 TypeScript API로 격리된 컨테이너를 다룰 수 있어요. 명령 실행, 파일 조작, background process, preview URL 같은 기능을 기본으로 제공해요. E2B는 에이전트용 on-demand Linux VM을 만들고 pause·resume·kill 같은 lifecycle을 제공해요. Modal Sandboxes도 런타임에 컨테이너를 만들고 그 안에서 arbitrary command를 실행하는 모델이에요.

이 도구들은 LLM이 일할 작업 공간을 따로 마련해 줘요. 모델 응답은 DB에 남길 수 있지만 node_modules, test log, generated patch, preview server는 DB에 넣기 좋은 데이터가 아니에요. 그런 부산물은 sandbox filesystem에 둘 수 있어요.

CLI provider를 운영할 때 실제 HOME 대신 임시 HOME을 주고, 인증 파일은 필요한 것만 보존하며, prompt를 argv로 넘기지 않고, working directory를 제한할 수 있어요. 그래도 그 프로세스가 실행하는 명령까지 안전해지는 건 아니에요. npm install은 네트워크를 쓰고 test runner는 child process를 만들 수 있으며 빌드 스크립트는 파일을 읽고 써요. repo checkout은 git credential, SSH 설정, package registry 설정과 맞닿아 있고요. safe env는 시작점이지 완성된 boundary는 아니에요.

| 구분 | 기존 CLI 보호 | Sandbox boundary |
| --- | --- | --- |
| 주요 대상 | CLI provider 프로세스 | 작업 실행 공간 전체 |
| 격리 범위 | HOME, env, cwd, stdin | filesystem, process, network, timeout, artifact |
| 실패 모델 | 모델 호출 실패, CLI 실행 실패 | sandbox 생성 실패, command 실패, timeout, OOM, 네트워크 차단 |
| 보존 대상 | 응답 문자열, stderr | 파일, 로그, diff, background process 상태 |

모든 작업을 sandbox로 보내면 운영할 것도 늘어요. 다만 에이전트가 실제 코드를 실행하기 시작했다면 이 복잡도는 이미 생긴 비용에 가까워요.

## API가 보여주는 상태·명령·네트워크 경계

Cloudflare Agents의 Sandbox 예시에서는 에이전트의 state에 마지막 출력 같은 작은 메타데이터를 남기고 실제 코드 파일은 sandbox filesystem에 써요. 이어서 sandbox.exec()로 실행한 뒤 stdout, stderr, exitCode를 받아요.

```typescript
import { Agent, callable } from "agents";
import { getSandbox } from "@cloudflare/sandbox";
import type { Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
};

export class CodeAgent extends Agent<Env, { lastOutput?: string }> {
  @callable()
  async runPython(code: string) {
    const sandbox = getSandbox(this.env.Sandbox, this.name);

    await sandbox.writeFile("/workspace/script.py", code);

    const result = await sandbox.exec("python3 /workspace/script.py");

    this.setState({ lastOutput: result.stdout });

    return {
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }
}
```

Slack에서 사용자가 PR 리뷰를 요청하면 DB에는 요청자, 입력, 모델 응답, 실행 상태를 남길 수 있어요. repo checkout, dependency install, test log, diff 파일은 sandbox의 /workspace 아래에 두고요. 사용자에게 보여줄 최종 요약은 DB에서 꺼내도 되지만, 판단 근거를 확인할 증거는 sandbox artifact로 남겨요.

Cloudflare 문서의 “Sandbox vs Agent State” 구분도 user-visible progress와 작은 metadata는 agent state에, workspace files·generated code·package installs·logs·artifacts는 sandbox filesystem에 두는 방향이에요. 실행 기록 테이블에는 sandboxId, artifactPath, commandExitCode, sandboxErrorCode 같은 필드를 붙일 수 있어요.

명령을 실행하는 방식도 용도에 따라 달라요. Cloudflare Sandbox의 Commands API는 exec, execStream, startProcess를 구분해요. 한 번 돌리고 끝나는 빌드나 스크립트는 exec, 긴 로그를 실시간으로 보여줘야 하는 작업은 execStream, 개발 서버나 preview server처럼 계속 떠 있어야 하는 작업은 startProcess에 가까워요.

```typescript
const result = await sandbox.exec("npm run build");

if (result.success) {
  console.log("Build output:", result.stdout);
} else {
  console.error("Build failed:", result.stderr);
}
```

이 예시에서는 stdout과 별개로 success, stderr, exitCode를 받는다는 점이 중요해요. 테스트 실패를 모델이나 sandbox의 실패로 볼 수는 없어요. 실행은 성공했지만 command가 non-zero로 끝난 거예요. 반면 command를 시작하지 못했거나 sandbox가 timeout으로 죽었다면 실행 환경이 실패한 거고요. 에이전트 시스템에서는 이 차이를 error code로 남겨야 해요.

BullMQ 같은 queue에서 모든 실패에 같은 retry 정책을 적용하면 안 돼요. sandbox 생성 실패는 재시도할 수 있지만, 네트워크 allowlist 때문에 패키지를 받지 못했다면 재시도해도 같은 문제가 반복될 가능성이 높아요. 테스트 실패는 재시도하기보다 모델이 수정할 때 참고할 근거로 돌려줘야 해요.

네트워크도 작업에 필요한 범위만 열어야 해요. Cloudflare Sandbox의 outbound traffic 문서는 enableInternet = false, allowedHosts, deniedHosts, outbound handler 같은 장치를 제공해요. outbound handler는 sandbox 밖의 Worker runtime에서 실행되므로 secret을 sandbox 안에 직접 넣지 않고 요청에 붙일 수 있어요.

```typescript
import { Sandbox, ContainerProxy } from "@cloudflare/sandbox";

export { ContainerProxy };

export class MySandbox extends Sandbox {
  enableInternet = false;

  allowedHosts = ["allowed.com"];
}
```

에이전트가 GitHub API를 호출해야 한다고 해서 GitHub token을 sandbox 환경 변수에 넣을 필요는 없어요. 읽기 전용 권한을 가진 짧은 수명의 credential을 쓰거나, outbound handler가 특정 host로 가는 요청에만 인증을 붙일 수 있어요. 패키지를 설치해야 한다면 registry host만 열고 임의의 외부 endpoint는 막을 수도 있어요. E2B 문서에서도 internet access는 기본적으로 가능하지만 allowInternetAccess, allow/deny list로 제한할 수 있는 항목으로 다뤄요. 작업마다 어떤 파일을 읽고 어떤 host로 나가며 어떤 artifact를 밖으로 꺼낼 수 있는지 명시해야 해요.

## 보존 기간과 종료 원인도 설계해야 한다

E2B 문서는 sandbox lifecycle을 create, connect, pause, resume, kill로 설명해요. 특히 pause는 filesystem뿐 아니라 memory까지 보존할 수 있어요. 실행 중인 process, loaded variable, in-memory data까지 이어갈 수 있어서 의존성 설치를 마친 workspace에서 후속 요청을 처리할 수 있어요.

```typescript
import { Sandbox } from "e2b";

const sandbox = await Sandbox.create({
  timeoutMs: 10 * 60 * 1000,
  lifecycle: {
    onTimeout: "pause",
    autoResume: true,
  },
});
```

그만큼 정리 정책도 필요해요. pause된 sandbox를 언제 kill할지, 같은 PR의 후속 요청에 재사용할지, merged 이후에도 artifact를 남길지 정해야 해요. memory까지 보존해야 하는지, filesystem-only snapshot이면 충분한지도 검토해야 하고요.

Modal 문서는 sandbox lifecycle에서 timeout, idle timeout, out-of-memory 같은 종료 원인을 별도 이벤트로 다뤄요. 에이전트 시스템에서도 “모델이 실패했다”와 “sandbox가 idle timeout으로 종료됐다”를 같은 실패로 저장하면 나중에 어디를 고쳐야 할지 찾기 어려워요.

간단한 라벨링, 자연어 파라미터 추출, 보고서 문장 다듬기처럼 파일시스템과 shell이 필요 없는 작업에는 sandbox가 과해요. cold start가 생기고 sandbox ID를 추적해야 하며 artifact cleanup 정책도 마련해야 하니까요.

sandbox가 prompt injection까지 막아 주는 것도 아니에요. “README에 적힌 명령을 그대로 실행하라”는 공격은 sandbox 안에서 피해 범위를 줄일 수 있어도, 그 행동이 잘못됐는지는 판단해 주지 않아요. 승인 단계, 정책 검사, eval, observability는 여전히 필요해요.

도입 기준은 에이전트가 실제로 실행까지 하는지예요. 코드를 읽고 요약만 한다면 sandbox가 필수는 아니에요. repo를 체크아웃하고 의존성을 설치해 테스트를 돌린 뒤 diff를 추출한다면 sandbox가 제품 경계가 돼요.

## 이대리에서 먼저 적용할 작업

이대리처럼 Slack에서 여러 LLM 에이전트를 호출하는 시스템이라고 해서 모든 모듈에 sandbox가 필요한 건 아니에요. 그날 할 일을 정리하거나 업무 로그 초안을 만드는 작업은 대부분 입력을 읽고 텍스트를 합성해요. shell execution이 없는 작업에 sandbox를 붙이면 구조만 복잡해져요.

반면 PR 리뷰, PR 영향 범위 분석, 문서와 코드의 불일치를 찾는 내부 점검은 repo checkout, diff 읽기, 테스트나 lint 실행, artifact 추출과 이어져요. 지금 CLI provider가 안전한 env에서 모델을 호출하는 데 집중한다면, 다음 단계에서는 모델이 제안한 확인 명령을 실행할 장소를 분리해야 해요. 에이전트 실행마다 sandbox ID를 붙이고 DB에는 실행 요약과 command metadata를, sandbox filesystem에는 checkout된 repo와 로그를 두는 방식이에요.

웹 페이지를 수집하는 crawler도 Puppeteer로 브라우저를 띄워 외부 사이트를 방문해요. 하지만 여기서 중요한 건 코드 생성 실행보다 browser isolation, network policy, crawl queue 안정성이에요. 단순 크롤링 격리를 위해 같은 boundary를 도입할지는 따로 검토해야 해요. 자연어 멘션 분류, 휴가 잔여 계산, 지원 기록 조회도 주로 DB read/write와 모델 호출의 문제라서 filesystem, package install, background process, preview URL이 핵심 요구는 아니에요.

첫 적용 범위는 PR 기반 작업의 “repo checkout → dependency install/test → diff/artifact extraction” 세 단계로 좁혀요. 모델 호출 자체가 아니라 모델이 근거를 만들기 위해 실행하는 부분이 대상이에요.

## 다음에 확인할 것

먼저 sandbox provider마다 “작업 하나당 실행 기록” 모델을 어떻게 잡을지 확인해야 해요. Cloudflare는 Workers·Durable Object·Containers와 잘 맞고, E2B는 coding agent lifecycle과 pause/resume이 강해요. Modal은 dynamic container execution과 파일 입출력, timeout 모델이 뚜렷해요. 어느 쪽이 맞는지는 기능 목록보다 현재 시스템을 어디에 배포했는지, queue worker를 어떻게 구성했는지에 더 크게 좌우돼요.

실패 코드도 설계해야 해요. MODEL_COMPLETION_FAILED 같은 모델 실패와 SANDBOX_CREATE_FAILED, SANDBOX_COMMAND_TIMEOUT, SANDBOX_OOM, SANDBOX_NETWORK_DENIED, SANDBOX_ARTIFACT_EXPORT_FAILED 같은 실행 환경 실패를 구분해야 재시도 여부와 사용자 안내, 후속 모델 호출을 각각 결정할 수 있어요.

## 참고한 출처

- https://developers.cloudflare.com/sandbox
- https://developers.cloudflare.com/agents/tools/sandbox
- https://developers.cloudflare.com/sandbox/guides/execute-commands/
- https://developers.cloudflare.com/sandbox/guides/manage-files/
- https://developers.cloudflare.com/sandbox/guides/outbound-traffic
- https://developers.cloudflare.com/sandbox/guides/background-processes
- https://developers.cloudflare.com/sandbox/api/commands
- https://e2b.dev/docs
- https://e2b.dev/docs/use-cases/coding-agents.md
- https://e2b.dev/docs/sandbox
- https://e2b.dev/docs/sandbox/persistence
- https://docs.e2b.dev/sandbox/auto-resume
- https://modal.com/docs/guide/sandboxes
- https://modal.com/docs/guide/sandbox-files
