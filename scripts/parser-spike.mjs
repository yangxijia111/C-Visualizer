// Parser 可行性验证脚本：
// 验证 web-tree-sitter + tree-sitter-c 能否解析 C 教学子集，并暴露可用的树结构字段。
import { Parser, Language } from 'web-tree-sitter';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('tree-sitter-c/tree-sitter-c.wasm');

const SAMPLE = `
int g = 100;

int add(int a, int b) {
    return a + b;
}

int factorial(int n) {
    if (n <= 1) {
        return 1;
    }
    return n * factorial(n - 1);
}

int main() {
    int a = 1;
    int b = 2;
    int arr[5];
    float f = 3.5;
    char c = 'x';
    int *p = &a;

    if (a < b) {
        a++;
    } else {
        b--;
    }

    switch (a) {
        case 1:
            a += 10;
            break;
        case 2:
        case 3:
            a = 0;
            break;
        default:
            break;
    }

    for (int i = 0; i < 5; i++) {
        if (i == 2) continue;
        if (i == 4) break;
        arr[i] = i * 2;
    }

    int j = 0;
    while (j < 3) {
        j = j + 1;
    }

    do {
        j--;
    } while (j > 0);

    printf("%d %f %c\\n", a, f, c);
    int r = add(a, 5) && factorial(4) || 0;
    *p = r;
    p = &arr[2];

    goto END;
    a = 999;
END:
    return 0;
}
`;

const BAD = `
int main() {
    int a = ;
    struct Point { int x; };
    return 0
}
`;

// 遍历节点并返回 [fieldName, child] 列表（基于 0.27 的 fieldNameForChild API）
function* fieldEntries(node) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    yield [node.fieldNameForChild(i), child];
  }
}

async function main() {
  await Parser.init();
  const language = await Language.load(wasmPath);
  const parser = new Parser();
  parser.setLanguage(language);

  const tree = parser.parse(SAMPLE);
  console.log('== 教学子集样例 ==');
  console.log('root:', tree.rootNode.type, '| hasError:', tree.rootNode.hasError);
  if (tree.rootNode.hasError) process.exit(1);

  const mainFn = tree.rootNode.namedChildren.find(
    (c) => c.type === 'function_definition' && c.text.startsWith('int main'),
  );
  console.log('main 字段:', [...fieldEntries(mainFn)].map(([f, c]) => `${f ?? '-'}:${c.type}`).join(' '));
  const body = mainFn.childForFieldName('body');

  console.log('\n== 函数体内语句形态 ==');
  const seen = new Set();
  for (const st of body.namedChildren) {
    const fields = [...fieldEntries(st)].map(([f, c]) => `${f}:${c.type}`).filter((x) => !x.startsWith('-')).join(',');
    if (seen.has(st.type)) continue;
    seen.add(st.type);
    console.log(`  ${st.type} {${fields}} :: ${st.text.split('\n')[0].slice(0, 46)}`);
  }

  console.log('\n== 声明形态（含指针/数组/多声明符） ==');
  for (const st of body.namedChildren) {
    if (st.type !== 'declaration') continue;
    const baseType = st.childForFieldName('type')?.text;
    for (const [f, d] of fieldEntries(st)) {
      if (f === 'type') continue;
      console.log(`  [${baseType}] ${d.type} :: ${d.text}`);
    }
  }

  console.log('\n== switch / for / do-while / goto 结构抽查 ==');
  const kinds = { switch_statement: 'switch', for_statement: 'for', do_statement: 'do', goto_statement: 'goto', labeled_statement: 'label' };
  const walk = (node, depth) => {
    if (kinds[node.type] && depth <= 5) {
      const fields = [...fieldEntries(node)].map(([f, c]) => `${f}:${c.type}`).filter((x) => !x.startsWith('-')).join(',');
      console.log(`  ${node.type} {${fields}}`);
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && c.isNamed) walk(c, depth + 1);
    }
  };
  walk(tree.rootNode, 0);

  console.log('\n== 错误代码错误恢复 ==');
  const badTree = parser.parse(BAD);
  console.log('hasError:', badTree.rootNode.hasError);
  const errs = [];
  const findErrors = (node) => {
    if (node.type === 'ERROR' || node.isMissing) {
      errs.push(`${node.type}@${node.startPosition.row + 1}:${node.startPosition.column} "${node.text.slice(0, 20)}"`);
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) findErrors(c);
    }
  };
  findErrors(badTree.rootNode);
  console.log(errs.join('\n') || '（未找到 ERROR 节点）');

  const structTree = parser.parse('int main() { struct P { int x; }; return 0; }');
  console.log('\nstruct 语法上是否报错:', structTree.rootNode.hasError, '（false=语法合法，需语义检查层拒绝）');

  console.log('\nSPIKE OK');
}

main().catch((e) => {
  console.error('SPIKE FAILED:', e);
  process.exit(1);
});
