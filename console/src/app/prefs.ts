import { useSyncExternalStore } from "react";

export type Scheme = "dark" | "light";
export type Density = "comfortable" | "compact";
export type RailState = "expanded" | "collapsed";

export type Prefs = {
  scheme: Scheme;
  density: Density;
  rail: RailState;
};

const KEYS = {
  scheme: "cs-theme",
  density: "cs-density",
  rail: "cs-rail",
} as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // 隐私模式 / 存储被禁用：退回默认值,不能让整个控制台起不来
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 忽略 */
  }
}

function snapshot(): Prefs {
  return {
    // 默认亮色：编辑风的纸面是这套设计的基准面，暗色是同语义的镜像档
    scheme: read(KEYS.scheme) === "dark" ? "dark" : "light",
    density: read(KEYS.density) === "compact" ? "compact" : "comfortable",
    rail: read(KEYS.rail) === "collapsed" ? "collapsed" : "expanded",
  };
}

let cache = snapshot();
const listeners = new Set<() => void>();

function apply() {
  const root = document.documentElement;
  root.dataset.theme = cache.scheme;
  root.dataset.density = cache.density;
}

function commit() {
  cache = snapshot();
  apply();
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function get(): Prefs {
  return cache;
}

/** 首帧前调用一次：把已保存的偏好写进 <html>,避免亮/暗闪烁。 */
export function initPrefs() {
  apply();
}

export function setScheme(scheme: Scheme) {
  write(KEYS.scheme, scheme);
  commit();
}

export function toggleScheme() {
  setScheme(cache.scheme === "dark" ? "light" : "dark");
}

export function setDensity(density: Density) {
  write(KEYS.density, density);
  commit();
}

export function setRail(rail: RailState) {
  write(KEYS.rail, rail);
  commit();
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, get, get);
}