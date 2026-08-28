// Vite 配置 —— 让 React 编译产物输出到 ../static/，覆盖原来的 vanilla 静态文件
// 这样 GitHub Pages workflow 不用改（继续部署 static/ 目录）。
//
// base 必须是仓库名（GitHub Pages 子路径部署），与 Pages URL 一致。
// 本地开发时 Vite 自动用 "/"，不影响。

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Vite 项目根：所有源文件（index.html、src/、public/）都从这里算
  root: "web",
  // 相对路径同时适用于：本地根路径 + GitHub Pages 子目录。
  base: "./",
  build: {
    // 关键：把构建产物输出到上层 static/ 目录（Pages 已经部署这个）
    outDir: "../static",
    // public/ 会在构建时重新复制图标；清空输出可防止哈希资源无限堆积。
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    minify: "esbuild",
    target: "es2020",
  },
  server: {
    port: 5173,
    proxy: {
      // 本地开发时把 /api/* 代理到 Python 后端（默认 8000 端口）
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
}));
