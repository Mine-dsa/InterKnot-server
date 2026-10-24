/**
 * DM 入队仅在 message 控制器 send 中触发（带 sender/conversation hints）。
 * 此处不再重复入队，避免与 controller 双路径各跑一遍判定 + Redis。
 */
export default {};
