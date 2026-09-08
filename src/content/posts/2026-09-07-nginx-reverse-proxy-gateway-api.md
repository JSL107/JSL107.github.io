---
title: "nginx reverse proxy는 그대로, Kubernetes는 Gateway API로"
description: "단독 nginx의 reverse proxy는 여전히 유효하지만, Kubernetes에서는 ingress-nginx 은퇴에 맞춰 Gateway API로 단계적으로 전환해야 한다."
pubDatetime: 2026-09-07T09:00:00+09:00
category: infra
---

2025년 11월 11일, 쿠버네티스 블로그에 [ingress-nginx 컨트롤러 은퇴 공지](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)가 올라왔어요. 공지가 그 시점에 발표한 계획은 "best-effort 유지보수를 2026년 3월까지 이어가고, 그 뒤에는 더 이상 릴리스도, 버그 수정도, 새로 발견되는 보안 취약점을 막는 업데이트도 없다"였어요. 즉 멈추는 것은 릴리스와 버그 수정, 보안 취약점 업데이트 세 가지고, 이 글을 쓰는 지금은 공지가 말한 2026년 3월이 이미 지난 시점이에요.

멈추지 않는 것도 같은 공지에 적혀 있어요. "기존 ingress-nginx 배포는 계속 동작하고 설치 아티팩트도 그대로 남는다"고 했으니, 지금 트래픽을 받고 있는 컨트롤러가 어느 날 갑자기 죽는 상황은 아니에요. 위험은 정지가 아니라 방치예요. 새로 발견되는 취약점에 패치가 나오지 않는 도구를 계속 인터넷 앞단에 두는 셈이니까요.

한 가지는 먼저 갈라 둘게요. 은퇴한 것은 커뮤니티가 관리해 온 ingress-nginx 컨트롤러 **하나**예요. 쿠버네티스의 Ingress API 자체는 은퇴하지 않았고 다른 컨트롤러 구현도 그대로 남아 있어요. 공지가 대안으로 Gateway API 가이드와 함께 다른 Ingress 컨트롤러 목록을 나란히 링크한 것도 그래서예요. 뒤에서 "기존 Ingress를 그대로 두고 병행하라"고 말하는 것과 은퇴가 서로 모순되지 않는 이유이기도 해요.

이 글은 ingress-nginx로 외부 트래픽을 받고 있거나, 서버 한 대에 nginx를 올려 쓰다가 "쿠버네티스에서도 같은 이야기인가" 헷갈리는 백엔드·인프라 담당자를 독자로 잡았어요. 읽고 나면 단독 nginx의 reverse proxy 설정에서 무엇이 그대로인지, 쿠버네티스 쪽에서는 무엇을 어떤 순서로 옮겨야 하는지, 옮기는 동안 무엇을 관찰하며 통과와 롤백을 판정할지까지 정리돼요.

**범위를 미리 밝혀 둘게요. 이 글은 nginx와 Gateway API 공식 문서를 읽고 정리한 개념·설정 안내글이고, 제가 클러스터에 붙여 트래픽을 흘려보며 측정한 기록이 아니에요.** 인용한 문서는 글을 올린 뒤 출처를 다시 짚으며 2026년 9월 8일에 전부 다시 열어 확인했어요. 아래에 나오는 실패 모드도 제 장애 경험이 아니라 공식 문서가 명시한 동작과 널리 알려진 사례에서 가져왔어요. 그래서 마지막 절에는 측정 결과 대신 "무엇을 어떤 기준으로 확인할지"만 계약으로 적어 뒀어요.

말이 겹치는 자리도 풀어 둘게요. "게이트웨이"는 이 글에서 세 가지를 가리킬 수 있어요. 서버에 올린 단독 nginx가 요청을 받아 뒤로 넘기는 **역할**, 쿠버네티스가 그 역할을 리소스로 선언하게 만든 **표준인 Gateway API**, 그리고 인증·요금제·쿼터까지 얹어 파는 **API 게이트웨이 제품군**이에요. 세 번째는 이 글에서 다루지 않고, 앞의 두 축만 따로 떼어 볼게요.

## 단독 nginx: reverse proxy가 실제로 하는 일

서버 한 대에 nginx를 올려 요청을 중계할 때 실제로 벌어지는 일은 생각보다 단순해요. 들어온 요청을 뒤쪽 서버, 흔히 upstream이라고 부르는 곳으로 넘기면서 원래 요청 정보를 잃지 않도록 챙기고, 느린 연결을 흡수하며, 뒤쪽 서버 하나가 죽으면 알아서 제외하는 게 거의 전부예요.

설정으로 옮기면 이렇게 돼요.

```plain text
upstream backend {
    least_conn;                          # 연결 수가 가장 적은 서버로 — 요청 처리시간 편차가 클 때 유리
    server 10.0.0.11:8080 max_fails=3 fail_timeout=10s;
    server 10.0.0.12:8080 max_fails=3 fail_timeout=10s;
    keepalive 32;                        # upstream 연결 재사용 — 매 요청 TCP 핸드셰이크 방지
}

server {
    listen 80;
    server_name api.example.com;

    location /api/ {
        proxy_pass http://backend/;      # 끝의 슬래시가 경로를 바꾼다 — 아래 「경로가 조용히 달라지는 자리」 참고
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

이 블록이 보여주는 것과 보여주지 않는 것을 먼저 적어 둘게요. 보여주는 건 "요청을 뒤로 넘길 때 무엇을 챙겨야 하는가" 하나예요. HTTP만 받는 발췌라서 TLS 종료와 인증서, 접근 제어, 로그 포맷, 헬스체크, 워커·커널 튜닝은 일부러 뺐어요. 타임아웃과 재시도에 적힌 숫자도 제가 부하를 걸어 뽑은 값이 아니라 기본값과 대비하려고 놓은 예시라서, 프로덕션 기준값으로 그대로 쓸 값은 아니에요.

### 헤더 보존: 누가 보냈는지 잃어버리지 않기

proxy_pass로 요청을 뒤쪽에 한 번 더 넘기는 순간, 뒤쪽 서버에는 진짜 클라이언트가 아니라 nginx가 요청을 보낸 것처럼 보여요. 원래 누가 어떤 IP에서 접속했는지, http로 들어왔는지 https로 들어왔는지 같은 정보가 그대로 사라진다는 뜻이에요.

그래서 Host나 X-Forwarded-* 같은 헤더에 원래 요청 정보를 직접 담아 넘겨야 해요. 로그인이 자꾸 풀리거나 접속 로그에 nginx의 IP만 찍히고, 리다이렉트 주소가 이상하게 잡히는 증상이 여기서 나와요. 다만 "사고의 대부분이 이 헤더에서 시작된다"는 식의 빈도는 제가 세어 본 적이 없어요. 제가 말할 수 있는 건 원인을 좁힐 때 먼저 확인할 값이라는 정도고, 그건 제 판단이에요.

### 경로가 조용히 달라지는 자리: proxy_pass 끝의 슬래시

위 설정을 그대로 붙이면 뒤쪽 서버가 받는 경로가 달라져요. nginx 문서는 [proxy_pass에 URI가 붙은 경우](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass) "정규화된 요청 URI에서 location에 일치하는 부분이 지시어에 적은 URI로 교체된다"고 설명해요. 그래서 `location /api/`에 `proxy_pass http://backend/;`처럼 끝에 슬래시를 붙이면 `/api/users` 요청이 뒤쪽 서버에는 `/users`로 도착해요. `/api` 접두어를 살려서 넘기고 싶다면 `proxy_pass http://backend;`처럼 URI 없이 적어야 하고, 이때는 클라이언트가 보낸 형태 그대로 전달돼요. 에러 없이 404만 나는 이관 사고가 여기서 나오니, 붙여 쓰기 전에 슬래시 하나를 먼저 확인하는 편이 좋아요.

### 분산 방식: 어느 서버로 보낼지 고르기

뒤쪽 서버가 여러 대라면 nginx가 어떤 기준으로 요청을 나눠 보낼지도 살펴봐야 해요. 상황에 따라서는 기본값을 그대로 쓰면 곤란하거든요.

기본값인 round-robin은 서버를 차례로 돌며 요청을 나눠 줘요. 요청마다 처리 시간이 비슷하다면 이것으로 충분해요. 어떤 요청은 금방 끝나고 다른 요청은 오래 걸리는 서비스라면, [활성 연결이 가장 적은 서버로 보내는 least_conn](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#least_conn)이 부하를 더 고르게 나눠 줘요.

[ip_hash](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#ip_hash)는 클라이언트 IP를 해시 키로 써서 같은 사용자를 늘 같은 서버로 보내요. 서버 메모리에 로그인 세션 같은 정보를 들고 있을 때 쓰지만, 사용자를 특정 서버에 묶어두면 나중에 서버를 늘리거나 줄이기 까다로워져요. 가능하면 세션을 Redis 같은 외부 저장소로 빼고, 어느 서버가 요청을 받아도 처리할 수 있게 만드는 편이 나아요.

### 타임아웃과 failover: 느리거나 죽은 서버 대처하기

nginx 문서를 보면 [proxy_connect_timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_connect_timeout)(서버와 연결을 맺을 때까지 기다리는 시간)과 [proxy_read_timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout)(응답을 기다리는 시간)의 기본값은 각각 60초예요. 생각보다 길어요. proxy_read_timeout은 응답 전체를 받는 데 걸리는 시간이 아니라 연속된 두 번의 읽기 사이에만 적용된다는 점도 같이 기억해 두면 좋아요.

upstream 블록에 붙인 [max_fails와 fail_timeout](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#max_fails)은 "언제 이 서버를 죽은 것으로 볼지"를 정하는 값이에요. fail_timeout 동안 max_fails번 실패하면 그 서버를 같은 fail_timeout 길이만큼 후보에서 빼요. 기본값은 max_fails가 1, fail_timeout이 10초라서 한 번만 실패해도 10초간 제외되는데, 예시의 `max_fails=3 fail_timeout=10s`는 "10초 안에 세 번 실패해야 10초간 제외한다"로 판정을 조금 둔감하게 만든 설정이에요.

[proxy_next_upstream](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream)을 켜 두면 한 서버에서 실패했을 때 다음 서버로 자동 재시도해요. 편리하지만 함정이 하나 있어요. nginx 문서는 요청이 이미 upstream 서버로 전달된 뒤라면 POST, LOCK, PATCH 같은 비멱등 메서드는 다음 서버로 넘기지 않는다고 적어요. 같은 요청을 두 번 보내면 안 되는 요청, 이를테면 결제가 두 번 처리되는 사고를 막기 위해서예요. 이 안전장치를 강제로 끄는 non_idempotent 옵션은 정말 괜찮다고 확신할 때만 건드려야 해요.

### buffering: 느린 사용자로부터 서버 지키기

[proxy_buffering의 기본값은 on](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)이에요. 켜져 있으면 nginx가 뒤쪽 서버의 응답을 가능한 만큼 빨리 받아 자기 버퍼에 담고, 버퍼에 다 들어가지 않으면 디스크의 임시 파일에까지 저장한 뒤 클라이언트에게 흘려보내요. 인터넷이 느린 사용자가 뒤쪽 서버를 오래 붙잡지 못하게 하는 방식이에요. 반대로 꺼 두면 응답을 받는 즉시 클라이언트로 동기적으로 넘기고, 전체 응답을 다 읽으려 하지 않아요.

실시간 스트리밍에서는 켜 둔 쪽이 문제가 돼요. SSE(Server-Sent Events, 서버가 데이터를 조금씩 계속 내려보내는 방식)처럼 응답이 조금씩 이어질 때 버퍼링을 켜 두면 응답을 한데 모았다가 내보내므로 실시간성이 떨어져요. 이럴 때는 해당 위치(location)에서만 proxy_buffering off로 꺼야 해요. 무조건 켜 두는 게 정답인 설정이 아니라 트래픽 성격에 따라 달라지는 설정이에요.

여기까지가 2026년에도 그대로 쓰는 내용이에요. 서버에 직접 올린 nginx로 요청을 중계하는 방식은 위에 적은 문서 그대로 동작하고, 새로 외울 것도 많지 않아요. 달라진 곳은 다음 절이에요.

## 쿠버네티스의 갈림길: ingress-nginx 컨트롤러 은퇴

정작 크게 달라진 곳은 쿠버네티스 쪽이에요. 앞에서 말한 ingress-nginx 컨트롤러 은퇴가 그 출발점이에요. 다시 짚어 두면 끝난 것은 컨트롤러 하나이고 Ingress API는 그대로 남아 있어요. 그래서 "Ingress를 다 버려야 한다"가 아니라 "이 컨트롤러를 무엇으로 바꿀지"가 실제 질문이에요.

바꿀 대상을 고민하다 보면 Ingress API 자체의 한계도 다시 보여요. Ingress라는 표준 리소스로 기본적으로 표현할 수 있는 건 "이 주소로 들어오면 저 서비스로 보낸다" 정도의 단순한 라우팅뿐이에요. Gateway API 소개 문서도 [헤더 기반 매칭이나 트래픽 가중치 배분 같은 기능은 Ingress에서 커스텀 annotation으로만 가능했다](https://gateway-api.sigs.k8s.io/docs/introduction/)고 적어요.

그래서 타임아웃, 주소 재작성, 카나리 배포(새 버전에 트래픽을 일부만 흘려보내며 시험하는 것), 인증처럼 실무에 꼭 필요한 기능은 컨트롤러마다 제각각인 annotation(메타데이터에 붙이는 설정 꼬리표)에 욱여넣어야 했어요. ingress-nginx라면 [nginx.ingress.kubernetes.io/rewrite-target, nginx.ingress.kubernetes.io/canary-weight, nginx.ingress.kubernetes.io/auth-url 같은 키](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/)를 붙이는 식이에요.

이 설정이 모두 단순한 문자열이라는 게 문제예요. 오타가 있어도 적용하는 순간에는 아무 경고가 없고, 나중에 컨트롤러를 다른 제품으로 바꾸면 설정을 통째로 옮길 수 없어요. 네트워크 인프라를 책임지는 사람과 자기 앱의 라우팅만 바꾸려는 개발자가 같은 리소스를 함께 만져야 해서 권한 경계도 애매했어요.

## Gateway API가 다른 점

먼저 정체부터 적어 둘게요. [Gateway API](https://gateway-api.sigs.k8s.io/docs/introduction/)는 쿠버네티스의 L4·L7(L4는 TCP·UDP 같은 전송 계층, L7은 HTTP 같은 응용 계층) 라우팅을 다루는 공식 프로젝트이고, 스스로를 "쿠버네티스 Ingress와 로드 밸런싱, 서비스 메시 API의 다음 세대"로 소개해요. 실체는 `gateway.networking.k8s.io` 그룹에 CRD(쿠버네티스에 새로 정의해 쓰는 리소스 종류)로 설치되는 리소스 묶음이에요. 앞 절에서 갈라 둔 세 가지 뜻 중 두 번째, 그러니까 라우팅을 선언하는 표준 리소스 쪽이고, 인증·요금제까지 얹은 API 게이트웨이 제품과는 다른 층이에요.

Gateway API는 뭉쳐 있던 책임을 [역할에 따라 세 층으로 나눠요](https://gateway-api.sigs.k8s.io/docs/concepts/api-overview/).

- GatewayClass: 어떤 구현체(NGINX, Envoy 등)를 쓸지 인프라 제공자가 정한다
- Gateway: 어떤 포트로 받을지, TLS 인증서는 뭘 쓸지 등을 클러스터 운영자가 관리한다
- HTTPRoute: "내 서비스로 가는 경로는 이렇다"는 라우팅 규칙만 앱 개발자가 선언한다

세 리소스는 모두 GA(General Availability, 스펙이 확정돼 정식 제공되는 단계)이고 Standard 채널에 v0.5.0부터 들어 있어요. 문자열 annotation 대신 타입이 정의된 리소스를 쓰니 오타나 타입 실수를 클러스터에 적용하기 전에 걸러낼 수 있고, 어느 역할이 어느 리소스를 소유하는지도 리소스 경계로 드러나요. 앞 절에서 본 Ingress의 문제와 대응해 보면 차이는 두 갈래예요. 문자열이 타입이 됐고, 하나였던 리소스가 소유자별로 갈라졌어요.

Gateway를 먼저 띄워야 라우팅이 붙어요. Gateway 문서는 다른 리소스가 "Gateway가 만들어져 서로를 연결해 줄 때까지는 설정 조각에 불과하다"고 설명해요. [공식 가이드의 최소 예시](https://gateway-api.sigs.k8s.io/guides/getting-started/simple-gateway/)를 뒤에 나올 HTTPRoute와 이름만 맞춰 옮기면 이렇게 돼요.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
spec:
  gatewayClassName: example      # 설치한 구현체가 등록한 GatewayClass 이름으로 바꿔 넣는다
  listeners:
    - name: prod-web-gw
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Same             # 같은 namespace의 Route만 붙을 수 있다
```

listeners는 이 Gateway가 어떤 포트와 프로토콜로 받고 TLS를 어떻게 끝낼지, 그리고 어떤 Route가 붙을 수 있는지를 정하는 자리예요. gatewayClassName은 위 GatewayClass를 가리키고, 그 값에 따라 실제 로드 밸런서를 만들 컨트롤러가 결정돼요.

annotation에 욱여넣던 카나리 배포는 이 Gateway 위에 붙는 HTTPRoute에서 정식 필드로 적을 수 있어요. 트래픽을 기존 버전에 90%, 새 버전에 10%씩 나눠 보내려면 이렇게 설정해요.

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

낯선 필드 이름부터 풀어 둘게요. parentRefs는 이 Route를 어느 Gateway에 붙일지 가리키는 자리예요. 위에서 만든 `prod-gateway`가 없으면 이 HTTPRoute는 어디에도 붙지 못해요. hostnames는 요청의 Host 헤더와 맞춰 볼 이름 목록이고, HTTPRoute 문서는 규칙을 따지기 전에 hostnames를 먼저 본다고 적어요. matches의 `type: PathPrefix`는 경로가 그 값으로 시작하는 요청을 고르라는 뜻이라 `/api`로 적으면 `/api/users`도 걸려요. backendRefs는 고른 요청을 보낼 대상이고, weight가 그 사이의 배분이에요.

weight는 퍼센트가 아니라 비율을 나타내요. 각 대상의 weight를 전체 합으로 나눠 비율을 정하므로 숫자를 꼭 100에 맞출 필요는 없어요. 새 버전으로 완전히 넘기려면 기존 버전(api-v1)의 weight를 0으로 내리기만 하면 돼요.

여기서 표준이 실제로 덮는 범위는 짚어 둘 필요가 있어요. 앞 절에서 Ingress의 한계로 든 네 가지가 모두 같은 등급으로 표준에 들어와 있지는 않아요. 카나리 배분은 위처럼 backendRefs의 weight로 적고, 이건 Standard 채널에서 GA인 HTTPRoute 스펙 안에 들어 있는 필드예요. 요청 타임아웃은 HTTPRoute의 `timeouts` 필드로 v1.2.0부터 Standard 채널에 들어왔고요. 주소 재작성(URLRewrite)은 Extended라서 구현체가 지원할 것을 권장받지만 의무는 아니에요. 인증은 아직 표준이 아니라, HTTP 외부 인증을 다루는 [GEP-1494](https://gateway-api.sigs.k8s.io/geps/gep-1494/)가 Experimental 상태예요. 그러니까 "표준이 네 가지를 모두 정식 필드로 풀었다"가 아니라 두 가지는 표준, 하나는 선택, 하나는 아직 논의 중이에요.

말이 섞이기 쉬운 자리라 한 줄 갈라 둘게요. 방금 나온 릴리스 채널(Standard·Experimental)과 지원 등급(Core·Extended)은 하나의 축에 놓인 두 값이 아니라 서로 다른 축이에요. 채널은 그 필드가 어느 배포 채널에 실려 나오는지를 가르고, 등급은 그 필드를 구현체가 반드시 지원해야 하는지를 가르거든요.

Gateway API 쪽 비용도 같이 놓아야 저울질이 돼요.

- CRD 관리가 새로 생겨요. [CRD 관리 가이드](https://gateway-api.sigs.k8s.io/guides/crd-management/)는 CRD가 "권한이 높은 클러스터 범위 리소스"라서 클러스터 관리자나 클러스터 제공자가 책임져야 한다고 적어요. 새 버전이 필드를 추가하기 때문에 이전 버전으로 되돌리면 그 설정이 사라질 수 있고, 마이너 버전을 한 단계씩 올리는 경로가 가장 안전하다고 안내해요.
- 리소스가 셋으로 늘어난 만큼 학습·운영 비용도 늘어요. Ingress 하나를 보던 자리에서 GatewayClass·Gateway·HTTPRoute의 소유자와 status를 각각 따라가야 하고, 권한 경계를 분명히 하려고 나눈 구조라서 소유자가 흩어지는 것 자체가 설계 의도예요.
- 구현체별 차이가 남아요. 앞에서 본 지원 등급 구분 때문에 필요한 기능이 Extended라면 구현체마다 지원 여부가 갈리고, [구현체 목록](https://gateway-api.sigs.k8s.io/docs/implementations/)도 완전 적합과 부분 적합을 나눠 표시해요. annotation 지옥이 사라진 대신 "이 구현체가 내가 쓸 필드를 지원하나"를 확인하는 일이 생긴 셈이에요.

## 그래서 지금 옮겨야 하나

옮기는 쪽이 맞다고 봐요. 그렇다고 한 번에 전부 갈아엎을 필요는 없어요.

먼저 다른 길도 짚고 갈게요. 은퇴한 것이 컨트롤러 하나이니 다른 Ingress 컨트롤러로 갈아타는 선택도 그대로 열려 있고, 은퇴 공지 역시 대안 컨트롤러 목록을 함께 링크해요. 다만 annotation 키는 컨트롤러마다 다르니 어느 쪽으로 가도 설정을 다시 쓰는 일은 피할 수 없고, 공지가 권하는 방향은 Gateway API 쪽이에요. 그렇다면 다시 쓰는 비용을 표준 리소스 쪽에 쓰는 편이 낫다고 판단했는데, 이건 제 선택이고 클러스터 사정에 따라 갈릴 수 있어요.

옮기는 동안은 두 방식을 같은 클러스터에서 함께 운영할 수 있어요. [ingress-nginx 이관 가이드](https://gateway-api.sigs.k8s.io/guides/getting-started/migrating-from-ingress-nginx/)는 병행 운영을 "그렇게 할 수 있고, 강력히 권한다"고 적으면서 프로덕션 트래픽을 건드리지 않고 시험하는 방법으로 소개해요.

구현체는 그 가이드가 제시하는 세 가지 기준으로 고르면 돼요. 필요한 Gateway API 기능이 실제로 지원되는지 적합성 보고서로 확인하고, 팀이 익숙한 프록시(Envoy나 NGINX 등)가 무엇인지 보고, 쓰고 있는 클라우드 제공자나 CNI(Container Network Interface, 클러스터의 파드 네트워크를 담당하는 플러그인)가 이미 제공하는 구현체가 있는지 확인하는 식이에요. 후보는 위에 링크한 구현체 목록에 완전 적합·부분 적합으로 나뉘어 정리돼 있어요.

변환은 도구로 시작하면 돼요. [2026년 3월 20일에 나온 ingress2gateway 1.0](https://kubernetes.io/blog/2026/03/20/ingress2gateway-1-0-release/)은 기존 Ingress 리소스와 구현체별 annotation을 Gateway API 리소스로 변환해 주고, ingress-nginx의 자주 쓰는 annotation 30여 종(브라우저가 다른 출처로 보내는 요청을 허용하는 CORS, 백엔드 TLS, 정규식 매칭, 경로 재작성 등)을 지원해요.

```plain text
ingress2gateway print --providers=ingress-nginx --input-file=./ingress.yaml
```

`print`는 변환 결과를 출력만 하고 클러스터에 적용하지 않아요. 오히려 그래서 안전해요.

빠지는 것도 미리 알아 두는 편이 좋아요. 저장소 문서를 기준으로 정리하면 이래요.

- 구현체별 annotation을 Gateway API 리소스에 그대로 복사하는 것은 이 도구의 목표가 아니에요. 명시된 비목표라서, annotation이 통째로 넘어오길 기대하면 안 돼요.
- Gateway API 스펙으로 직역되지 않는 구현체별 annotation과 CRD는 자주 쓰이는 것이라도 지원되지 않을 수 있다고 적혀 있어요.
- 변환하지 못한 설정의 전체 목록은 문서에 없어요. 대신 실행할 때 옮기지 못한 필드를 경고로 알려주니, 그 경고가 곧 손으로 채워야 할 목록이에요.

실제로 옮길 때는 대략 이런 순서로 진행해요.

1. ingress2gateway로 기존 Ingress를 변환해서 결과를 파일로 받는다
1. 경고에 찍힌 대로, 자동으로 안 옮겨진 컨트롤러별 annotation 설정을 손으로 채워 넣는다
1. 같은 클러스터에 Gateway와 HTTPRoute를 띄우고, 경로 일부만 새 방식으로 돌려본다
1. 아래 계약대로 지표를 보며 통과를 판정하고, 통과한 경로부터 단계적으로 넓힌다

### 무엇을 보고 통과라고 할지 먼저 적어 둔다

"트래픽을 지켜보면서 문제가 없으면"은 판정 기준이 아니에요. 저는 아직 이 이관을 제 손으로 재보지 않았으니, 측정 결과 대신 무엇을 어떤 기준으로 볼지만 계약으로 고정해 둘게요. 기준값은 옮기기 전에 먼저 재둬야 해요. 이관 전 값이 없으면 이관 후 숫자만으로는 아무것도 판정할 수 없거든요.

표에서 쓸 상태 조건 세 개의 뜻부터 적어 둘게요. [문제 해결 가이드](https://gateway-api.sigs.k8s.io/docs/concepts/troubleshooting/)를 따르면 Accepted는 그 리소스가 문법·의미 요건을 갖춰 컨트롤러가 받아들였다는 뜻이고, Programmed는 그 설정이 모두 해석돼 실제로 트래픽을 처리하는 데이터 플레인까지 전달됐다는 뜻이며, ResolvedRefs는 그 리소스가 가리키는 다른 리소스가 모두 존재하고 그 자리에 쓸 수 있는 것이라는 뜻이에요.

| 이관 단계 | 관찰 지표 | 통과·롤백 판정 |
| --- | --- | --- |
| 경로 하나를 HTTPRoute로 돌린 직후 | Gateway와 HTTPRoute의 `status.conditions`(Accepted·Programmed·ResolvedRefs), 그 경로의 5xx 비율과 응답시간 상위 백분위 | 세 조건이 모두 정상이고 5xx 비율·응답시간이 이관 전 범위 안이면 통과. 하나라도 어긋나면 그 경로만 Ingress로 되돌린다 |
| 카나리 weight를 90/10으로 나눈 뒤 | 새 버전(api-v2)이 실제로 받은 요청 비율, 새 버전의 5xx 비율 | 실제 비율이 의도한 10%에서 벗어나거나 새 버전의 5xx가 기존 버전보다 높으면 api-v2의 weight를 0으로 내린다 |
| 자동 변환 경고에 찍힌 설정을 손으로 채운 뒤 | 그 설정이 걸린 경로의 응답(재작성된 경로, 리다이렉트 주소, 인증 통과 여부) | 같은 요청에 이관 전과 같은 응답이 나오는지 요청 단위로 대조. 대조할 이관 전 응답이 없으면 그 경로는 마지막으로 옮긴다 |
| 병행 운영 중 | 두 컨트롤러가 같은 호스트·경로를 동시에 물고 있는지 | 겹치면 어느 쪽이 받는지 확정할 수 없으니, 겹침이 0인 것을 확인한 뒤에만 다음 경로로 넘어간다 |

응답시간의 백분위와 허용 범위처럼 서비스마다 달라지는 값은 일부러 비워 뒀고, 각자 지금 쓰는 SLO(Service Level Objective, 서비스가 지키기로 정해 둔 성능·가용성 목표치)에서 가져와 채우면 돼요.

매니지드 쿠버네티스를 쓴다고 남의 일은 아니에요. AWS는 2026년 3월 6일에 [로드밸런서 컨트롤러의 Gateway API 지원이 GA에 도달했다고 발표](https://aws.amazon.com/blogs/networking-and-content-delivery/aws-load-balancer-controller-adds-general-availability-support-for-kubernetes-gateway-api/)했고, L4 라우트(TCPRoute·UDPRoute)는 NLB(Network Load Balancer)로, L7 라우트(HTTPRoute·GRPCRoute)는 ALB(Application Load Balancer)로 처리한다고 적었어요. 다만 Gateway API의 구현체 목록에서는 이 컨트롤러가 부분 적합으로 분류돼 있으니, 쓸 기능이 적합성 보고서에 들어 있는지는 따로 확인해야 해요.

단독 nginx에서 익힌 reverse proxy의 원리는 그대로 쓸 수 있어요. 달라진 건 쿠버네티스에서 그 원리를 선언하고 운영하는 표준이에요. ingress-nginx를 쓰고 있다면 익숙한 설정을 한꺼번에 버리기보다 변환 결과와 경고를 검토하고, 두 방식을 병행하면서 위 계약대로 경로 단위로 옮기는 순서를 저는 권하고 싶어요. 다만 이건 문서를 읽고 세운 계획이고 제가 트래픽으로 검증한 결론은 아니니, 첫 경로를 옮길 때 기준값부터 재는 일은 각자 몫이에요.

## 출처

제품 동작과 지원 등급은 문서 확인 시점에 따라 달라질 수 있어요. 아래 자료는 글을 올린 뒤 출처를 다시 짚으며 2026년 9월 8일에 모두 직접 열어 확인했어요.

| 제목 | 자료 링크 | 본문 주장 대응 | 확인일 |
| --- | --- | --- | --- |
| Ingress NGINX Retirement | [직접 링크](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/) | 2025-11-11 발표, best-effort 유지보수가 2026년 3월까지라는 계획, 그 뒤 릴리스·버그 수정·보안 업데이트 중단, 기존 배포와 설치 아티팩트는 유지, 대안으로 Gateway API 가이드와 다른 Ingress 컨트롤러 목록을 함께 안내 | 2026-09-08 |
| nginx ngx_http_proxy_module | [직접 링크](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) | proxy_pass에 URI를 붙이면 location에 일치하는 부분이 교체된다는 동작, proxy_connect_timeout·proxy_read_timeout 기본값 60초, proxy_read_timeout이 연속된 두 읽기 사이에만 적용된다는 점, POST·LOCK·PATCH를 다음 서버로 넘기지 않는 기본 동작과 non_idempotent, proxy_buffering 기본값 on과 on/off 동작 | 2026-09-08 |
| nginx ngx_http_upstream_module | [직접 링크](https://nginx.org/en/docs/http/ngx_http_upstream_module.html) | max_fails 기본값 1, fail_timeout 기본값 10초와 그 뜻, least_conn과 ip_hash의 분산 기준, keepalive의 역할 | 2026-09-08 |
| ingress-nginx: Annotations | [직접 링크](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/) | rewrite-target·canary-weight·auth-url이 ingress-nginx 컨트롤러 전용 annotation 키라는 점(기본 접두어 `nginx.ingress.kubernetes.io`, `--annotations-prefix`로 변경 가능), 경로 재작성·카나리·인증이 Ingress 스펙이 아니라 컨트롤러 annotation으로 제공된다는 점 | 2026-09-08 |
| Gateway API: Introduction | [직접 링크](https://gateway-api.sigs.k8s.io/docs/introduction/) | Gateway API가 L4·L7 라우팅을 다루는 공식 프로젝트이고 Ingress·로드 밸런싱·서비스 메시 API의 다음 세대라는 자기 소개, 헤더 기반 매칭·트래픽 가중치 같은 기능이 Ingress에서는 커스텀 annotation으로만 가능했다는 서술 | 2026-09-08 |
| Gateway API: API Overview | [직접 링크](https://gateway-api.sigs.k8s.io/docs/concepts/api-overview/) | 역할별 소유(GatewayClass는 인프라 제공자, Gateway는 클러스터 운영자, Route는 앱 개발자), GatewayClass·Gateway·HTTPRoute가 v0.5.0부터 Standard 채널 GA | 2026-09-08 |
| Gateway API: Gateway | [직접 링크](https://gateway-api.sigs.k8s.io/reference/api-types/gateway/) | Gateway가 만들어질 때까지 다른 리소스는 설정 조각이라는 설명, gatewayClassName과 listeners·addresses의 의미 | 2026-09-08 |
| Gateway API: HTTPRoute | [직접 링크](https://gateway-api.sigs.k8s.io/reference/api-types/httproute/) | parentRefs·hostnames·rules·matches(PathPrefix)·backendRefs·weight의 의미, hostnames를 규칙보다 먼저 본다는 점, weight로 90%/10% 배분, URLRewrite가 Extended이고 timeouts가 v1.2.0부터 Standard라는 지원 등급 | 2026-09-08 |
| Gateway API: 최소 Gateway 예시 | [직접 링크](https://gateway-api.sigs.k8s.io/guides/getting-started/simple-gateway/) | 본문 Gateway 매니페스트의 원본 형태(gatewayClassName, listeners의 name·protocol·port, allowedRoutes.namespaces.from) | 2026-09-08 |
| Gateway API: ingress-nginx 이관 가이드 | [직접 링크](https://gateway-api.sigs.k8s.io/guides/getting-started/migrating-from-ingress-nginx/) | 병행 운영을 강력히 권한다는 문장, ingress2gateway를 시작점으로 쓰라는 권고, 구현체 선택 기준 세 가지(적합성 보고서·팀이 익숙한 프록시·기존 클라우드·CNI 통합) | 2026-09-08 |
| Gateway API: 구현체 목록 | [직접 링크](https://gateway-api.sigs.k8s.io/docs/implementations/) | 완전 적합과 부분 적합으로 나뉜 구현체 목록, AWS Load Balancer Controller가 부분 적합으로 분류된 점, 확장 기능 비교표의 존재 | 2026-09-08 |
| Gateway API: CRD 관리 | [직접 링크](https://gateway-api.sigs.k8s.io/guides/crd-management/) | CRD가 권한 높은 클러스터 범위 리소스이고 클러스터 관리자·제공자 책임이라는 점, 되돌릴 때 설정이 유실될 수 있다는 경고, 마이너 한 단계씩 업그레이드 권고 | 2026-09-08 |
| Gateway API: 상태 조건 | [직접 링크](https://gateway-api.sigs.k8s.io/docs/concepts/troubleshooting/) | 검증 계약 표에 쓴 Accepted·Programmed·ResolvedRefs의 정의와, status.conditions 확인이 첫 번째 원칙이라는 문장 | 2026-09-08 |
| GEP-1494: HTTP External Authentication | [직접 링크](https://gateway-api.sigs.k8s.io/geps/gep-1494/) | HTTP 외부 인증이 Experimental 상태이고 Standard 채널에 없다는 점 | 2026-09-08 |
| Announcing Ingress2Gateway 1.0 | [직접 링크](https://kubernetes.io/blog/2026/03/20/ingress2gateway-1-0-release/) | 2026-03-20 발표, Ingress 리소스와 구현체별 annotation 변환, ingress-nginx annotation 30여 종 지원(CORS·백엔드 TLS·정규식 매칭·경로 재작성), 옮기지 못한 설정을 경고로 알려준다는 점 | 2026-09-08 |
| ingress2gateway 저장소 | [직접 링크](https://github.com/kubernetes-sigs/ingress2gateway) | `print`가 출력만 하고 클러스터에 적용하지 않는다는 점, annotation을 그대로 복사하는 것이 비목표라는 점, 직역되지 않는 구현체별 annotation·CRD는 지원되지 않을 수 있다는 문장 | 2026-09-08 |
| AWS Load Balancer Controller adds general availability support for Kubernetes Gateway API | [직접 링크](https://aws.amazon.com/blogs/networking-and-content-delivery/aws-load-balancer-controller-adds-general-availability-support-for-kubernetes-gateway-api/) | 2026-03-06 발표라는 시점, L4 라우트를 NLB로 L7 라우트를 ALB로 처리한다는 지원 범위 | 2026-09-08 |
