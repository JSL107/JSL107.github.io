import type { CollectionEntry } from "astro:content";
import { getSortedPosts } from "./getSortedPosts";
import { UNCATEGORIZED } from "./categories";

/**
 * 목록에 보이는 글에서 분류를 뽑는다.
 *
 * 옛 글은 `getSortedPosts()` 가 이미 빼므로 분류에도 잡히지 않는다 — 목록과 분류가
 * 다른 기준을 보면 분류를 눌렀을 때 없는 글이 나온다.
 */
export function getUniqueCategories(posts: CollectionEntry<"posts">[]) {
  const seen = new Set<string>();
  for (const post of getSortedPosts(posts)) {
    seen.add(post.data.category ?? UNCATEGORIZED);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
