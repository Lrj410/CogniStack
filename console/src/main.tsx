import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./ui";
import { initPrefs } from "./app/prefs";

/*
 * 样式必须先于 App 导入。
 * ESM 按导入声明的顺序求值，而 Vite 按求值顺序拼接 CSS —— App 先导入时，
 * 各页面自己的 css 会排到原语层（ui.css）**之前**，于是 `.st-select` 这类
 * 「同名同特异性」的页面规则会被 `.select` 静默压掉（踩过：工具条三个下拉撑满整行）。
 * 顺序：字体 → 令牌 → 基础 → 原语 → 外壳 → 图表 → 页面（后者覆盖前者）。
 */
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/app.css";
import "./styles/charts.css";
import App from "./App";

// 首帧之前落主题/密度，避免亮暗闪烁（CSP 禁止内联脚本，只能在这里做）
initPrefs();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);