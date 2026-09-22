// 统一运行时收敛（Runtime Coercion）
// 所有「值进入对象」的边界共用同一实现（docs/SEMANTIC_MODEL.md §3.2）：
// 变量初始化 / 赋值写回 / 形参绑定 / return / 数组元素（初始化列表与赋值）。
// 除此之外不得出现零散的 Math.trunc / |0 / &0xff 转换。
import type { RuntimeValue } from './values';
import { intValue, charValue, floatValue, pointerValue } from './values';
import type { CType } from './types';
import { isPointer } from './types';

/**
 * 把运行时值收敛到目标类型。
 * - int：截断为 32 位有符号
 * - char：低 8 位（教学简化：无符号字节）
 * - float/double：数值不变（同为 JS double）
 * - pointer：值不变；目标类型的 pointee 元数据以调用方（检查器已验证）为准
 * 目标为数组 / void 属于类型系统违规，原值返回（检查器保证不会到达）。
 */
export function coerceRuntimeValue(v: RuntimeValue, target: CType): RuntimeValue {
  if (typeof target === 'string') {
    switch (target) {
      case 'int': return intValue(v.value);
      case 'char': return charValue(v.value);
      case 'float':
      case 'double': return floatValue(v.value, target);
      case 'void': return v;
    }
  }
  if (isPointer(target)) {
    return pointerValue(v.value, target.pointee);
  }
  // 数组目标：不可赋值（检查器拦截），原值返回
  return v;
}
