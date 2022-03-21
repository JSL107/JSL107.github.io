---
layout: post
title: "Prime-Number"
date: 2022-03-21 22:49:18 +0900
image: algorithm.png
tags: [Summary, JAVA, algorithm]
categories: algorithm
---
# Prime-Number

# 소수 찾기
**문제 설명**
1부터 입력받은 숫자 n 사이에 있는 소수의 개수를 반환하는 함수, solution을 만들어 보세요.
소수는 1과 자기 자신으로만 나누어지는 수를 의미합니다.(1은 소수가 아닙니다.)

### 제한 조건
- n은 2이상 1000000이하의 자연수입니다.

### 입출력 예
[제목 없음](https://www.notion.so/bbcc22f1f6af4319bee1b92cfbc5501d)

### 입출력 예 설명
입출력 예 #11부터 10 사이의 소수는 [2,3,5,7] 4개가 존재하므로 4를 반환
입출력 예 #21부터 5 사이의 소수는 [2,3,5] 3개가 존재하므로 3를 반환

### 반복문과 조건문을 이용한 소수 구하기
```java
int count=0;
          for(int i=2; i<=100; i++) // 1은 소수가 아니므로 2부터 시작
          {
              for(int j=2; j<=i; j++)
              {
                   if(i%j ==0) 
                   {
                        count ++;
                   }    
              }
          
              // 소수는 1과 자기자신으로만 나눠지므로 자기자신으로 한번만 나눠질때 소수
              if(count==1)
              {
                   System.out.print(i+" ");
              }
              count=0;
          }

```

```
(실행 결과)
2 3 5 7 11 13 17 19 23 29 31 37 41 43 47 53 59 61 67 71 73 79 83 89 97
```

### 에라토스테네스의 체
![sosu.gif](https://s3-us-west-2.amazonaws.com/secure.notion-static.com/8c99dd94-cdc0-4346-8a74-09edead82193/sosu.gif)

에라토스테네스의 체는 가장 먼저 소수를 판별할 범위만큼 배열을 할당하여, 해당하는 값을 넣어주고, 이후에 하나씩 지워나가는 방법을 이용한다.
1. 배열을 생성하여 초기화한다.
2. 2부터 시작해서 특정 수의 배수에 해당하는 수를 모두 지운다.(지울 때 자기 자신은 지우지 않고, 이미 지워진 수는 건너뛴다.)
3. 2부터 시작하여 남아있는 수를 모두 출력한다.

```java
public class Solution {

    public int solution(int n) {

        int[] prime = new int[n + 1];
        int answer = 0;

        // 소수가 아니라면 0, 0과 1은 소수가 아니므로 0
        prime[0] = prime[1] = 0;

        for (int i = 2; i <= n; i++) {
            prime[i] = i; // 2부터 소수를 구하고자 하는 구간의 모든 수 나열
        }
        for (int i = 2; i < n; i++) {
            if (prime[i] == 0) {
                continue; // 소수가 아니라면 continue
            }
            for (int j = 2 * i; j <= n; j += i) {
                prime[j] = 0; // 소수의 배수는 소수를 약수로 가지므로 제외
            }
        }

        // 소수 개수 구하기
        for (int i = 0; i < prime.length; i++) {
            if (prime[i] != 0) {
                answer++;
            }
        }
        return answer;
    }
}
```