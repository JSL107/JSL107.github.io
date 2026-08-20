/**
 * 글 분류. 태그와 달리 글마다 하나만 붙는다.
 *
 * 값을 여기에 고정하는 이유는 글이 자동으로 올라오기 때문이다 — 자유 문자열로 두면
 * 발행할 때마다 새 이름이 지어져 분류가 난립한다. 여기 없는 값은 빌드가 막는다.
 * 키는 주소에 쓰는 슬러그, 값은 화면에 보이는 이름이다.
 */
export const CATEGORIES = {
  backend: "백엔드",
  web: "웹·네트워크",
  infra: "인프라·운영",
  note: "기록",
} as const;

export type CategoryId = keyof typeof CATEGORIES;

// zod 의 enum 은 비어 있지 않은 튜플을 요구한다.
export const CATEGORY_IDS = Object.keys(CATEGORIES) as [
  CategoryId,
  ...CategoryId[],
];

/**
 * 분류가 빠진 글이 목록에서 조용히 사라지지 않도록 두는 자리.
 * 화면에 "미분류" 로 보여야 빠진 것을 알아챈다.
 */
export const UNCATEGORIZED = "uncategorized";

export function categoryName(id: string) {
  return id in CATEGORIES ? CATEGORIES[id as CategoryId] : "미분류";
}
