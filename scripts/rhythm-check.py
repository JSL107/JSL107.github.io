#!/usr/bin/env python3
"""문장 호흡 지표 측정 + 원본 대비 사실 보존 검사.

사용법:
  python3 scripts/rhythm-check.py metrics <파일...>          지표만 출력
  python3 scripts/rhythm-check.py verify <ref> <파일...>      ref(git 리비전) 대비 사실 보존 검사
  python3 scripts/rhythm-check.py echo <파일...>             앞말에 이름표만 다시 붙인 문장 찾기

사실 보존 검사는 문체를 고쳐도 변하면 안 되는 것만 본다.
frontmatter, 헤딩 목록, 코드블록, 숫자, 영문 식별자, URL.
"""
import re
import subprocess
import statistics
import sys
from collections import Counter

# 해요체의 기본 종결. 이 어미가 10~20% 나오는 것은 자연스러워 신호가 아니다.
# 편중이 문제가 되는 쪽은 문장을 이어 붙일 때 습관적으로 붙는 연결형 종결이다.
PLAIN_ENDINGS = {'해요', '있어요', '돼요', '예요', '이에요', '없어요', '아니에요', '가요', '와요'}

CONNECTIVES = [
    '고 ', '며 ', '지만 ', '는데 ', '면서 ', '어서 ', '아서 ', '니까 ', '으니 ',
    '도록 ', '다가 ', '거나 ', '든지 ', '기에 ', '느라 ', '자마자', '라서 ', '으면서',
]


def split_parts(text):
    head, _, rest = text.partition('---\n')
    front, _, body = rest.partition('\n---\n')
    return front, body


def strip_code(body):
    return re.sub(r'(?s)```.*?```', '', body)


def sentences(body):
    prose = strip_code(body)
    prose = re.sub(r'(?m)^#.*$', '', prose)
    prose = re.sub(r'(?m)^-.*$', '', prose)
    return [s.strip() for s in re.split(r'(?<=\.)\s+', prose) if len(s.strip()) > 5]


# 앞말에 이름표만 다시 붙이는 문장. 새 사실을 더하지 않아 지워도 뜻이 그대로다.
#
# 정당한 설명과 무엇으로 가르는가 — 설명 대상이 백틱·따옴표로 감싼 기호이거나 처음 꺼낸
# 용어면 새 정보이므로 세지 않는다. 지시어로 앞 문장을 되받는 것만 남긴다.
# 넓게 잡았을 때는 발행본 11편에서 7건 중 5건이 오탐이었다(`rate: 1`의 뜻 풀이,
# 용어 정의 등 채점표 B-4가 오히려 요구하는 문장들). 아래 조건으로 좁히니 1건만 남았고
# 그 1건이 실제 메아리였다.
#
# 어휘 겹침으로는 잡히지 않는다. 같은 말을 다른 낱말로 하기 때문이다(실측 0건).
ECHO_PATTERNS = [
    (r'(이런|그런|이러한|그러한)\s*(뜻|의미|말|얘기|이야기)(이에요|예요|이죠|죠|입니다|이다)', '이런 뜻이에요'),
    (r'^(이게|그게|이것이|그것이)\s+[^`"\u201c]{0,16}(이에요|예요|입니다|이죠|죠)\s*$', '이게 ~예요'),
    (r'(인|한|된)\s*셈(이에요|예요|이죠|죠|입니다|이다)\s*$', '~인 셈이죠'),
    (r'^(즉|다시 말해|바꿔 말하면|요컨대)[ ,]', '즉/다시 말해'),
]
ECHO_DEFINING = re.compile(r'[`"\u201c\u201d\']|이 글에서|라고 부르|라고 해요|말하자면')


def echoes(path):
    body = split_parts(open(path, encoding='utf-8').read())[1]
    found = []
    for sentence in sentences(body):
        if ECHO_DEFINING.search(sentence):
            continue
        for pattern, name in ECHO_PATTERNS:
            if re.search(pattern, sentence):
                found.append((name, sentence))
                break
    return found


# 어미 계열. 있죠·하죠·되죠는 사람 귀에 같은 -죠로 들리는데,
# 낱말 그대로 세면 서로 다른 어미로 잡혀 편중이 보이지 않는다.
ENDING_FAMILIES = ('거든요', '더라고요', '잖아요', '고요', '네요', '죠')


def endings_of(sentence):
    found = re.search(r'([가-힣]{1,5})\.$', sentence)
    if not found:
        return ''
    word = found.group(1)
    for family in ENDING_FAMILIES:
        if word.endswith(family):
            return '-' + family
    return word


def metrics(path):
    body = split_parts(open(path, encoding='utf-8').read())[1]
    sents = sentences(body)
    lens = [len(s) for s in sents]
    clauses = [1 + s.count(',') + sum(s.count(c) for c in CONNECTIVES) for s in sents]
    endings = [e for e in (endings_of(s) for s in sents) if e]
    words = [len(s.split()) for s in sents]
    # 최빈 종결어미 집중도. '다양도'(종류 수)는 특정 어미가 몰리는 것을 못 잡는다.
    # 예: -고요 하나가 14%를 차지해도 종류가 많으면 다양도는 높게 나온다.
    marked = [e for e in endings if e not in PLAIN_ENDINGS]
    ranked = Counter(marked).most_common(1)
    top_share = ranked[0][1] / len(endings) if ranked and endings else 0
    top_name = ranked[0][0] if ranked else ''
    streak = sum(1 for i in range(len(sents) - 1)
                 if endings_of(sents[i]) == endings_of(sents[i + 1]) != ''
                 and endings_of(sents[i]) not in PLAIN_ENDINGS)
    return {
        'top_share': top_share,
        'top_name': top_name,
        'streak': streak,
        'n': len(sents),
        'words': statistics.mean(words),
        'avg': statistics.mean(lens),
        'sd': statistics.pstdev(lens),
        'clause': statistics.mean(clauses),
        'single': sum(1 for c in clauses if c == 1) / len(sents),
        'long': sum(1 for x in lens if x >= 70) / len(sents),
        'endings': len(set(endings)) / len(endings) if endings else 0,
    }


def facts(text):
    """문체를 바꿔도 변하면 안 되는 요소들."""
    front, body = split_parts(text)
    return {
        'frontmatter': front.strip(),
        'headings': re.findall(r'(?m)^#{2,3} .*$', body),
        'code': re.findall(r'(?s)```.*?```', body),
        'urls': sorted(re.findall(r'https?://[^\s)\'"]+', body)),
        'numbers': sorted(Counter(re.findall(r'\d[\d,.]*', strip_code(body))).items()),
        'idents': sorted(Counter(re.findall(r'[A-Za-z][A-Za-z0-9_./-]{2,}', strip_code(body))).items()),
    }


def verify(ref, path):
    original = subprocess.run(['git', 'show', f'{ref}:{path}'], capture_output=True, text=True, check=True).stdout
    before, after = facts(original), facts(open(path, encoding='utf-8').read())
    problems, notes = [], []
    for key in before:
        if before[key] != after[key]:
            if isinstance(before[key], list) and before[key] and isinstance(before[key][0], tuple):
                b, a = dict(before[key]), dict(after[key])
                # 토큰이 통째로 사라지거나 새로 생긴 것만 사실 손실로 본다.
                # 빈도만 줄어든 것은 동어반복 제거라 문체 수정에서 정상이다.
                gone = sorted(set(b) - set(a))
                new_tokens = sorted(set(a) - set(b))
                if gone or new_tokens:
                    problems.append(f'{key}: 소실 {gone[:6]} / 신규 {new_tokens[:6]}')
                else:
                    thinned = [(k, b[k], a[k]) for k in b if a[k] != b[k]]
                    if thinned:
                        notes.append(f'{key}: 반복만 감소 {thinned[:6]}')
            else:
                problems.append(f'{key}: {len(before[key])}개 -> {len(after[key])}개')
    return problems, notes


def main():
    mode = sys.argv[1]
    if mode == 'metrics':
        print(f"{'파일':<40}{'문장':>5}{'어절':>7}{'절/문':>6}{'홑문장':>6}{'최빈(연결형)':>14}{'연속':>5}")
        for path in sys.argv[2:]:
            m = metrics(path)
            name = path.split('/')[-1].replace('.md', '')[:44]
            flag = '' if 11.0 <= m['words'] <= 13.0 else ('  어절높음' if m['words'] > 13.0 else '  어절낮음')
            if m['top_share'] > 0.12 or m['streak'] > 0:
                flag += '  어미편중'
            top = f"{m['top_name']} {m['top_share'] * 100:.0f}%"
            print(f"{name[:38]:<40}{m['n']:>5}{m['words']:>7.1f}{m['clause']:>6.2f}"
                  f"{m['single'] * 100:>5.0f}%{top:>14}{m['streak']:>5}{flag}")
        return 0
    if mode == 'verify':
        ref, failed = sys.argv[2], False
        for path in sys.argv[3:]:
            problems, notes = verify(ref, path)
            name = path.split('/')[-1]
            if problems:
                failed = True
                print(f'[깨짐] {name}')
                for p in problems:
                    print(f'    {p}')
            else:
                print(f'[보존] {name}')
            for n in notes:
                print(f'    (확인) {n}')
        return 1 if failed else 0
    if mode == 'echo':
        hit = False
        for path in sys.argv[2:]:
            found = echoes(path)
            name = path.split('/')[-1]
            if not found:
                continue
            hit = True
            print(f'[메아리] {name} ({len(found)}건)')
            for kind, sentence in found:
                print(f'    [{kind}] {sentence[:76]}')
        if not hit:
            print('[없음] 앞말을 되풀이하는 문장이 없다')
        return 1 if hit else 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main())
