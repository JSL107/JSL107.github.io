# jsl107.github.io

이준석 개발 블로그. [AstroPaper](https://github.com/satnaing/astro-paper) 테마를 기반으로 한 Astro 정적 사이트.

## 글 쓰기

`src/content/posts/` 에 마크다운 파일을 만든다. 파일명이 그대로 주소가 된다.

```markdown
---
title: "글 제목"
description: "검색 결과와 미리보기에 나오는 한 줄 소개"
pubDatetime: 2026-08-14T21:00:00+09:00
tags: ["nestjs", "postgres"]
---

본문
```

- `description` 은 **필수**다. 빠지면 빌드가 실패한다.
- 이미지는 `public/images/` 에 두고 본문에서 `/images/파일명` 으로 참조한다.
- `featured: true` 를 붙이면 첫 화면 맨 위 "먼저 읽어볼 글" 에 올라간다.
- `draft: true` 면 빌드에서 제외된다.

### 지난 글 (아카이브)

2018~2022년 글에는 `archive` 태그가 붙어 있다. 이 태그가 붙은 글은 첫 화면과 `/posts` 목록에서 빠지고, `/archives` · 태그 페이지 · 검색에는 그대로 나온다. 규칙은 [src/utils/archiveFilter.ts](src/utils/archiveFilter.ts) 에 있다.

## 로컬에서 보기

```bash
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # 타입 검증 + 빌드 + 검색 색인 생성
```

Node 22 이상 필요.

## 배포

`main` 에 push 하면 [GitHub Actions](.github/workflows/deploy.yml) 가 빌드해서 GitHub Pages 에 올린다. 공개 저장소라 Actions 사용량은 무료다.

> 저장소 설정 → Pages → Source 가 **GitHub Actions** 로 되어 있어야 한다. (Deploy from a branch 로 되어 있으면 옛 Jekyll 방식으로 동작해 빌드 결과가 반영되지 않는다.)

## 설정

사이트 제목·소개·연락처·기능 토글은 [astro-paper.config.ts](astro-paper.config.ts) 한 곳에 모여 있다. 화면에 보이는 한국어 문구는 [src/i18n/lang/ko.ts](src/i18n/lang/ko.ts) 에 있다.
