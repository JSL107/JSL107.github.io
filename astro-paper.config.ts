import { defineAstroPaperConfig } from "./src/types/config";

export default defineAstroPaperConfig({
  site: {
    url: "https://jsl107.github.io/",
    title: "JSL107's Tech Note",
    description:
      "AI 에이전트와 백엔드 서버를 만들며 부딪힌 문제와, 틀렸다가 알아낸 것을 적습니다.",
    author: "JSL107",
    profile: "https://github.com/JSL107",
    ogImage: "default-og.jpg",
    lang: "ko",
    timezone: "Asia/Seoul",
    dir: "ltr",
  },
  posts: {
    perPage: 8,
    // 홈은 카드를 두 장씩 나란히 놓는다 — 홀수면 마지막 줄 오른쪽이 빈 칸으로 남는다.
    perIndex: 6,
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
