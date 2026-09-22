// TypeEnvironment 单元测试：作用域栈的全部行为约定
import { describe, expect, it } from 'vitest';
import { TypeEnvironment } from '../src/core/scope-env';

describe('TypeEnvironment 基础', () => {
  it('全局层声明与查找', () => {
    const env = new TypeEnvironment();
    expect(env.declare('g', 'int')).toBe(true);
    expect(env.lookup('g')).toBe('int');
    expect(env.lookup('nope')).toBeUndefined();
  });

  it('同层重复声明返回 false', () => {
    const env = new TypeEnvironment();
    expect(env.declare('x', 'int')).toBe(true);
    expect(env.declare('x', 'double')).toBe(false);
    // 类型保持首次声明
    expect(env.lookup('x')).toBe('int');
  });

  it('popScope 后变量不可见', () => {
    const env = new TypeEnvironment();
    env.pushScope('block');
    env.declare('x', 'int');
    expect(env.lookup('x')).toBe('int');
    env.popScope();
    expect(env.lookup('x')).toBeUndefined();
  });

  it('弹出全局作用域是内部错误', () => {
    const env = new TypeEnvironment();
    expect(() => env.popScope()).toThrow();
  });

  it('depth 与当前种类', () => {
    const env = new TypeEnvironment();
    expect(env.currentDepth).toBe(1);
    expect(env.currentKind).toBe('global');
    env.pushScope('function');
    env.pushScope('for');
    expect(env.currentDepth).toBe(3);
    expect(env.currentKind).toBe('for');
    env.popScope();
    expect(env.currentKind).toBe('function');
  });
});

describe('TypeEnvironment 遮蔽语义', () => {
  it('内层遮蔽外层，弹出后恢复外层类型', () => {
    const env = new TypeEnvironment();
    env.declare('x', 'int');
    env.pushScope('block');
    env.declare('x', 'double');
    expect(env.lookup('x')).toBe('double');
    env.popScope();
    expect(env.lookup('x')).toBe('int');
  });

  it('hasInCurrentScope 只看当前层', () => {
    const env = new TypeEnvironment();
    env.declare('g', 'int');
    env.pushScope('block');
    expect(env.hasInCurrentScope('g')).toBe(false);
    expect(env.lookup('g')).toBe('int');
    env.declare('g', 'double');
    expect(env.hasInCurrentScope('g')).toBe(true);
  });

  it('兄弟作用域互不可见', () => {
    const env = new TypeEnvironment();
    env.pushScope('block');
    env.declare('a', 'int');
    env.popScope();
    env.pushScope('block');
    expect(env.lookup('a')).toBeUndefined();
    env.declare('a', 'double'); // 兄弟块同名不冲突
    expect(env.lookup('a')).toBe('double');
    env.popScope();
  });

  it('多层嵌套逐层向外查找', () => {
    const env = new TypeEnvironment();
    env.declare('lvl1', 'int');
    env.pushScope('function');
    env.declare('lvl2', 'int');
    env.pushScope('block');
    env.declare('lvl3', 'int');
    expect(env.lookup('lvl1')).toBe('int');
    expect(env.lookup('lvl2')).toBe('int');
    expect(env.lookup('lvl3')).toBe('int');
    env.popScope();
    expect(env.lookup('lvl3')).toBeUndefined();
    expect(env.lookup('lvl2')).toBe('int');
  });

  it('复合类型（数组/指针）作为值', () => {
    const env = new TypeEnvironment();
    env.declare('arr', { kind: 'array', elem: 'int', length: 5 });
    env.declare('p', { kind: 'pointer', pointee: 'int' });
    expect(env.lookup('arr')).toEqual({ kind: 'array', elem: 'int', length: 5 });
    expect(env.lookup('p')).toEqual({ kind: 'pointer', pointee: 'int' });
  });
});
