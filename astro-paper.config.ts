import { defineAstroPaperConfig } from "./src/types/config";

export default defineAstroPaperConfig({
  site: {
    url: "https://jsl107.github.io/",
    title: "이준석 개발 블로그",
    description:
      "백엔드 개발자 이준석의 블로그. 서버를 만들다 부딪힌 문제와, 틀렸다가 알아낸 것들을 적습니다.",
    author: "이준석",
    profile: "https://github.com/JSL107",
    ogImage: "default-og.jpg",
    lang: "ko",
    timezone: "Asia/Seoul",
    dir: "ltr",
  },
  posts: {
    perPage: 8,
    perIndex: 5,
    scheduledPostMargin: 15 * 60 * 1000,
  },
  features: {
    lightAndDarkMode: true,
    dynamicOgImage: true,
    showArchives: true,
    showBackButton: true,
    editPost: {
      enabled: true,
      url: "https://github.com/JSL107/JSL107.github.io/edit/main/",
    },
    search: "pagefind",
  },
  socials: [
    { name: "github", url: "https://github.com/JSL107" },
    { name: "mail", url: "mailto:juneseok81@gmail.com" },
  ],
  shareLinks: [
    { name: "x", url: "https://x.com/intent/post?url=" },
    { name: "facebook", url: "https://www.facebook.com/sharer.php?u=" },
    { name: "mail", url: "mailto:?subject=이 글 좀 보세요&body=" },
  ],
});
