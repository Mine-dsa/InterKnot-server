/**
 * 集中暴露 Strapi 内部类型的稳定别名，避免在各业务文件里散落易碎的深层 import。
 * 如果将来 Strapi 调整了 dist 目录结构，只需在此处改一处。
 */

// 数据库生命周期钩子（beforeCreate/afterUpdate/...）的事件对象类型。
// 注意：Strapi 官方该接口的 params/result 字段本身就是宽松类型（any），
// 因此用它替换 `event: any` 不会引入新的类型收紧风险，但能表达 action/model/state 等结构。
export type { Event as LifecycleEvent } from '@strapi/database/dist/lifecycles/types';
