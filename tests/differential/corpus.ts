// 差分测试语料：全部限定 defined behavior 的程序（SEMANTIC_MODEL §9）
// 每个程序在 gcc（或 clang）与 C-Visualizer 中的 stdout 必须一致。
// 约束：无 UB（E_UB 检测通过）、无未初始化读取、无溢出依赖、浮点仅用
// 可精确表示的二进制小数（.5/.25 等）、printf 不用宽度/精度修饰。
export interface CorpusCase {
  id: string;
  /** 覆盖的语义点 */
  focus: string;
  code: string;
}

export const CORPUS: CorpusCase[] = [
  {
    id: 'int-arithmetic',
    focus: 'int 四则与优先级',
    code: `int main() {
    int a = 17;
    int b = 5;
    printf("%d\\n", a + b);
    printf("%d\\n", a - b);
    printf("%d\\n", a * b);
    printf("%d\\n", a / b);
    printf("%d\\n", a % b);
    printf("%d\\n", (a + b) * 2 - b);
    return 0;
}`,
  },
  {
    id: 'int-division-negative',
    focus: '负数除法与取模（向零截断）',
    code: `int main() {
    printf("%d\\n", -7 / 2);
    printf("%d\\n", -7 % 2);
    printf("%d\\n", 7 / -2);
    printf("%d\\n", 7 % -2);
    return 0;
}`,
  },
  {
    id: 'char-arithmetic',
    focus: 'char 参与算术（ASCII）',
    code: `int main() {
    char c = 'A';
    char d = c + 1;
    printf("%d\\n", c);
    printf("%c\\n", d);
    printf("%d\\n", 'z' - 'a');
    return 0;
}`,
  },
  {
    id: 'float-exact',
    focus: '浮点算术（可精确表示值）',
    code: `int main() {
    double x = 1.5;
    double y = 0.25;
    printf("%f\\n", x + y);
    printf("%f\\n", x - y);
    printf("%f\\n", x * y);
    printf("%f\\n", x / y);
    return 0;
}`,
  },
  {
    id: 'comparisons',
    focus: '比较运算结果为 0/1',
    code: `int main() {
    int a = 3;
    int b = 9;
    printf("%d %d %d %d %d %d\\n", a < b, a > b, a == b, a != b, a <= 3, b >= 10);
    return 0;
}`,
  },
  {
    id: 'logical-short-circuit',
    focus: '&& || 与 !',
    code: `int main() {
    int a = 0;
    int b = 5;
    printf("%d\\n", a && b);
    printf("%d\\n", a || b);
    printf("%d\\n", !a);
    printf("%d\\n", !!b);
    printf("%d\\n", b > 1 && b < 10);
    return 0;
}`,
  },
  {
    id: 'nested-expr',
    focus: '嵌套表达式与一元负号',
    code: `int main() {
    int x = 4;
    printf("%d\\n", -(x + 2) * 3);
    printf("%d\\n", +x - -x);
    printf("%d\\n", ((x * x) + (x % 3)) / 2);
    return 0;
}`,
  },
  {
    id: 'incdec',
    focus: '前置/后置自增自减（无顺序冲突）',
    code: `int main() {
    int i = 5;
    printf("%d\\n", i++);
    printf("%d\\n", i);
    printf("%d\\n", ++i);
    printf("%d\\n", i--);
    printf("%d\\n", --i);
    return 0;
}`,
  },
  {
    id: 'while-loop',
    focus: 'while 累加',
    code: `int main() {
    int i = 1;
    int sum = 0;
    while (i <= 10) {
        sum = sum + i;
        i++;
    }
    printf("%d\\n", sum);
    return 0;
}`,
  },
  {
    id: 'for-loop',
    focus: 'for 与复合赋值',
    code: `int main() {
    int prod = 1;
    for (int i = 1; i <= 6; i++) {
        prod *= i;
    }
    printf("%d\\n", prod);
    return 0;
}`,
  },
  {
    id: 'do-while',
    focus: 'do-while 至少执行一次',
    code: `int main() {
    int n = 0;
    int rounds = 0;
    do {
        n += 2;
        rounds++;
    } while (n < 7);
    printf("%d %d\\n", n, rounds);
    return 0;
}`,
  },
  {
    id: 'nested-loops-break-continue',
    focus: '嵌套循环 + break/continue',
    code: `int main() {
    int total = 0;
    for (int i = 0; i < 5; i++) {
        for (int j = 0; j < 5; j++) {
            if (j > i) break;
            if ((i + j) % 2 == 1) continue;
            total++;
        }
    }
    printf("%d\\n", total);
    return 0;
}`,
  },
  {
    id: 'switch-fallthrough',
    focus: 'switch 穿透与 break',
    code: `int classify(int v) {
    switch (v) {
        case 1:
        case 2:
            return 10;
        case 3:
            v = v + 1;
        case 4:
            return v * 2;
        default:
            return -1;
    }
}
int main() {
    printf("%d %d %d %d %d\\n", classify(1), classify(2), classify(3), classify(4), classify(9));
    return 0;
}`,
  },
  {
    id: 'array-sum-max',
    focus: '数组遍历求和与最大值',
    code: `int main() {
    int a[6] = {3, 7, 1, 9, 4, 6};
    int sum = 0;
    int max = a[0];
    for (int i = 0; i < 6; i++) {
        sum += a[i];
        if (a[i] > max) max = a[i];
    }
    printf("%d %d\\n", sum, max);
    return 0;
}`,
  },
  {
    id: 'array-partial-init',
    focus: '部分初始化补零',
    code: `int main() {
    int a[5] = {8, 9};
    int s = 0;
    for (int i = 0; i < 5; i++) s += a[i];
    printf("%d\\n", s);
    return 0;
}`,
  },
  {
    id: 'array-reverse-write',
    focus: '数组写入与逆序访问',
    code: `int main() {
    int a[5];
    for (int i = 0; i < 5; i++) a[i] = i * i;
    for (int i = 4; i >= 0; i--) printf("%d ", a[i]);
    printf("\\n");
    return 0;
}`,
  },
  {
    id: 'globals',
    focus: '全局变量（含未初始化零值）',
    code: `int counter;
int base = 100;
int table[4];

int bump(void) {
    counter++;
    return base + counter;
}
int main() {
    printf("%d\\n", counter);
    int r1 = bump();
    int r2 = bump();
    printf("%d %d\\n", r1, r2);
    printf("%d %d %d %d\\n", table[0], table[1], table[2], table[3]);
    return 0;
}`,
  },
  {
    id: 'function-args',
    focus: '多参数函数与按值传递',
    code: `int mix(int a, int b, int c) {
    return a * 100 + b * 10 + c;
}
int main() {
    int x = 2;
    printf("%d\\n", mix(x, x + 1, x * 2));
    printf("%d\\n", x);
    return 0;
}`,
  },
  {
    id: 'recursion-factorial',
    focus: '递归阶乘',
    code: `int fact(int n) {
    if (n <= 1) return 1;
    return n * fact(n - 1);
}
int main() {
    printf("%d\\n", fact(10));
    return 0;
}`,
  },
  {
    id: 'recursion-fib',
    focus: '递归斐波那契',
    code: `int fib(int n) {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
}
int main() {
    printf("%d\\n", fib(15));
    return 0;
}`,
  },
  {
    id: 'pointer-swap',
    focus: '指针参数交换',
    code: `void swap(int *a, int *b) {
    int t = *a;
    *a = *b;
    *b = t;
}
int main() {
    int x = 3;
    int y = 8;
    swap(&x, &y);
    printf("%d %d\\n", x, y);
    return 0;
}`,
  },
  {
    id: 'pointer-through-array',
    focus: '指针指向数组元素',
    code: `int main() {
    int a[4] = {10, 20, 30, 40};
    int *p = &a[1];
    *p = 99;
    p = &a[3];
    *p = *p + 1;
    printf("%d %d %d %d\\n", a[0], a[1], a[2], a[3]);
    return 0;
}`,
  },
  {
    id: 'scope-shadowing',
    focus: '块作用域遮蔽',
    code: `int main() {
    int x = 1;
    {
        int x = 2;
        printf("%d\\n", x);
        x = x + 10;
        printf("%d\\n", x);
    }
    printf("%d\\n", x);
    return 0;
}`,
  },
  {
    id: 'implicit-conversions',
    focus: '隐式数值转换（赋值/参数/返回）',
    code: `int truncTo(double v) {
    return v;
}
double widen(int v) {
    return v + 0.5;
}
int main() {
    int a = 2.75;
    double b = 3;
    char c = 66;
    printf("%d\\n", a);
    printf("%f\\n", b);
    printf("%c\\n", c);
    printf("%d\\n", truncTo(7.9));
    printf("%f\\n", widen(4));
    return 0;
}`,
  },
  {
    id: 'goto-constructs',
    focus: 'goto 前向/后向（同层序列）',
    code: `int main() {
    int i = 0;
    int sum = 0;
LOOP:
    sum += i;
    i++;
    if (i < 5) goto LOOP;
    printf("%d\\n", sum);
    goto SKIP;
    sum = -1;
SKIP:
    printf("%d\\n", sum);
    return 0;
}`,
  },
  {
    id: 'compound-assign-chain',
    focus: '复合赋值与连续赋值',
    code: `int main() {
    int a = 10;
    int b = 3;
    a += b;
    a -= 1;
    a %= 7;
    printf("%d\\n", a);
    int x = 0;
    int y = 0;
    x = y = 5;
    printf("%d %d\\n", x, y);
    return 0;
}`,
  },
];
