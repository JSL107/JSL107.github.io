---
title: "Slack 웹 작업의 실패를 Browserbase 세션으로 추적하기"
description: "Slack 에이전트의 웹 작업에 Browserbase를 붙일 때 달라지는 실행 기록과 인증 관리, 먼저 검증할 항목을 살펴본다."
pubDatetime: 2026-11-19T19:46:00+09:00
category: web
---

Slack에서 웹 페이지 확인을 에이전트에게 맡길 때 어려운 건 Puppeteer 스크립트를 짜는 일보다 실패한 작업을 다시 살펴보는 일이에요. 이 글은 Browserbase 공식 문서와 Node SDK 저장소, changelog를 읽고 정리한 조사 글이에요. 직접 운영한 결과는 아니고, 현재 Puppeteer 기반 Slack 에이전트 시스템에 도입한다면 어떨지 살펴봅니다.

## 실패한 브라우저 작업을 다시 보기 어렵다

처음에는 작업을 큐에 넣고 워커가 Chromium을 띄워 셀렉터를 누른 다음, 결과를 메시지로 돌려주면 충분해 보여요. 하지만 로그인 화면에서 막힌 건지, MFA가 뜬 건지, 버튼이 iframe 안으로 옮겨간 건지, 프록시가 차단된 건지, 아니면 스크립트가 너무 빨리 닫힌 건지 로그만으로는 판단하기 어려워요.

로컬에서 Puppeteer를 실행하는 장점은 분명해요. 익숙한 코드를 쓸 수 있고 큐 워커에 붙이기 쉬우며 비용도 예측하기 쉬워요. 인증이 필요 없고 DOM 구조가 안정적인 공개 페이지라면 실패 후 재시도하거나 스크린샷 한 장을 남기는 것으로 충분할 수 있어요. 반면 내부 도구에 로그인하거나 특정 사용자 권한으로 보이는 화면을 읽는 작업에서 `TimeoutError` 한 줄만 남으면 운영자가 같은 상황을 다시 재현해야 해요.

로컬에서 브라우저를 띄우면 스크린샷, HTML, 콘솔 로그, 네트워크 로그를 어떻게 남길지 애플리케이션에서 직접 설계해야 해요. 잘 만들면 로컬도 충분히 강력하지만 대충 붙이면 실패 기록에 ‘그때 뭔가 안 됐다’는 말만 남아요.

사용자는 긴 로그를 읽고 싶어 하지 않아요. 운영자가 세션 영상을 보며 어느 탭에서 어떤 요청이 실패했는지 확인하고 필요하면 실행 중인 브라우저를 이어서 조작할 수 있어야 해요. 로컬 Puppeteer에서도 CDP를 다루면 일부 기능을 만들 수 있지만 그 기능들을 묶어 유지하는 데 비용이 들어요.

Browserbase를 볼 때 중요한 건 Puppeteer 스크립트가 짧아지는지가 아니에요. 실패한 Slack 작업을 다시 볼 수 있는지, 인증이 필요한 작업을 반복 가능한 상태로 만들 수 있는지, 작업 기록에 조사할 수 있는 식별자를 남길 수 있는지가 핵심이에요.

## Puppeteer 워커를 Browserbase 세션에 연결하기

Browserbase에 연결하는 첫 단계는 단순해요. `@browserbasehq/sdk`로 세션을 만들고 그 세션의 `connectUrl`에 `puppeteer-core`를 연결해요. 기존 Puppeteer 코드에서 로컬 Chromium을 `launch`하던 부분을 원격 브라우저에 `connect`하도록 바꾸는 셈이에요.

공식 Puppeteer quickstart에서는 아래와 같은 형태로 연결해요.

```typescript
import puppeteer from "puppeteer-core";
import Browserbase from "@browserbasehq/sdk";

const bb = new Browserbase({
  apiKey: process.env.BROWSERBASE_API_KEY,
});

(async () => {
  const session = await bb.sessions.create();
  console.log(`Session created, id: ${session.id}`);

  const browser = await puppeteer.connect({
    browserWSEndpoint: session.connectUrl,
  });

  const page = await browser.newPage();

  await page.goto("https://www.browserbase.com/", {
    waitUntil: "domcontentloaded",
  });

  const debugUrl = await bb.sessions.debug(session.id);
  console.log(
    `Session started, live debug accessible here: ${debugUrl.debuggerUrl}.`,
  );

  console.log("Taking a screenshot!");
  await page.screenshot({ fullPage: true });

  console.log("Shutting down...");
  await page.close();
  await browser.close();

  console.log(
    `Session complete! View recording at https://browserbase.com/sessions/${session.id}`,
  );
})();
```

큐 워커가 작업을 시작할 때 `session.id`를 받고, 실행 중에는 `debuggerUrl`을 얻고, 종료 후에는 `https://browserbase.com/sessions/{session.id}` 형태의 녹화 페이지를 남길 수 있어요. 사용자에게는 여전히 ‘작업 완료’나 ‘실패’ 메시지를 보내더라도, 운영자는 해당 세션을 조사할 수 있어요.

Browserbase 세션에는 브라우저뿐 아니라 실행 설정도 함께 담겨요. SDK 문서의 세션 생성 옵션에는 프록시, 리전, `keepAlive`, `timeout`, 확장 프로그램, 광고 차단, CAPTCHA 처리, 세션 녹화, 세션 로그, Verified, viewport, context, 사용자 메타데이터가 있어요. 모든 기능을 켜야 한다는 뜻은 아니에요. 작업이 어떤 조건에서 실행됐는지를 세션 설정으로 남길 수 있다는 점이 중요해요.

작업이 길다면 `timeout`과 `keepAlive`를 살펴봐야 하고 특정 지역에서만 로그인이 안정적이라면 프록시 geolocation을 살펴봐야 해요. 실패를 조사할 때도 ‘로컬 맥에서 돌린 Puppeteer’라는 기록보다 특정 리전, context, metadata를 가진 Browserbase session이 재현할 조건을 더 분명하게 보여줘요.

다만 세션 시간이 길어지고 녹화·로그·프록시를 쓰면 SaaS 비용과 보존 정책을 신경 써야 해요. 로컬 실행은 비용과 데이터 위치를 직접 통제하기 쉽고, Browserbase를 쓰려면 외부에서 실행하고 그 요금 체계를 받아들여야 해요.

## Context로 인증 상태 재사용하기

웹 자동화에서 로그인은 아이디와 비밀번호를 입력하는 것만으로 끝나지 않아요. MFA, magic link, passkey, 위치 기반 차단, bot detection, 세션 만료까지 함께 다뤄야 해요. Browserbase 문서는 인증 워크플로우에서 Contexts, Session Live View, proxies, Verified를 함께 언급해요. 그중 Slack 에이전트에 가장 직접적으로 닿는 건 Contexts예요.

Context는 Chromium user data directory를 세션 간에 재사용하는 기능이에요. 쿠키, `localStorage`, `IndexedDB`, `sessionStorage`, service worker, form data, browser preferences 같은 상태를 유지해요. 반면 브라우저 HTTP cache는 포함하지 않아요. 이미지, CSS, JavaScript, 폰트는 세션마다 네트워크에서 다시 가져오며 service worker가 자체적으로 캐시한 경우에만 로드 시간이 나아질 수 있어요. Context는 성능을 높이는 캐시보다 인증과 애플리케이션 상태를 저장하는 곳으로 봐야 해요.

공식 Context 사용 예시에서는 세션을 만들 때 context id와 `persist: true`를 넘겨요.

```typescript
import { Browserbase } from "@browserbasehq/sdk";

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });

// Use the context ID from the previous example
const contextId = "<context-id>";

const session = await bb.sessions.create({
  browserSettings: {
    context: {
      id: contextId,
      persist: true,
    },
  },
});

console.log("Session URL: https://browserbase.com/sessions/" + session.id);
```

이 코드는 Slack 에이전트에서 사용자별·도메인별 인증 프로필을 설계해야 한다는 신호이기도 해요. 여러 사용자가 같은 context를 공유하면 권한이 섞일 수 있고 한 사용자의 서로 다른 서비스 로그인을 한 context에 계속 넣으면 context가 커지거나 정책을 판단하기 어려워질 수 있어요. Browserbase 문서도 로그인 best practice에서 같은 Context를 여러 세션에 동시에 쓰지 말고, site/login 단위로 나누라고 안내해요.

MFA가 있는 서비스라면 사람이 한 번 개입하는 흐름이 현실적이에요. Browserbase의 Session Live View는 실행 중인 브라우저를 실시간으로 보면서 클릭하고 입력하고 스크롤할 수 있는 창이에요. 인증 문서에서도 새 세션을 만들고 Live View URL을 열어 사람이 로그인한 뒤, context id를 저장해 이후 세션에서 재사용하는 흐름을 권장해요.

Slack 에이전트에 붙인다면 처음 요청한 도메인에 인증 context가 없을 때 운영자나 사용자에게 Live View 링크를 건넬 수 있어요. 사람이 로그인과 MFA를 마치고 세션을 닫으면 이후 작업은 저장된 context id로 시작해요.

Browserbase 문서는 Context data에 저장된 credential과 browsing data가 포함될 수 있고 at rest에서 고유하게 암호화된다고 설명해요. 애플리케이션에서는 context id를 누가 만들었는지, 어느 도메인에 쓰는지, 언제 폐기할지 정책을 정해야 해요.

## 세션 ID로 녹화와 로그 찾기

Browserbase Observability의 Session Inspector에서는 완료된 세션을 `https://browserbase.com/sessions/{session.id}`에서 replay로 볼 수 있어요. 녹화는 최대 10개 탭까지 지원하고 재생 속도는 0.5x, 1x, 2x, 4x예요. 보존 기간도 작업 기록을 설계할 때 고려해야 해요. non-BYOS 프로젝트는 세션 종료 후 최대 31일, BYOS 프로젝트는 24시간 동안 보관하며 더 오래 보관하려면 그 기간 안에 MP4로 다운로드해야 해요.

실패 증거로 Browserbase 녹화 URL만 남기면 보존 기간이 지난 뒤에는 볼 수 없을 수 있어요. 장기 감사가 필요한 작업이라면 세션 ID와 함께 요약 로그, 핵심 스크린샷, 필요한 경우 다운로드한 녹화 파일의 보관 위치를 따로 남겨야 해요. 단기 디버깅이 목적이라면 기본 보존 기간만으로도 충분할 수 있어요.

Session Inspector에서는 영상 외에도 여러 정보를 볼 수 있어요. Status bar에는 세션 ID, 상태, 시작 시각, 리전, duration, proxy bandwidth, 설정, user metadata, extension id, expires가 표시돼요. Events view에는 페이지 로드, `Runtime.*`, `Page.*`, `Input.*`, `Log.*` 같은 CDP 이벤트와 네트워크 요청·응답이 들어 있어요. 콘솔 로그와 네트워크 로그도 화면에서 보거나 API로 가져올 수 있어요.

```bash
curl https://api.browserbase.com/v1/sessions/<session-id>/logs \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY"
```

Slack 에이전트의 실행 기록에 모든 CDP 로그를 저장할 필요는 없어요. 원본은 Browserbase에 두고 내부 기록에는 `browserSessionId`, `debuggerUrl`, `contextId`, `recordingUrl`, 필요하면 logs API를 다시 조회할 수 있는 권한 경로를 남기는 정도가 첫 단계로 적절해요. 네트워크 문제인지, DOM 변화인지, 인증 만료인지 판단해야 할 때 세션 ID에서 조사를 시작할 수 있어요.

## 이대리의 어떤 작업에 붙일 것인가

Browserbase는 로컬 Puppeteer와 비용 구조가 다른 실행 방식이에요. 인증 없는 공개 페이지 수집, 짧고 반복적인 HTML 파싱, 자체 인프라 안에서만 접근할 수 있는 페이지, 외부에 녹화를 저장하기 부담스러운 작업에는 로컬 실행이 더 나아요. 특히 민감한 화면이 녹화될 수 있다면 보존 기간과 접근 권한, 다운로드 정책을 먼저 정해야 해요.

반대로 로그인 상태를 반복해서 써야 하거나 실패 상황을 재현하기 어렵고, 사람이 중간에 개입할 가능성이 있거나 프록시와 브라우저 신호가 결과에 영향을 주는 작업이라면 Browserbase를 고려할 만해요. 로컬 Puppeteer에서 직접 CDP 로그와 HAR, 스크린샷, 영상을 남기는 방법도 있어요. 벤더 종속이 적고 데이터 위치를 통제하기 쉽지만 작업을 관찰하고 조사할 도구를 직접 만들어야 해요.

Browserbase Agents나 Stagehand처럼 더 높은 수준의 에이전트 기능도 있지만 이미 Puppeteer 스크립트와 큐 워커가 있다면 cloud browser session부터 도입하는 편이 자연스러워요. 기존 코드를 유지하면서 브라우저 실행 방식만 바꿔 실험할 수 있기 때문이에요.

이대리는 Slack의 자연어 요청을 담당 작업으로 넘기고, 백엔드의 큐와 워커로 실행 결과를 관리하는 시스템이에요. Browserbase가 가장 먼저 쓰일 곳은 단순 크롤러보다 Slack에서 위임한 웹 작업의 실행 증거를 남기는 부분이에요. 웹 페이지를 확인하는 워커가 실패했을 때 애플리케이션 로그와 에러 메시지에 더해 세션 ID, Live View 링크, 녹화 URL, context id를 남길 수 있어요.

그날 할 일 정리, PR 리뷰, 업무 로그 정리는 주로 GitHub, Slack, 저장소 diff, 사용자 입력을 다루므로 직접적인 도입 대상은 아니에요. 웹 페이지를 탐색하거나 지원 현황·공고·외부 페이지처럼 브라우저 상태가 필요한 작업이 후보예요. 공개 API나 HTML fetch로 충분한 작업은 그대로 두고, 로그인·동적 UI·사람 개입이 필요한 작업을 분리하는 편이 나아요.

도입 전에는 네 가지를 정해야 해요.

- 작업 기록에 Browserbase session id를 어떤 필드로 남길 것인가.
- context id를 사용자·도메인·권한 단위로 어떻게 격리할 것인가.
- 녹화 URL의 보존 기간이 지난 뒤에도 남아야 하는 증거는 무엇인가.
- 로컬 Puppeteer 실행면과 Browserbase 실행면을 작업별로 어떻게 선택할 것인가.

## 다음 실험

첫 실험에서는 기존 Puppeteer 워커 하나를 Browserbase 세션에서 실행하고 작업 기록에 `browserSessionId`, `debuggerUrl`, `contextId`, `recordingUrl` 네 가지를 남길 수 있는지 확인해요. 성공 기준은 작업이 더 똑똑해졌는지가 아니라, 실패했을 때 운영자가 같은 화면을 다시 볼 수 있는지예요.

두 번째 실험은 인증 context예요. 사람이 Live View로 한 번 로그인하고 세션이 끝난 뒤 몇 초 기다렸다가, 같은 context id로 새 세션을 열어 로그인 상태가 유지되는지 확인해야 해요. HTTP cache가 유지된다고 기대해서는 안 돼요. 쿠키와 애플리케이션 상태를 확인하면서 같은 context를 여러 세션에서 동시에 쓰지 않는 정책도 함께 검증해야 해요.

## 참고한 자료

- https://docs.browserbase.com/introduction
- https://docs.browserbase.com/introduction/puppeteer
- https://docs.browserbase.com/reference/sdk/nodejs
- https://docs.browserbase.com/features/contexts
- https://docs.browserbase.com/features/observability
- https://docs.browserbase.com/guides/authentication#use-the-session-live-view-to-log-in
- https://docs.browserbase.com/platform/browser/observability/session-live-view
- https://docs.browserbase.com/reference/api/session-logs
- https://github.com/browserbase/sdk-node
- https://www.browserbase.com/changelog
