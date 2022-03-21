---
layout: post
title: "element 렌더링 & Components와 Props"
date: 2022-03-02 17:19:18 +0900
image: logo-react.png
tags: [Summary, React, Web]
categories: web
---
# element 렌더링 & Components와 Props

### 1. element

1. 의미
    - element란 React 앱의 가장 작은 단위이며 화면에 표시할 내용을 기술한다.
    
    ```jsx
    const element = <h1>Hello, World</h1>;
    ```
    
    - 브라우저 DOM element와 달리 React element는 일반 객체이며 쉽게 생성 할 수 있고 React DOM은 React element와 일치하도록 DOM을 업데이트 할 수 있다.
    - React element 는 불변 객체이므로 생성 후 에는 해당 element의 자식이나 속성을 변경할 수 없다.
    
2. 코드

### 2. ****Components & Props****

1. 의미
    - Components 통해 UI를 재 사용 가능한 개별적인 여러 조각으로 나누고, 각 조각을 개별적으로 살펴 볼 수 있다.
    - Components는 JavaScript 함수와 유사한 데, props라고 하는 임의의 입력을 받은 후, 화면에 어떻게 표시 되는 지 기술하는 React element를 반환한다.
    - 함수 Components : 아래의 함수는 하나의 props(속성을 나타내는 Data) 객체 인자를 받은 후 React element를 반환하므로 유효한 React Components이며 JavaScript 함수이므로 함수 Components라고 부른다.
    
    ```jsx
    function Welcome(props) {
      return <h1>Hello, {props.name}</h1>;
    }
    ```
    
    - Components 합성
        - Components 이름은 항상 대문자로 시작한다.
        - Components는 자신의 출력에 다른 Components를 참조할 수 있는데, 모든 세부 단계에서 동일한 추상 Components를 사용할 수 있다.
        - React 앱에서는 버튼, 폼, 다이얼로그, 화면 등의 모든 것들이 Components로 표현된다.
    
    ```jsx
    function Welcome(props) {
      return <h1>Hello, {props.name}</h1>;
    }
    
    function App() {
      return (
        <div>
          <Welcome name="Sara" />
          <Welcome name="Cahal" />
          <Welcome name="Edite" />
        </div>
      );
    }
    
    ReactDOM.render(
      <App />,
      document.getElementById('root')
    );
    ```
    
    - props는 읽기 전용이다.
        - 함수 Components나 클래스 Components나 모두 Components의 자체 props를 수정해서는 안된다.
        - 모든 React Components는 자신의 props를 다룰 때 반드시 순수 함수처럼 동작해야 한다.
        
        ```jsx
        // 순수함수
        function sum(a, b) {
          return a + b;
        }
        
        // 순수함수 X
        function withdraw(account, amount) {
          account.total -= amount;
        }
        ```
        

1. 코드

```html
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script src="https://unpkg.com/react@17/umd/react.development.js" crossorigin></script>
    <script src="https://unpkg.com/react-dom@17/umd/react-dom.development.js" crossorigin></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <title>Document</title>
</head>

<body>
    <div id="root"></div>

    <script type="text/babel">
        function formatDate(date) {
            return date.toLocaleDateString();
        }

        // 후에 코드가 길어지면 쪼개서 해두는 것이 보기 좋다. 
        function Avatar(props) {
            return (
                <img className="Avatar"
                    src={props.user.avatarUrl}
                    alt={props.user.name} />
            )
        }

        function UserInfo(props) {
            return (
                <div className="UserInfo">
                    <Avatar author={props.user.author} />
                    <div className="UserInfo-name">
                        {props.author.name}
                    </div>
                </div>
            );
            // comment로 내려보낼때 user라고 했기 여기서도 props.user.author로 써준다.
            // {props.user.author} : Render의 author
        }

        function Comment(props) { // props의 보유 데이터 date, text, author
            return (
                <div className="Comment">
                    <UserInfo user={props.author} />
                    <div className="Comment-text">
                        {props.text}
                    </div>
                    <div className="Comment-date">
                        {formatDate(props.date)}
                    </div>
                </div>
            );
            // {props.author} : comment로 내려보낼때 user라고 했기 때문에
        }

        //DB에서 받은값들을 대부분 여기서 처리
        const comment = {
            date: new Date(),
            text: 'I hope you enjoy learning React!',
            author: {
                name: 'Hello Kitty',
                avatarUrl: 'http://placekitten.com/g/64/64'
            }
        };

        ReactDOM.render(
            <Comment
                date={comment.date}
                text={comment.text}
                // {comment.author} : comment 의 author
                author={comment.author} />,
            document.getElementById('root')
        );
    </script>

</body>

</html>
```