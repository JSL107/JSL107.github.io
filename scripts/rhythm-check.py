#!/usr/bin/env python3
"""문장 호흡 지표 측정 + 원본 대비 사실 보존 검사.

사용법:
  python3 scripts/rhythm-check.py metrics <파일...>          지표만 출력
  python3 scripts/rhythm-check.py verify <ref> <파일...>      ref(git 리비전) 대비 사실 보존 검사

사실 보존 검사는 문체를 고쳐도 변하면 안 되는 것만 본다.
frontmatter, 헤딩 목록, 코드블록, 숫자, 영문 식별자, URL.
"""
import re
import subprocess
import statistics
import sys
from collections import Counter

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


def metrics(path):
    body = split_parts(open(path, encoding='utf-8').read())[1]
    sents = sentences(body)
    lens = [len(s) for s in sents]
    clauses = [1 + s.count(',') + sum(s.count(c) for c in CONNECTIVES) for s in sents]
    endings = [m.group(1) for m in (re.search(r'([가-힣]{1,4})\.$', s) for s in sents) if m]
    words = [len(s.split()) for s in sents]
    return {
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
        print(f"{'파일':<44}{'문장':>5}{'어절':>7}{'절/문':>7}{'홑문장':>7}{'자수':>7}{'어미':>7}")
        for path in sys.argv[2:]:
            m = metrics(path)
            name = path.split('/')[-1].replace('.md', '')[:44]
            flag = '' if 11.0 <= m['words'] <= 13.0 else ('  높음' if m['words'] > 13.0 else '  낮음')
            print(f"{name:<44}{m['n']:>5}{m['words']:>7.1f}{m['clause']:>7.2f}"
                  f"{m['single'] * 100:>6.0f}%{m['avg']:>7.1f}{m['endings'] * 100:>6.0f}%{flag}")
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
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main())
