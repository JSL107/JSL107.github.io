---
layout: post
title: 직사각형 별찍기
image: algorithm.png
date: 2022-07-09 14:35:20 +0900
tags: [Summary, JAVA, algorithm]
categories: algorithm
---

# 직사각형 별찍기
## 문제 설명
이 문제에는 표준 입력으로 두 개의 정수 n과 m이 주어집니다.
별(*) 문자를 이용해 가로의 길이가 n, 세로의 길이가 m인 직사각형 형태를 출력해보세요.

## 제한 조건
n과 m은 각각 1000 이하인 자연수입니다.

### 예시
### 입력

```
5 3
```

### 출력

```
*****
*****
*****
```

### 풀이방식
a의 개수 만큼 * 을 출력 한 후 b의 개수 만큼 줄바꿈을 해주어야 하므로
*을 먼저 출력하고 그 후 줄바꿈 코드를 작성 해주는 방식으로 풀이하였다.

### 코드
```
import java.util.Scanner;

class Solution {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int a = sc.nextInt();
        int b = sc.nextInt();

        for (int indexB = 0; indexB < b; indexB++) {
            for (int indexA = 0; indexA < a; indexA++) {
                System.out.print("*");
            }
            System.out.println("");
        }
    }
}
```