# CogniStack Console

Vite + React 实时控制台。视觉方向：**现代极简编辑风**——暖中性纸面画布 + 纯白内容面，
发丝结构线，唯一高饱和强调色（冷蓝 `#2563eb` / 暗色 `#6ea8fe`）；
骨架是「导航栏 + 顶栏 + 状态栏」，**默认亮色**。
定调、令牌与版式体检基线见 [`DESIGN.md`](./DESIGN.md)。

## 开发

```bash
# 根目录一键：引擎 :7331 + 控制台 :5173
npm start

# 或仅前端（需另开引擎）
npm run console:dev
```

## 构建

```bash
npm run console:build
```

产物在 `console/dist`，由 `tools/viz-server.cjs` 托管。

## 门禁（改完样式必跑）

这两个脚本定义在 `console/package.json`，**不在根包**里，所以要么先 `cd console`，
要么在根目录用 `--prefix`：

```bash
npm --prefix console run qa:classes   # 静态类名审计（CSS 定义 ↔ TSX 引用）
npm --prefix console run qa:layout    # 浏览器版式体检（需先起 7331；2 主题 × 2 密度 × 10 宽度 × 8 路由）
npm --prefix console run qa           # 两者
```

判据是 `qa:layout` 的 **FAIL 0** 与 **WARN·可处理 0**。