---
layout: post
title: "React Basic"
date: 2022-03-02 12:19:18 +0900
image: logo-react.png
tags: [Summary, React, Web]
categories: Web
---

# React 기초

counter_with_js.html : 기존에 했던 Counter를 js를 이용하여 re-rendering 구현

1. 코드

```html
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Document</title>
</head>

<body>
    <!-- 앞으로 작성할 react app은 이 <div> 내부의 랜더링 됨 -->
    <div id="root"></div>
    <button class="btn">increase</button>

    <script>
        // Vanilla JS : 순수하게 JS로만 동작하는 코드

	      const root = document.querySelector('#root');
        const button = document.querySelector('button');

        let count = 0;
        // 안에 p 태그가 생김
        root.innerHTML = `<p>0</p>`;

				// component p태그를 나만의 변수로 가져보기
        button.addEventListener('click', () => {
            root.innerHTML = `<p>${++count}</p>`;
        });

         // 초기값
        // 객체 리터럴 방식으로 생성
        const component = {
            count: 0,
            updateElement() {
                return `<p>${this.count}</p>` // element
            }
        };

        // 브라우저를 다시 랜더링 하는 함수
        function render(component, element) {
            element.innerHTML = component.updateElement();
        };

        console.log('초기화면 rendering');
        render(component, document.querySelector('#root'));

        const button = document.querySelector('button');
        button.addEventListener('click', () => {
            // 특정 이벤트(button click)에 의해 component 값의 상태(state)가 바뀌면
            // 바뀐 상태 값으로 화면을 다시 rendering 함.
            component.count += 1;

            // 새로 업데이트된 component로 다시 렌더링(re-rendering)
            console.log('component가 업데이트 되어 새로 rendering');
            render(component,document.querySelector('#root'));
        });
    </script>

</body>

</html>
```

counter_with_react.html : Counter 코드를 React로 re-rendering 구현

1. 용어 정리 
- syntatic sugar : 문법적으로 더 읽기 쉽고 이해하기 편하도록 표현되어지는 것을 말하는 것으로 적절하게 사용되면 가독성(readibility)을 높이기 매우 좋다.
- DOM (The Document Object Model) : HTML, XML 문서의 프로그래밍 interface로 문서의 구조화된 표현(structured representation)을 제공하여 웹페이지를 스크립트 또는 프로그래밍 언어들에서 사용 될 수 있게 연결 시켜주는 역할을 담당해 문서 구조, 스타일, 내용 등을 변경할 수 있게 돕는다. DOM은 nodes와 object로 문서를 표현한다.

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
        <title>Document</title>
    </head>
    
    <body>
        <div id="root"></div>
        <button class="btn">increase</button>
    
        <!-- <div>
             text도 자식이다. 
            <p>p도 자식이다. p입니다.</p>
        </div> -->
    
        <script>
            // console.log(React); // 출력 결과 :object
    				// React : React의 최상위 API, React 라이브러리의 진입점.
    
            // 이전 상태와 마지막 가장 최근 스냅샷과의 차이를 비교해주고,
            // 이 변경내역(변경사항)을 ReactDOM에게 전달
            // React로 생성한 컴포넌트를 브라우저(Real DOM)에 전달해주는 역할.
    				// console.log(ReactDOM); 
    
    				// div element를 만들고 싶고, props는 없음 (null),
            // div element 내부 text(content)로 'div입니다.' 를 넣고 싶음.
            const component = React.createElement('div',null,'div입니다.')
            
            // console로 출력해보기 
            console.log(component);
    
            // 실제 홈페이지 적용
            ReactDOM.render(component, document.querySelector('#root'));
    
            const anotherComponent = React.createElement('div',null,'div입니다.',
                                     React.createElement('p',null,'p입니다.'));
            ReactDOM.render(component, document.querySelector('#root'));
    
           
    
            // 커스텀(사용자 정의) 컴포넌트, 커스텀 컴포넌트 일반적으로 대문자로 시작, <img/>, <div>
            // element를 반환하는 화살표 함수형태로 만들어보기
            const Component = props => {
                return React.createElement('p', null, `${props.count}`);
            };
    
            // 초기 렌더링
            // {count:0} : 객체
            ReactDOM.render(React.createElement(Component, { count: 0 }, null), document.querySelector('#root'));
            let i = 0;
    
            // 클릭을 통해 값이 증가하는 이벤트 발생에 따라 다시 렌더링 하고 싶음. 어떻게 해야할까?
            document.querySelector('button').addEventListener('click', () => {
                // 버튼 이벤트에 따른 re-rendering
                console.log('re-rendering');
                ReactDOM.render(React.createElement(Component, { count: ++i }, null), document.querySelector('#root'));
            });
        </script>
    </body>
    
    </html>
    ```