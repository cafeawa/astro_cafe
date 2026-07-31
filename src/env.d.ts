/// <reference types="astro/client" />

// @waline/client 的 "./style" 导出直接指向 dist/waline.css，包内没有 types 字段，
// 侧边导入时 TS 无法解析，补一个环境声明。
declare module '@waline/client/style';
