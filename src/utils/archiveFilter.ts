import type { CollectionEntry } from "astro:content";

/**
 * 옛 글 표식. 목록·검색에서는 빼되 글 자체는 남겨 연도별 페이지에서 열리게 한다.
 * 2022년에 쓴 알고리즘 풀이·강의 필기가 여기 해당한다.
 */
const ARCHIVE_TAG = "archive";

export function isArchived(post: CollectionEntry<"posts">) {
  return post.data.tags.includes(ARCHIVE_TAG);
}
