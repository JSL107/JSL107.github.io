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

/**
 * 화면에 보여주지 않는 관리용 태그. 거의 모든 옛 글에 붙어 있어 글을 구분해주지 못한다.
 * (태그 페이지 자체는 살아 있으므로 /tags/archive 로 들어가면 여전히 볼 수 있다.)
 */
export const NOISE_TAGS = new Set([ARCHIVE_TAG, "summary"]);

/** 독자에게 보여줄 주제 태그만 남긴다. */
export function topicTags(tags: string[]) {
  return tags.filter(tag => !NOISE_TAGS.has(tag));
}
