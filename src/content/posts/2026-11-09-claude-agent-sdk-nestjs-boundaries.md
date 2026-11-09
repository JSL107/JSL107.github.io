---
title: "Claude Agent SDK를 NestJS에 넣기 전에 볼 경계"
description: "Claude Agent SDK가 CLI 래핑에서 줄여 주는 코드와 NestJS 애플리케이션에 남는 권한·세션·배포 책임을 살펴본다."
pubDatetime: 2026-11-09T19:47:00+09:00
category: backend
---

Slack에서 PR 리뷰를 요청하면 백엔드 에이전트가 명령을 받았다고 응답해요. 이어 GitHub에서 diff를 읽고 리뷰 진행 상황을 갱신한 뒤 결과를 Slack thread에 남겨요. 이 글에서는 Claude Agent SDK for TypeScript 공식 문서와 공식 GitHub 저장소를 바탕으로, 이 흐름에 SDK를 넣으면 어떤 코드가 줄고 어떤 책임이 남는지 살펴봐요. NestJS 프로젝트에 실제로 붙여 부하나 장애 사례까지 검증한 글은 아니에요.

## CLI를 감싸는 코드는 에이전트가 커질수록 애플리케이션 로직이 된다

코딩 에이전트의 일은 한 번의 HTTP 요청처럼 끝나지 않아요. 파일을 읽고 명령을 실행하다가 중간에 판단을 바꾸기도 하고 때로는 오래 걸려요. Claude CLI나 Codex CLI를 감싸면 프롬프트를 stdin으로 보내고 stdout을 모아 파싱한 뒤 exit code로 실패를 처리할 수 있어요. 하지만 Slack 사용자에게 “읽는 중”, “리뷰 중”, “완료”를 보여 주려면 애플리케이션이 실행 중간에 나오는 신호까지 이해해야 해요.

stdout은 애플리케이션 프로토콜이 아니에요. 사람이 읽기 좋은 출력은 버전이 바뀌면 형식도 바뀔 수 있어요. 인증 실패, 쿼터 소진, 도구 실행 실패, 모델 응답 형식 실패가 모두 문자열로 들어오면 NestJS provider에서 예외를 분류하는 코드도 커져요.

Claude Agent SDK를 쓰면 이 경계가 달라져요. [공식 SDK 문서](https://docs.anthropic.com/en/docs/claude-code/sdk)에 따르면 `@anthropic-ai/claude-agent-sdk`의 핵심인 `query()`는 Claude Code의 agent loop를 실행하고 결과를 `AsyncGenerator<SDKMessage, void>` 형태로 돌려줘요. 터미널 출력을 해석하는 대신 타입이 있는 메시지 스트림을 소비하는 방식이에요.

```typescript
function query({
  prompt,
  options
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

Slack 명령을 처리하는 NestJS handler는 `for await` 루프에서 메시지가 올 때마다 진행 응답을 갱신할 수 있어요. CLI 프로세스의 stdout chunk를 의미 있는 단위로 다시 나누는 코드도 줄어들 수 있어요.

## 모델 API SDK가 아니라 Claude Code 런타임에 가깝다

Claude Agent SDK는 messages API를 직접 호출하는 코드보다 Claude Code CLI를 프로세스로 띄워 자동화하는 코드와 비교하는 편이 맞아요. 공식 overview는 tool loop를 직접 구현하지 않고 에이전트를 만들 때는 Agent SDK, 터미널에서 대화형으로 개발할 때는 Claude Code CLI, API와 tool loop를 직접 다룰 때는 Client SDK, 호스팅된 환경에서 장기 실행 에이전트를 돌릴 때는 Managed Agents를 쓰도록 선택지를 나눠요. Agent SDK는 모델 호출만 감싸는 클라이언트가 아니에요. Claude Code의 파일 읽기·수정, 명령 실행, MCP, hook, permission, session 같은 런타임 기능을 애플리케이션 안으로 가져와요.

| 선택지 | 얻는 것 | 내주는 것 |
| --- | --- | --- |
| CLI 직접 래핑 | 기존 Claude Code 사용 흐름과 가깝다 | stdout 파싱, 프로세스 제어, 에러 분류가 커진다 |
| Client SDK 직접 구현 | tool loop와 보안 정책을 완전히 소유한다 | 파일·Bash·세션 루프를 직접 설계해야 한다 |
| Agent SDK | Claude Code 런타임을 코드에서 호출하고 typed stream을 받는다 | native binary, 인증, 세션 저장 정책을 새로 검증해야 한다 |
| Managed Agents | 샌드박스와 장기 실행 인프라 부담을 줄인다 | 자체 NestJS 런타임 안에서 세밀하게 엮는 구조와는 거리가 있다 |

NestJS 멀티 에이전트 시스템에서 PR 리뷰 워커에는 읽기 도구만 필요하지만 코드 수정 워커에는 파일 편집 도구가 필요해요. 운영 상태를 요약하는 워커는 외부 데이터를 조회해야 해도 로컬 파일을 수정할 필요는 없을 수 있어요. 모델 API만 쓰면 이런 차이를 tool loop로 직접 구현해야 하고 CLI를 감싸면 CLI 바깥에서 통제해야 해요. Agent SDK는 Claude Code의 도구 모델을 쓰면서 TypeScript 옵션으로 워커별 범위를 좁힐 수 있게 해요.

## 권한 옵션은 워커별 역할을 코드로 나누게 해준다

[공식 permission 문서](https://docs.anthropic.com/en/docs/claude-code/sdk/permissions)는 `allowedTools`, `disallowedTools`, `permissionMode`, `canUseTool`, hook을 중심으로 도구 실행 여부를 결정한다고 설명해요. TypeScript 옵션에는 읽기 도구만 허용하고 묻지 않는 모드로 실행하는 예시가 나와요.

```javascript
const options = {
  allowedTools: ["Read", "Glob", "Grep"],
  permissionMode: "dontAsk"
};
```

이 설정은 읽기만 해야 하는 PR 리뷰에 맞아요. diff와 관련 파일을 읽어 판단하되 파일을 고치거나 Bash를 마음대로 실행하지 않게 하는 거예요. Slack에서 리뷰를 요청한 사용자는 보통 작업 디렉터리까지 수정해 달라는 뜻으로 요청한 게 아니니까요.

코드 수정 워커에는 `Edit`이나 `Write`가 필요할 수 있지만 그렇다고 모든 도구를 열 필요는 없어요. permission 문서에는 `disallowed_tools=["Bash"]`처럼 Bash 자체를 숨기는 방법과 `disallowed_tools=["Bash(rm *)"]`처럼 특정 패턴을 막는 방법이 나와요. `mcp__*`나 `mcp__github__get_*` 같은 MCP 도구 glob 예시도 있어요. 다만 `Bash(rm *)`가 `/bin/rm` 같은 변형까지 반드시 잡는 것은 아니에요.

기존 CLI provider가 맡던 보안 책임 중 일부는 SDK 옵션으로 옮길 수 있어요. 읽기 전용 리뷰 워커의 허용 도구, 운영 조회 워커의 MCP 조회 권한, 코드 수정 워커의 편집 권한을 명시하는 식이에요. 하지만 위험 명령 차단, 작업 디렉터리 격리, 임시 HOME, 인증 파일 분리, 민감 경로 차단은 여전히 기존 프로세스 래퍼와 애플리케이션의 책임이에요. SDK의 deny rule이나 Bash 패턴 차단을 보안 샌드박스로 취급할 수는 없어요.

## 세션은 Slack thread와 맞지만 정책이 필요하다

사용자가 “아까 리뷰에서 말한 두 번째 항목만 고쳐줘”라고 하면 이전 대화와 파일 탐색 맥락이 필요해요. [세션 문서](https://docs.anthropic.com/en/docs/claude-code/sdk/sessions)에 따르면 TypeScript에서는 `continue: true`로 최근 세션을 이어가거나, 특정 세션 ID를 `resume`으로 다시 열 수 있어요. 원본을 보존하면서 `fork`로 갈라지는 것도 가능하고 세션을 저장하지 않으려면 `persistSession: false`를 둘 수 있어요.

공식 TypeScript 예시에서는 첫 번째 질의가 세션을 만들고, 두 번째 질의가 `continue: true`로 가장 최근 세션을 이어가요.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// First query: creates a new session
try {
  for await (const message of query({
    prompt: "Analyze the auth module",
    options: { allowedTools: ["Read", "Glob", "Grep"] }
  })) {
    if (message.type === "result" && message.subtype === "success") {
      console.log(message.result);
    }
  }
} catch (error) {
  console.error(`Session ended with an error: ${error}`);
}

// Second query: continue: true resumes the most recent session
for await (const message of query({
  prompt: "Now refactor it to use JWT",
  options: {
    continue: true,
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"]
  }
})) {
  console.log(message);
}
```

“가장 최근 세션”은 개발자 로컬에서는 편하지만 Slack 멀티 유저 환경에 그대로 적용하기는 어려워요. thread별, 사용자별, 작업별로 어떤 세션을 이어갈지 정하지 않으면 한 사용자의 코드 리뷰 맥락이 다른 사용자의 작업에 섞일 수 있어요.

실패한 실행을 다시 돌려 비교하는 보고서 생성이나 평가 작업이라면 이전 세션이 섞이지 않도록 `persistSession: false`를 고려할 수 있어요. 장기 코드 수정이나 같은 PR에 관한 후속 질문에는 `resume`이나 `fork`가 실용적이에요. 워커 종류에 따라 세션 정책을 나눠야 해요.

## 도입 비용은 패키지 설치보다 런타임 확인에 있다

설치는 간단해요.

```bash
npm install @anthropic-ai/claude-agent-sdk
```

[TypeScript SDK 문서](https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-typescript)에 따르면 SDK는 native Claude Code CLI binary를 platform-specific optional dependency로 찾아요. `@anthropic-ai/claude-agent-sdk-darwin-arm64`, `@anthropic-ai/claude-agent-sdk-linux-x64`, `@anthropic-ai/claude-agent-sdk-win32-x64` 같은 패키지가 빠졌거나 플랫폼이 맞지 않으면 native binary를 찾지 못할 수 있어요. 이때는 `pathToClaudeCodeExecutable`로 `claude` 실행 파일 경로를 지정할 수 있어요.

로컬 macOS에서 잘 돌아가도 Linux 컨테이너에서는 optional binary가 빠질 수 있고 패키지 매니저가 optional dependency 설치를 건너뛸 수도 있어요. Bun 단일 실행 파일 같은 빌드에는 `extractFromBunfs()` 처리가 필요할 수 있어요. 배포 타깃에서 native binary를 찾는지, 인증은 어떻게 주입하는지, 세션 파일은 어디에 쓰는지 확인해야 해요.

기존 라우팅 정책과의 관계도 살펴봐야 해요. ChatGPT를 primary로 두고 Claude를 fallback이나 특정 워커에 쓰는 구조라면 Agent SDK 도입은 단순한 provider 교체로 끝나지 않아요. Claude Code 런타임의 도구와 세션 모델이 들어오므로 워커별 모델 선택뿐 아니라 런타임 권한도 나눠야 해요.

[공식 저장소 README](https://github.com/anthropics/claude-agent-sdk-typescript)는 SDK를 쓸 때 코드 수락·거절 같은 usage data, 관련 conversation data, `/bug` 명령으로 제출한 사용자 피드백 등이 수집될 수 있다고 설명하고 [data usage 문서](https://docs.anthropic.com/en/docs/claude-code/data-usage)를 안내해요. 민감한 업무 데이터나 비공개 운영 로그를 다루는 에이전트라면 별도로 검토해야 해요.

## 내 시스템에서는 PR 리뷰부터 작게 본다

가장 잘 맞는 후보는 코드를 읽거나 고치는 워커예요. PR 리뷰 워커를 읽기 도구만 허용한 `query()` 스트림으로 바꾸면 stdout 파싱 코드 일부를 줄이고 메시지 스트림에 맞춰 Slack 진행 응답을 보낼 수 있어요. 파일을 수정해야 하는 작업은 별도 워커로 분리해 `Edit`, `Write` 권한을 가진 실행 경로에 둬요.

그날 할 일이나 주간 업무 로그를 만드는 워커는 GitHub 이슈, 전날 계획, 사용자 메모를 합치는 일이 중심이에요. Claude Code의 파일 도구나 Bash 실행이 핵심은 아니어서 기존 모델 API나 CLI provider가 더 단순할 수 있어요. SDK를 쓰더라도 `disallowedTools: ["*"]`에 가까운 형태라면 런타임을 들여오는 이점이 줄어요.

운영 상태 조회가 결정론적인 DB query로 “승인 대기”, “진행 중”, “실패 미해소”를 보여 주는 작업이라면 LLM 도구 루프보다 명확한 query와 formatter가 맞아요. 반면 내부 문서 수정안을 만들거나 코드 변경과 문서 변경의 불일치를 찾는 워커는 파일을 읽고 grep하며 필요할 때 수정안도 만들어야 하므로 후보가 될 수 있어요.

## 다음 실험은 책임 경계를 확인한다

첫 번째 실험은 PR 리뷰 워커를 읽기 전용으로 감싸는 거예요. `allowedTools: ["Read", "Glob", "Grep"]`, `permissionMode: "dontAsk"`, 가능하면 `persistSession: false`를 설정하고 기존 CLI provider와 같은 입력을 넣어요. 답변 품질과 함께 Slack 진행 메시지를 몇 단계로 나눌 수 있는지, 실패가 어떤 message type과 exception으로 드러나는지, 기존 stdout 파서에서 어떤 코드를 지울 수 있는지 비교해야 해요.

두 번째 실험은 코드 수정 워커 대신 수정 계획 워커로 시작해요. plan 성격의 모드와 읽기 도구만으로 변경 계획을 만들고, 사람이 승인한 뒤 별도 경로에서 편집 권한을 열어요. 이 과정에서 stdout chunk 병합, 완료 결과 파싱, 세션 ID 추적에 쓰던 코드가 얼마나 줄어드는지 살펴볼 수 있어요. 위험 명령 차단, 작업 디렉터리 격리, 민감 파일 deny rule처럼 계속 남는 책임도 확인해야 해요.
