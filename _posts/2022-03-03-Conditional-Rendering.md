---
layout: post
title: "Conditional Rendering"
date: 2022-03-03 17:50:18 +0900
image: logo-react.png
tags: [Summary, React, Web]
categories: web
---
# Conditional Rendering

- React에서는 원하는 동작을 캡슐화 하는 컴포넌트를 만들 수 있고 애플리케이션의 상태에 따라서 컴포넌트 중 몇 개 만을 렌더링 할 수 있다.

```jsx
<script type="text/babel">
        // 1. components 만들기

        //로그인 상태일 때 출력할 엘리먼트
        const UserGreeting = (props) => {
            return <h1>Welcome Back!</h1>;
        };

        const GuestGreeting = (props) => {
            return <h1>Please sign up!</h1>;
        };

        // 로그인 여부를 알려주는 최상위 컴포넌트
        const Greeting = (props) => {

            // 로그인 여부에 따라 사용할 컴포넌트를 분기.
            console.log(props.isLoggedIn); // false

            const isLoggedIn = props.isLoggedIn;

            return isLoggedIn ? <UserGreeting /> : <GuestGreeting />;
        }

        ReactDOM.render(<Greeting isLoggedIn={true} />, document.getElementById('root'));
    </script>
```

- 어떻게 하면 버튼으로 Login Text와 Logout Text를 나눌수 있을까?

```jsx
<script type="text/babel">

        // 함수형 컴포넌트로 LoginControl이라는 컴포넌트 생성

        // 현재 LoginControl이 최상위 컴포넌트.
        const { useState } = React;

        const LoginControl = () => {
            const [isLoggedIn, setIsLoggedIn] = useState(false); // isLoggendIn의 값은 false

            const loginButtonHandler = () => {
                setIsLoggedIn(!isLoggedIn)
            };

            return (
                <>
                    <Greeting isLoggedIn={isLoggedIn} />
                    {isLoggedIn ? <LogoutButton onClick={loginButtonHandler} /> : <LoginButton onClick={loginButtonHandler} />}
                </>
            )
            // <Greeting isLoggedIn={isLoggedIn}/> 컴포넌트명 propsName = {const isLoggedIn} 
            // Greeting : <h1>Welcome back!</h1>이 return 안에 들어가있으면 하드 코딩이므로 분리
        }

        //   인사 메시지를 처리하는 별도의 컴포넌트 생성
        const Greeting = (props) => {
            return props.isLoggedIn ? <UserGreeting /> : <GuestGreeting />
        }

        const UserGreeting = () => {
            return <h1>Welcome back! </h1>
        }

        const GuestGreeting = () => {
            return <h1>Please sign in! </h1>
        }

        // ? props로 함수를 전달받아, 함수를 호출하여 Login or Logout Text 및 
        // Greeting 텍스트도 변경하려면 어떻게 해야할까?
        const LoginButton = (props) => {
            return <button onClick={props.onClick}>Login</button>
        };

        const LogoutButton = (props) => {
            return <button onClick={props.onClick}>Logout</button>
        };

        ReactDOM.render(<LoginControl />, document.getElementById('root'));

    </script>
```

- 논리 연산자 && 로 if 인라인으로 표현하기

```jsx
<script type="text/babel">
        const Mailbox = (props) => {
            const unreadMessages = props.unreadMessages;
            return (
                <>
                    <h1> Hello! </h1>
                    {unreadMessages.length > 0 && <h2> You have {unreadMessages.length} unread messages.</h2>}
                </>
            )
            // unreadMessage.length > 0 && <h2>You have {unreadMessages.length} unread messages. </h2>: 앞이 true면 뒤의 expression도 true

        }
        const messages = ['React', 'Re: React', 'Re:Re: React'];
        ReactDOM.render(<Mailbox unreadMessages={messages} />, document.getElementById('root'));
    </script>
```