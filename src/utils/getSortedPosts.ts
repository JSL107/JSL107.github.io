import type { CollectionEntry } from "astro:content";
import { postFilter } from "./postFilter";
import { isArchived } from "./archiveFilter";

/**
 * 발행된 글 전부를 “마지막 갱신” 내림차순으로 준다(`modDatetime` 우선, 없으면 `pubDatetime`).
 * 초안·예약 글은 `postFilter()` 가 걸러낸다.
 *
 * 옛 글까지 포함하므로 **글 페이지를 만드는 곳**에서만 쓴다 — 목록은 `getSortedPosts()`.
 */
export function sortPosts(posts: CollectionEntry<"posts">[]) {
  return posts
    .filter(postFilter)
    .sort(
      (a, b) =>
        Math.floor(
          new Date(b.data.modDatetime ?? b.data.pubDatetime).getTime() / 1000
        ) -
        Math.floor(
          new Date(a.data.modDatetime ?? a.data.pubDatetime).getTime() / 1000
        )
    );
}

/**
 * 독자에게 보여줄 목록. 옛 글은 뺀다 — 홈·글 목록·RSS·태그가 전부 이 함수를 지나므로
 * 여기서 한 번 막으면 목록이 갈리지 않는다. 연도별 페이지는 `postFilter` 를 직접 써서 남는다.
 */
export function getSortedPosts(posts: CollectionEntry<"posts">[]) {
  return sortPosts(posts).filter(post => !isArchived(post));
}
