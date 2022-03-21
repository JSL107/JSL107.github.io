---
layout: post
title: "State and Life Cycle"
date: 2022-03-02 17:19:18 +0900
image: logo-react.png
tags: [Summary, React, Web]
categories: web
---
# State and Life cycle

### 1. State

1. state
    - React는 뷰의 단위가 components로 구성되고, components를 통해 UI 재 사용이 가능한 여러 조각으로 나누는데 props와 state가 중요 하다. 각 components는 상위에서 하위로 값을 전달하여 사용할 수 있는데 이 때 전달되는 값을 props라고 하고 state는 각 components가지고 있는 개별적인 상태 값이다. props와 state는 일반 JavaScript의 객체로 두 객체 모두 렌더링 결과물에 영향을 주는 정보를 갖고 있지만 변경 가능에 대한 차이가 있다.
    - props는 부모 구성 요소에서 설정한 정보를 포함하여 모두 변경이 불가능한 불변성의 특징을 가지고 있다.
    - state는 구성 요소가 자체적으로 초기화, 변경 및 사용할 수 있는 정보를 포함하고, setState를 통해 변경이 가능하다.

1. 코드

```jsx
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
    <!-- React & Babel CDN -->

</head>

<body>
    <div id="root"></div>

    <script type="text/babel">
        // 1.props
        const Component = props => {
            return (
                <div>
                    <h1>It's a {props.value}</h1>
                </div>
            );
        // It's a Function component
        }

        // 1. plane
        // It's a Function component 어떻게 출력?
        // 별도의 props가 없을 때 defaultProps 지정 할 때.

        // 별도로 지정한 props가 없을 때 defaultProps 지정하려면?
        // Component.defaultProps = {
        //     value : 'default value'
        // }
        // ReactDOM.render(<Component/>, document.querySelector('#root'));
        ReactDOM.render(<Component value="Function component" />, document.querySelector('#root'));

        // 2. before state : state 없을 때
        let count = 0; //컴포넌트와 관련없는 변수

        function BeforeState() {  // 하나의 컴포넌트 (함수형 컴포넌트)
            //  const clickHandler : 하나의 프로퍼티
            const clickHandler = () => { // click 이벤트를 처리할 핸들러(담당자)
                console.log('button clicked');
                // count 가 ReadOnly 에러 발생
                // props 는 ReadOnly이기 때문
                count++;
            }
            // count의 증가는 잘 됨
            console.log(count);

            // 반드시 하나의 부모 element필요
            // ? 클릭해서 ?? 수정
            return (
                <div>
                    <p>you clicked {count} times</p>
                    <button onClick={clickHandler}>Click me</button>
                </div>
            );
        }

        ReactDOM.render(<BeforeState/>, document.querySelector('#root'));

        //3. state

        // 객체 Destructuring 과 비슷한 형태
        const { useState } = React;

        function Example() {
            console.log('rendered');
            // 우리의 관심사는 count(하나의 state)
            // const [count,setCount] = useState(initialState) : state의 초기 값을 0으로 지정하고 useState(초기값 변수)
            const [count, setCount] = useState(0);  // 배열 형태

            // 초기값 및 변경된 값(둘 다 활용됨)
            // console.log(count);

            // 값을 변경해주는 함수
            // console.log(setCount);

            const clickHandler = () => {
                // setCount()를 통해 count(state 값)을 변경,  state가 변경되면 react는 변경을 감지하고, 새로 렌더링 시킴
                setCount(count + 1);
            };

            return (
                <div>
                    <p>you clicked {count} times</p>
                    <button onClick={clickHandler}>Click me</button>
                </div>
            );
        }
        ReactDOM.render(<Example />, document.querySelector('#root'));
    </script>

</body>

</html>
```

### 2. 생명주기(Life Cycle)

1. 의미 
    - 생명주기는 React components의 탄생부터 죽음 까지의 단계를 말하는데, 여러 지점에서 개발자가 작업을 할 수 있도록 method를 overriding 할 수 있게 해준다.
    - 이 생명 주기는 클래스 components에서만 해당되고 function components는 생명 주기가 없고 그처럼 동작하는 것이 없다.
    - 생명 주기의 전체 과정

```
Initialization (준비)   ⇒  constructor
Mounting (탄생)         ⇒  컴포넌트를 그리기 직전 - 그리기(render) - 그린 직후
Updation (변경)         ⇒  props 또는 state의 변경 
Unmounting (죽음)       ⇒  죽기 직전
```

1. 코드

출처 : Lim kyoung seob's blog

아래와 같이 components의 동작을 제어하는 두 method를 생명 주기 method라고 한다.

```jsx
Clock extends React.Component {
  constructor(props) {
    super(props);
    this.state = {date: new Date()};
  }
	tick() {
	  this.setState({
    date: new Date()
  });
}
  componentDidMount() {
		this.timerID = setInterval(
    () => this.tick(),
    1000
  );
  }
  conponentDidUpdate() {
		console.log('새로운 상태를 가지고 난 후')
  }
  componentWillUnmount() {
		clearInterval(this.timerID);
  }
  render() {
    return (
      <div>
        <h1>Hello, world!</h1>
        <h2>It is {this.state.date.toLocaleTimeString()}.</h2>
      </div>
    );
  }
}
```