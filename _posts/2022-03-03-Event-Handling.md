---
layout: post
title: "Event Handling"
date: 2022-03-03 17:50:18 +0900
image: logo-react.png
tags: [Summary, React, Web]
categories: web
---
# Event Handling

- React의 이벤트는 소문자 대신 캐멀 케이스(camelCase)를 사용한다.
- JSX를 사용하여 문자열이 아닌 함수로 이벤트 핸들러를 전달한다.
- React에서는 false를 반환해도 기본 동작을 방지 할 수 없다.

HTML

```jsx
<form onsubmit="console.log('You clicked submit.'); return false">
  <button type="submit">Submit</button>
</form>
```

React

```jsx
const Form = () => {

            //submit 이벤트를 처리할 핸들러(담당자)작성
            const submitHandler = (event) => {
                event.preventDefault(); // form의 기본동작(reloading)을 제어하기 위한 코드
                console.log('you clicked submit');

            };

            return (
                <form onSubmit={submitHandler}>
                    <button type="submit">Submit</button>
                </form>
            )
        }
```

- React는 addEventListener를 호출할 필요가 없다. (단, 엘리먼트가 처음 렌더링 될 때 리스너를 제공하면 된다.)

```jsx
<div id="root"></div>
<script type="text/babel">
        const ButtonTest = () => {
        const {useState} = React;

        const [isToggle, setIsToggle] = useState(false);

        const clickHandler = () => {
            setIsToggle(!isToggle);
        };

            return(
                <button onClick={clickHandler}>{isToggle? 'CLICK':'NON'}</button>
            )
        }
    ReactDOM.render(
        <ButtonTest/>,
        document.getElementById('root')
    );
    </script>
```

- 사진까지 넣어보기

```jsx
<div id="root"></div>
<script type="text/babel">
const { useState } = React;

        const Toggle = () => {
            // 초기값 false
            const [isToggleOn, setIsToggleOn] = useState(false);

            // click 이벤트 발생시 처리를 담당할 Handler(담당자)
            const clickHandler = () => {
                // console.log('button clicked');

                // True -> False , False -> True
                setIsToggleOn(!isToggleOn);
            };
            // 소괄호는 코드를 깔끔하게 보기 위함
            return (
                // React.Fragment : 여러 줄을 한번에 쓰기 위해 div를 대체했음
                // <> : React.Fragment도 생략
                <>
                    <img src={isToggleOn ? 'pic_bulbon.gif' : 'pic_bulboff.gif'} />
                    <button onClick={clickHandler}>{isToggleOn ? 'OFF' : 'ON'}</button>
                </>
            )
        };

        ReactDOM.render(
            <Toggle />,
            document.getElementById('root')
        );
```