// 词法作用域类型环境（静态检查用）
// 与运行时 interpreter/index.ts 的 Scope 栈层级一一对应（docs/SEMANTIC_MODEL.md §2）
import type { CType } from './types';

/** 作用域种类（展示与调试用） */
export type ScopeKind = 'global' | 'function' | 'block' | 'for' | 'switch';

/** 单层作用域：名字 → 类型 */
interface ScopeFrame {
  kind: ScopeKind;
  vars: Map<string, CType>;
}

/**
 * 词法作用域栈：
 *  - lookup 由内向外，命中即止（内层遮蔽外层）
 *  - declare 只进当前层；同层同名返回 false（调用方报 E_DECL）
 *  - pushScope / popScope 严格配对（pop 空栈抛错，视为内部缺陷）
 */
export class TypeEnvironment {
  private stack: ScopeFrame[] = [{ kind: 'global', vars: new Map() }];

  get currentDepth(): number {
    return this.stack.length;
  }

  get currentKind(): ScopeKind {
    return this.stack[this.stack.length - 1].kind;
  }

  pushScope(kind: ScopeKind): void {
    this.stack.push({ kind, vars: new Map() });
  }

  popScope(): void {
    if (this.stack.length <= 1) {
      throw new Error('内部错误：试图弹出全局作用域');
    }
    this.stack.pop();
  }

  /** 在当前作用域声明；同层已存在同名 → false */
  declare(name: string, type: CType): boolean {
    const frame = this.stack[this.stack.length - 1];
    if (frame.vars.has(name)) return false;
    frame.vars.set(name, type);
    return true;
  }

  hasInCurrentScope(name: string): boolean {
    return this.stack[this.stack.length - 1].vars.has(name);
  }

  /** 由内向外查找；未找到 → undefined */
  lookup(name: string): CType | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const t = this.stack[i].vars.get(name);
      if (t !== undefined) return t;
    }
    return undefined;
  }

  /** 当前层条目（用于调试/快照） */
  entriesInCurrentScope(): ReadonlyMap<string, CType> {
    return this.stack[this.stack.length - 1].vars;
  }
}
