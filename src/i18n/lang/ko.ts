import type { UIStrings } from "../types";

export default {
  nav: {
    home: "홈",
    posts: "글",
    tags: "태그",
    about: "소개",
    archives: "연도별",
    search: "검색",
  },
  post: {
    publishedAt: "쓴 날",
    updatedAt: "고친 날",
    sharePostIntro: "이 글 공유하기:",
    sharePostOn: "{{platform}}에 공유하기",
    sharePostViaEmail: "메일로 공유하기",
    tagLabel: "태그",
    backToTop: "맨 위로",
    goBack: "돌아가기",
    editPage: "이 글 고치기",
    previousPost: "이전 글",
    nextPost: "다음 글",
  },
  pagination: {
    prev: "이전",
    next: "다음",
    page: "페이지",
  },
  home: {
    socialLinks: "연락처",
    featured: "먼저 읽어볼 글",
    recentPosts: "최근에 쓴 글",
    allPosts: "글 전체 보기",
  },
  footer: {
    // Footer 가 "{copyright} © {연도}" · "{allRightsReserved}" 로 조립한다.
    copyright: "JSL107",
    allRightsReserved: "글과 코드에 대한 권리는 글쓴이에게 있습니다.",
  },
  pages: {
    tagTitle: "태그",
    tagDesc: "이 태그가 붙은 글",

    tagsTitle: "태그",
    tagsDesc: "지금까지 쓴 글에 붙은 태그들입니다.",

    postsTitle: "글",
    postsDesc: "여기까지 쓴 글을 모아뒀습니다.",

    archivesTitle: "연도별 보기",
    archivesDesc: "쓴 순서대로 연도별로 묶어뒀습니다.",

    searchTitle: "검색",
    searchDesc: "찾고 싶은 글을 검색해보세요",
  },
  a11y: {
    skipToContent: "본문으로 건너뛰기",
    openMenu: "메뉴 열기",
    closeMenu: "메뉴 닫기",
    toggleTheme: "밝게/어둡게 바꾸기",
    searchPlaceholder: "글 검색...",
    noResults: "찾는 글이 없네요",
    goToPreviousPage: "이전 페이지로",
    goToNextPage: "다음 페이지로",
  },
  notFound: {
    title: "404 Not Found",
    message: "이 주소에는 아무것도 없습니다",
    goHome: "홈으로 돌아가기",
  },
} satisfies UIStrings;
