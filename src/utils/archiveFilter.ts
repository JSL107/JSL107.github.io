/**
 * 화면에 보여주지 않는 관리용 태그. 거의 모든 옛 글에 붙어 있어 글을 구분해주지 못한다.
 * 태그 목록과 태그 페이지 생성이 같은 곳을 보므로, 여기서 빠지면 /tags/archive 도 만들지 않는다.
 */
export const NOISE_TAGS = new Set(["archive", "summary"]);

/** 독자에게 보여줄 주제 태그만 남긴다. */
export function topicTags(tags: string[]) {
  return tags.filter(tag => !NOISE_TAGS.has(tag));
}
