import type { CollectionEntry } from "astro:content";

/** 2018~2022년 옛 글에 붙는 태그. 메인·글 목록에서만 빼고 지난 글·태그·검색에는 그대로 남는다. */
export const ARCHIVE_TAG = "archive";

export function isArchived(post: CollectionEntry<"posts">) {
  return post.data.tags.includes(ARCHIVE_TAG);
}

/** 지난 글을 걸러낸 목록. 최근 글이 옛 강의 필기에 묻히지 않게 하는 용도. */
export function excludeArchived(posts: CollectionEntry<"posts">[]) {
  return posts.filter(post => !isArchived(post));
}
