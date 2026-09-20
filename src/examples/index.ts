// 内置示例库：标题 + 知识点 + 代码 + 说明
export interface Example {
  id: string;
  title: string;
  tags: string[];
  description: string;
  code: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'hello',
    title: 'Hello World',
    tags: ['printf', 'main'],
    description: '最小的完整程序：main 函数与 printf 输出。教学版无需 #include，printf 已内置。',
    code: `int main() {
    printf("Hello, World!\\n");
    return 0;
}`,
  },
  {
    id: 'variables',
    title: '变量与赋值',
    tags: ['变量', 'int', 'char'],
    description: '声明、初始化、赋值，观察变量监视器中值的变化。',
    code: `int main() {
    int a;
    int b = 10;
    a = b + 5;
    b = a * 2;
    char c = 'A';
    c = c + 1;
    return 0;
}`,
  },
  {
    id: 'arith',
    title: '算术表达式',
    tags: ['运算符', '优先级'],
    description: '加減乘除与取模，注意整数除法向零截断。求值轨迹展示子表达式顺序。',
    code: `int main() {
    int a = 3 + 4 * 2;
    int b = (3 + 4) * 2;
    int c = 7 / 2;
    int d = 7 % 3;
    double e = 7.0 / 2;
    return 0;
}`,
  },
  {
    id: 'incdec',
    title: '自增与自减',
    tags: ['++', '--', '前置后置'],
    description: '前置先加再取值，后置先取值再加。',
    code: `int main() {
    int i = 5;
    int a = i++;
    int b = ++i;
    int c = i--;
    int d = --i;
    return 0;
}`,
  },
  {
    id: 'if',
    title: 'if 判断',
    tags: ['if', '条件'],
    description: '观察条件求值与分支走向两个独立步骤。',
    code: `int main() {
    int a = 1;
    int b = 2;

    if (a < b) {
        a++;
    }

    return 0;
}`,
  },
  {
    id: 'if-else',
    title: 'if / else 分支',
    tags: ['if-else', '嵌套'],
    description: '条件不成立时走 else 分支；支持嵌套判断。',
    code: `int main() {
    int score = 76;
    int level;

    if (score >= 90) {
        level = 4;
    } else if (score >= 60) {
        level = 2;
        if (score >= 75) {
            level = 3;
        }
    } else {
        level = 0;
    }

    return 0;
}`,
  },
  {
    id: 'switch',
    title: 'switch 选择',
    tags: ['switch', 'case', 'default'],
    description: '观察表达式匹配哪个 case、default 何时执行、break 如何跳出。',
    code: `int main() {
    int day = 3;
    int type;

    switch (day) {
        case 1:
        case 2:
        case 3:
        case 4:
        case 5:
            type = 1;
            break;
        case 6:
        case 7:
            type = 2;
            break;
        default:
            type = 0;
    }

    return 0;
}`,
  },
  {
    id: 'fallthrough',
    title: 'switch 穿透',
    tags: ['fall-through', 'switch'],
    description: '没有 break 时执行会穿透到下一个 case，逐步观察穿透步骤。',
    code: `int main() {
    int level = 1;
    int score = 0;

    switch (level) {
        case 1:
            score = score + 1;
        case 2:
            score = score + 10;
        case 3:
            score = score + 100;
    }

    return 0;
}`,
  },
  {
    id: 'for',
    title: 'for 循环',
    tags: ['for', '循环'],
    description: 'init 只执行一次，每次判断条件，每轮执行体后更新。',
    code: `int main() {
    int sum = 0;

    for (int i = 1; i <= 10; i++) {
        sum = sum + i;
    }

    return 0;
}`,
  },
  {
    id: 'while',
    title: 'while 循环',
    tags: ['while', '循环'],
    description: '先判断后执行；每次条件判断都是独立步骤。',
    code: `int main() {
    int n = 100;
    int steps = 0;

    while (n > 1) {
        n = n / 2;
        steps++;
    }

    return 0;
}`,
  },
  {
    id: 'dowhile',
    title: 'do-while 循环',
    tags: ['do-while', '循环'],
    description: '先执行后判断，循环体至少执行一次。',
    code: `int main() {
    int x = 100;
    int count = 0;

    do {
        x = x / 3;
        count++;
    } while (x > 0);

    return 0;
}`,
  },
  {
    id: 'break-continue',
    title: 'break 与 continue',
    tags: ['break', 'continue'],
    description: 'break 跳出循环，continue 跳过本轮（for 仍会执行更新）。',
    code: `int main() {
    int sumOdd = 0;

    for (int i = 1; i <= 100; i++) {
        if (i % 2 == 0) {
            continue;
        }
        if (i > 10) {
            break;
        }
        sumOdd = sumOdd + i;
    }

    return 0;
}`,
  },
  {
    id: 'short-and',
    title: '短路求值 &&',
    tags: ['短路', '&&'],
    description: '左侧为假时右侧不执行——求值轨迹会标注「未执行」。',
    code: `int calls = 0;

int check(int v) {
    calls = calls + 1;
    return v;
}

int main() {
    int r1 = 0 && check(1);
    int r2 = 1 && check(1);
    return 0;
}`,
  },
  {
    id: 'short-or',
    title: '短路求值 ||',
    tags: ['短路', '||'],
    description: '左侧为真时右侧不执行。',
    code: `int calls = 0;

int check(int v) {
    calls = calls + 1;
    return v;
}

int main() {
    int r1 = 1 || check(1);
    int r2 = 0 || check(1);
    return 0;
}`,
  },
  {
    id: 'array',
    title: '数组遍历',
    tags: ['数组', 'for'],
    description: '一维数组在内存面板显示为格子，观察下标读写。',
    code: `int main() {
    int a[5] = {2, 4, 6, 8, 10};
    int sum = 0;

    for (int i = 0; i < 5; i++) {
        sum = sum + a[i];
    }

    int max = a[0];
    for (int i = 1; i < 5; i++) {
        if (a[i] > max) {
            max = a[i];
        }
    }

    return 0;
}`,
  },
  {
    id: 'function',
    title: '函数调用',
    tags: ['函数', '参数', '返回值'],
    description: '观察调用栈的压入与弹出、参数按值传递。',
    code: `int square(int n) {
    return n * n;
}

int sumSquares(int a, int b) {
    int s1 = square(a);
    int s2 = square(b);
    return s1 + s2;
}

int main() {
    int result = sumSquares(3, 4);
    return 0;
}`,
  },
  {
    id: 'factorial',
    title: '递归阶乘',
    tags: ['递归', '调用栈'],
    description: 'factorial(5) 的完整递归过程：调用栈先加深再逐层返回。',
    code: `int factorial(int n) {
    if (n <= 1) {
        return 1;
    }
    return n * factorial(n - 1);
}

int main() {
    int result = factorial(5);
    return 0;
}`,
  },
  {
    id: 'pointer',
    title: '指针基础',
    tags: ['指针', '&', '*'],
    description: '& 取地址，* 解引用。变量面板显示 p → #地址 (变量名)。',
    code: `int main() {
    int a = 5;
    int *p = &a;

    *p = 20;

    int b = a + *p;

    p = 0;
    return 0;
}`,
  },
  {
    id: 'pointer-swap',
    title: '指针交换',
    tags: ['指针', '函数'],
    description: '通过指针参数交换两个变量的值——指针教学的经典案例。',
    code: `void swap(int *pa, int *pb) {
    int t = *pa;
    *pa = *pb;
    *pb = t;
}

int main() {
    int a = 3;
    int b = 7;
    swap(&a, &b);
    return 0;
}`,
  },
  {
    id: 'goto-loop',
    title: 'goto 循环',
    tags: ['goto', '标签'],
    description: '用 goto 和标签构造循环，观察程序位置的跳转来源与目标。',
    code: `int main() {
    int i = 0;
    int sum = 0;

LOOP:
    i++;
    sum = sum + i;
    if (i < 10) {
        goto LOOP;
    }

    return 0;
}`,
  },
  {
    id: 'array-pointer',
    title: '指针与数组',
    tags: ['指针', '数组'],
    description: '指针指向数组元素，通过 *p 读写 a[i]。',
    code: `void set(int *dst, int v) {
    *dst = v;
}

int main() {
    int a[5] = {0};

    int *p = &a[0];
    *p = 100;

    p = &a[2];
    *p = 300;

    set(&a[4], 500);

    int sum = a[0] + a[2] + a[4];
    return 0;
}`,
  },
];
