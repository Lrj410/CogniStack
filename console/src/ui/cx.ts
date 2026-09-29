export type ClassValue = string | false | null | undefined;

/** 只做拼接与剔除假值 —— 不需要 tailwind-merge 那种冲突消解。 */
export function cx(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(" ");
}