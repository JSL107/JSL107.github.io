---
title: "nginx reverse proxy는 그대로, Kubernetes는 Gateway API로"
description: "단독 nginx의 reverse proxy는 여전히 유효하지만, Kubernetes에서는 ingress-nginx 은퇴에 맞춰 Gateway API로 단계적으로 전환해야 한다."
pubDatetime: 2026-09-07T09:00:00+09:00
category: infra
---

>

2026년 3월, 그동안 커뮤니티가 관리해 온 [ingress-nginx 컨트롤러가 유지보수와 보안 업데이트를 멈췄어요](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/). 쿠버네티스에서 외부 트래픽을 클러스터 안으로 들여보낼 때 가장 많이 쓰던 도구가 사실상 수명을 다한 셈이에요.

그래서 "nginx로 게이트웨이를 한다"는 익숙한 말도 이때부터 서로 다른 두 가지 이야기를 가리키게 됐어요. 하나는 VM이나 단독 컨테이너에 nginx를 직접 띄워 쓰는 경우예요. 여기서 reverse proxy, 그러니까 클라이언트의 요청을 대신 받아 뒤쪽 서버로 넘겨주는 중계 역할은 10년 전과 거의 달라지지 않았어요.

다른 하나는 쿠버네티스 클러스터 안에서 돌아가는 nginx예요. 이쪽은 사정이 달라요. 기존 방식인 Ingress에서 새 표준인 Gateway API로 넘어가는 흐름은 이제 선택의 문제만으로 볼 수 없게 됐어요.

이 글에서는 헷갈리기 쉬운 두 축을 따로 떼어 정리해 볼게요.

>

## 단독 nginx: reverse proxy가 실제로 하는 일

서버 한 대에 nginx를 올려놓고 "게이트웨이 역할을 한다"고 할 때 실제로 벌어지는 일은 생각보다 단순해요. 들어온 요청을 뒤쪽 서버, 흔히 upstream이라고 부르는 곳으로 넘기면서 원래 요청 정보를 잃지 않도록 챙기고, 느린 연결을 흡수하며, 뒤쪽 서버 하나가 죽으면 알아서 제외하는 게 거의 전부예요.

설정으로 옮기면 이렇게 돼요.

```plain text
upstream backend {
    least_conn;                          # 연결 수가 가장 적은 서버로 — 요청 처리시간 편차가 클 때 유리
    server 10.0.0.11:8080 max_fails=3 fail_timeout=10s;
    server 10.0.0.12:8080 max_fails=3 fail_timeout=10s;
    keepalive 32;                        # upstream 연결 재사용 — 매 요청 TCP 핸드셰이크 방지
}

server {
    location /api/ {
        proxy_pass http://backend/;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 2s;         # 백엔드에 연결 거는 한계
        proxy_read_timeout    30s;        # 응답을 기다리는 한계 — 기본값 60s는 대개 너무 길다
        proxy_next_upstream   error timeout http_502;  # 실패하면 다음 서버로
        proxy_buffering on;               # 느린 클라이언트와 백엔드를 분리
    }
}
```

### 헤더 보존: 누가 보냈는지 잃어버리지 않기

proxy_pass로 요청을 뒤쪽에 한 번 더 넘기는 순간, 뒤쪽 서버에는 진짜 클라이언트가 아니라 nginx가 요청을 보낸 것처럼 보여요. 원래 누가 어떤 IP에서 접속했는지, http로 들어왔는지 https로 들어왔는지 같은 정보가 그대로 사라진다는 뜻이에요.

그래서 Host나 X-Forwarded-* 같은 헤더에 원래 요청 정보를 직접 담아 넘겨야 해요. 로그인이 자꾸 풀리거나 접속 로그에 nginx의 IP만 찍히고, 리다이렉트 주소가 이상하게 잡히는 사고는 대부분 이 헤더를 빠뜨리면서 시작돼요.

### 분산 방식: 어느 서버로 보낼지 고르기

뒤쪽 서버가 여러 대라면 nginx가 어떤 기준으로 요청을 나눠 보낼지도 살펴봐야 해요. 상황에 따라서는 기본값을 그대로 쓰면 곤란하거든요.

기본값인 round-robin은 서버를 차례로 돌며 요청을 나눠 줘요. 요청마다 처리 시간이 비슷하다면 이것으로 충분해요. 어떤 요청은 금방 끝나고 다른 요청은 오래 걸리는 서비스라면, 현재 처리 중인 연결이 가장 적은 서버로 보내는 least_conn이 부하를 더 고르게 나눠 줘요.

ip_hash는 같은 사용자를 늘 같은 서버로 보내요. 서버 메모리에 로그인 세션 같은 정보를 들고 있을 때 쓰지만, 사용자를 특정 서버에 묶어두면 나중에 서버를 늘리거나 줄이기 까다로워져요. 가능하면 세션을 Redis 같은 외부 저장소로 빼고, 어느 서버가 요청을 받아도 처리할 수 있게 만드는 편이 나아요.

### 타임아웃과 failover: 느리거나 죽은 서버 대처하기

proxy_connect_timeout(서버와 연결을 맺을 때까지 기다리는 시간)과 proxy_read_timeout(응답을 기다리는 시간)의 기본값은 각각 60초예요. 생각보다 길어요.

proxy_next_upstream을 켜 두면 한 서버에서 실패했을 때 다음 서버로 자동 재시도해요. 편리하지만 함정이 하나 있어요. nginx는 기본적으로 POST처럼 "같은 요청을 두 번 보내면 안 되는" 요청, 이른바 비멱등 요청은 다음 서버로 재시도하지 않아요. 결제가 두 번 처리되는 식의 사고를 막기 위해서예요. 이 안전장치를 강제로 끄는 non_idempotent 옵션은 정말 괜찮다고 확신할 때만 건드려야 해요.

### buffering: 느린 사용자로부터 서버 지키기

nginx는 기본적으로 뒤쪽 서버의 응답을 자기 버퍼에 모두 받아둔 뒤 클라이언트에게 천천히 흘려보내요. 인터넷이 느린 사용자가 뒤쪽 서버를 오래 붙잡지 못하게 하는 방식이에요.

실시간 스트리밍에서는 이 방식이 문제가 돼요. SSE(Server-Sent Events, 서버가 데이터를 조금씩 계속 내려보내는 방식)처럼 응답이 조금씩 이어질 때 버퍼링을 켜 두면, 응답을 한데 모았다가 한꺼번에 보내므로 실시간성이 떨어져요. 이럴 때는 해당 위치(location)에서만 proxy_buffering off로 꺼야 해요. 무조건 켜 두는 게 정답인 설정이 아니라 트래픽 성격에 따라 달라지는 설정이에요.

이 영역은 2026년에도 거의 달라지지 않았어요. 서버에 직접 올린 nginx로 reverse proxy나 게이트웨이를 구성하는 방식은 여전히 그대로 통하고, 새로 외울 것도 많지 않아요.

## 쿠버네티스의 갈림길: Ingress의 종말

정작 크게 달라진 곳은 쿠버네티스 쪽이에요. 앞에서 말한 ingress-nginx 은퇴가 그 출발점이에요. 보안 업데이트가 끊긴 도구를 프로덕션에 계속 두는 건 시한폭탄을 안고 가는 것과 비슷해요.

사실 Ingress는 은퇴하기 전부터 한계가 뚜렷했어요. Ingress라는 표준 리소스로 기본적으로 표현할 수 있는 건 "이 주소로 들어오면 저 서비스로 보낸다" 정도의 단순한 라우팅뿐이에요.

그래서 타임아웃, 주소 재작성, 카나리 배포(새 버전에 트래픽을 일부만 흘려보내며 시험하는 것), 인증처럼 실무에 꼭 필요한 기능은 controller마다 제각각인 annotation(메타데이터에 붙이는 설정 꼬리표)에 욱여넣어야 했어요. ingress-nginx라면 nginx.ingress.kubernetes.io/rewrite-target, nginx.ingress.kubernetes.io/canary-weight, nginx.ingress.kubernetes.io/auth-url 같은 키를 붙이는 식이에요.

이 설정이 모두 단순한 문자열이라는 게 문제예요. 오타가 있어도 적용하는 순간에는 아무 경고가 없고, 나중에 컨트롤러를 다른 제품으로 바꾸면 설정을 통째로 옮길 수 없어요. 네트워크 인프라를 책임지는 사람과 자기 앱의 라우팅만 바꾸려는 개발자가 같은 리소스를 함께 만져야 해서 권한 경계도 애매했어요.

## Gateway API가 다른 점

Gateway API는 책임을 나누는 방식으로 이런 문제를 풀어요. 하나로 뭉쳐 있던 리소스를 역할에 따라 세 층으로 나눴어요.

- GatewayClass: 어떤 구현체(NGINX, Envoy 등)를 쓸지 인프라 제공자가 정한다
- Gateway: 어떤 포트로 받을지, TLS 인증서는 뭘 쓸지 등을 클러스터 운영자가 관리한다
- HTTPRoute: "내 서비스로 가는 경로는 이렇다"는 라우팅 규칙만 앱 개발자가 선언한다

두 방식을 나란히 놓으면 차이가 분명히 보여요. 가장 큰 차이는 정체를 알 수 없는 문자열 annotation 대신 타입이 명확하게 정의된 리소스(CRD, 쿠버네티스에 새로 정의해 쓰는 리소스 종류)를 쓴다는 점이에요.

annotation에 억지로 욱여넣던 카나리 배포도 이제 정식 필드로 깔끔하게 적을 수 있어요. 트래픽을 기존 버전에 90%, 새 버전에 10%씩 나눠 보내려면 이렇게 설정해요.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
spec:
  parentRefs:
    - name: prod-gateway
  hostnames:
    - api.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      backendRefs:
        - name: api-v1
          port: 8080
          weight: 90        # 기존 버전으로 90%
        - name: api-v2
          port: 8080
          weight: 10        # 새 버전으로 10% — 카나리
```

여기서 weight는 퍼센트가 아니라 비율을 나타내요. 각 서버의 weight를 전체 합으로 나눠 비율을 정하므로 숫자를 꼭 100에 맞출 필요는 없어요. 새 버전으로 완전히 넘기려면 기존 버전(api-v1)의 weight를 0으로 내리기만 하면 돼요.

이렇게 적으면 오타나 타입 실수를 설정에 적용하기 전에 걸러낼 수 있어요. HTTP뿐 아니라 HTTPS, TCP, gRPC 라우팅도 같은 표준 안에서 다뤄요. 앞으로 새 기능이 추가되는 곳도 Ingress가 아니라 Gateway API예요.

>

## 그래서 지금 옮겨야 하나

옮겨야 해요. 그렇다고 한 번에 전부 갈아엎을 필요는 없어요.

Gateway API와 Ingress는 같은 클러스터 안에서 함께 운영할 수 있어요. 기존 Ingress 컨트롤러와 Gateway API 컨트롤러를 병행하면 경로를 하나씩 천천히 옮길 수 있어요.

먼저 변환 도구부터 쓰면 돼요. [2026년 3월에 나온 ingress2gateway 1.0](https://kubernetes.io/blog/2026/03/20/ingress2gateway-1-0-release/)은 기존 Ingress 설정을 Gateway API 설정으로 자동 변환해 줘요.

```plain text
ingress2gateway print --providers=ingress-nginx --input-file=./ingress.yaml
```

이 명령은 변환 결과를 화면에 보여주기만 하고 클러스터에 바로 적용하지는 않아요. 오히려 그래서 안전해요. 실제로 옮길 때는 대략 이런 순서로 진행해요.

1. ingress2gateway로 기존 Ingress를 변환해서 결과를 파일로 받는다
1. 자동으로 안 옮겨진 controller별 annotation 설정을 손으로 채워 넣는다
1. 같은 클러스터에 Gateway와 HTTPRoute를 띄우고, 경로 일부만 새 방식으로 돌려본다
1. 트래픽을 지켜보면서 문제가 없으면 나머지도 단계적으로 옮긴다

매니지드 쿠버네티스를 쓴다고 남의 일은 아니에요. [AWS의 로드밸런서 컨트롤러도 Gateway API를 정식 지원하기 시작했어요](https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html). 이제 마이그레이션은 "할까 말까"가 아니라 "언제, 어떤 순서로 할까"를 정하는 문제로 넘어온 셈이에요.

단독 nginx에서 익힌 reverse proxy의 원리는 여전히 유효해요. 달라진 건 쿠버네티스에서 그 원리를 선언하고 운영하는 표준이에요. ingress-nginx를 쓰고 있다면 익숙한 설정을 한꺼번에 버리기보다 변환 결과를 검토하고, 두 방식을 병행하면서 Gateway API로 단계적으로 옮기는 게 현실적인 답이에요.

>
