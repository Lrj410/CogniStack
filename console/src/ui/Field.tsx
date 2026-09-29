import type {
  ChangeEvent,
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cx } from "./cx";

/**
 * 把 `hint` 关联到控件的 aria-describedby。
 * 提示文本原本只是纯视觉的，读屏器读不到 —— 而它承载的正是「这个字段怎么填」。
 */
function describedBy(rest: { "aria-describedby"?: string }, hintId: string | undefined) {
  if (!hintId) return rest["aria-describedby"];
  return [rest["aria-describedby"], hintId].filter(Boolean).join(" ") || undefined;
}

/** 字段外壳：标签 + 提示 + 控件。标签一定与控件绑定，提示一定被描述引用。 */
export function Field({
  label,
  hint,
  htmlFor,
  hintId,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  hintId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("field", className)}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput({
  label,
  hint,
  icon,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  icon?: ReactNode;
}) {
  const autoId = useId();
  const id = rest.id ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;

  const input = icon ? (
    <span className="input-wrap">
      {icon}
      <input {...rest} id={id} aria-describedby={describedBy(rest, hintId)} className={cx("input", className)} />
    </span>
  ) : (
    <input {...rest} id={id} aria-describedby={describedBy(rest, hintId)} className={cx("input", className)} />
  );

  if (!label) return input;
  return (
    <Field label={label} hint={hint} htmlFor={id} hintId={hintId}>
      {input}
    </Field>
  );
}

export type SelectOption = { value: string; label: string };

export function Select({
  label,
  hint,
  options,
  placeholder,
  className,
  custom = true,
  value,
  defaultValue,
  onChange,
  disabled,
  name,
  id: explicitId,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  hint?: string;
  placeholder?: string;
  options: SelectOption[];
  custom?: boolean;
}) {
  const autoId = useId();
  const id = explicitId ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;

  const [internalValue, setInternalValue] = useState<string>(() => {
    if (value !== undefined) return String(value);
    if (defaultValue !== undefined) return String(defaultValue);
    return "";
  });
  const currentVal = value !== undefined ? String(value) : internalValue;

  const [isOpen, setIsOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [isOpen]);

  const toggleOpen = () => {
    if (disabled) return;
    if (!isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setFlipUp(spaceBelow < 260 && rect.top > 260);
      setFilterQuery("");
    }
    setIsOpen((prev) => !prev);
  };

  const selectValue = useCallback(
    (nextVal: string) => {
      setInternalValue(nextVal);
      setIsOpen(false);
      if (onChange) {
        const syntheticEvent = {
          target: { value: nextVal, name: name ?? "" },
          currentTarget: { value: nextVal, name: name ?? "" },
          persist: () => {},
          preventDefault: () => {},
          stopPropagation: () => {},
        } as unknown as ChangeEvent<HTMLSelectElement>;
        onChange(syntheticEvent);
      }
      triggerRef.current?.focus();
    },
    [name, onChange],
  );

  const filteredOptions = filterQuery
    ? options.filter((o) => o.label.toLowerCase().includes(filterQuery.toLowerCase()))
    : options;

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!isOpen) {
        toggleOpen();
        setHighlightIdx(0);
      } else {
        setHighlightIdx((prev) => (prev + 1) % filteredOptions.length);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen) {
        toggleOpen();
        setHighlightIdx(filteredOptions.length - 1);
      } else {
        setHighlightIdx((prev) => (prev - 1 + filteredOptions.length) % filteredOptions.length);
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!isOpen) {
        toggleOpen();
      } else if (highlightIdx >= 0 && highlightIdx < filteredOptions.length) {
        const target = filteredOptions[highlightIdx];
        if (target) selectValue(target.value);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsOpen(false);
    } else if (e.key === "Tab") {
      setIsOpen(false);
    }
  };

  const selectedOpt = options.find((o) => o.value === currentVal);

  const customSelect = (
    <div className={cx("cselect", className)} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-describedby={describedBy(rest, hintId)}
        aria-label={rest["aria-label"]}
        disabled={disabled}
        className="cselect-trigger"
        onClick={toggleOpen}
        onKeyDown={handleKeyDown}
      >
        <span className={cx("cselect-value", !selectedOpt && "cselect-placeholder")}>
          {selectedOpt ? selectedOpt.label : (placeholder ?? "全部")}
        </span>
        <ChevronDown className="cselect-icon" aria-hidden />
      </button>

      {isOpen && (
        <ul className={cx("cselect-menu", flipUp && "cselect-menu--up")} role="listbox" tabIndex={-1}>
          {options.length > 7 ? (
            <li className="cselect-search-wrap">
              <input
                type="text"
                className="cselect-search"
                placeholder="搜索选项..."
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
            </li>
          ) : null}
          {placeholder && !filterQuery ? (
            <li
              role="option"
              aria-selected={currentVal === ""}
              className={cx("cselect-option", currentVal === "" && "cselect-selected")}
              onClick={() => selectValue("")}
            >
              <span>{placeholder}</span>
              {currentVal === "" ? <Check className="cselect-check" aria-hidden /> : null}
            </li>
          ) : null}
          {filteredOptions.length === 0 ? (
            <li className="cselect-empty">无可用选项</li>
          ) : (
            filteredOptions.map((opt, idx) => {
              const isSelected = opt.value === currentVal;
              const isHighlighted = idx === highlightIdx;
              return (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={isSelected}
                  className={cx(
                    "cselect-option",
                    isSelected && "cselect-selected",
                    isHighlighted && "cselect-option--active",
                  )}
                  onClick={() => selectValue(opt.value)}
                  onMouseEnter={() => setHighlightIdx(idx)}
                >
                  <span>{opt.label}</span>
                  {isSelected ? <Check className="cselect-check" aria-hidden /> : null}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );

  const nativeSelect = (
    <select
      {...rest}
      id={id}
      name={name}
      value={value}
      defaultValue={defaultValue}
      disabled={disabled}
      onChange={onChange}
      aria-describedby={describedBy(rest, hintId)}
      className={cx("select", className)}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );

  const rendered = custom ? customSelect : nativeSelect;
  if (!label) return rendered;
  return (
    <Field label={label} hint={hint} htmlFor={id} hintId={hintId}>
      {rendered}
    </Field>
  );
}

export function Textarea({
  label,
  hint,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: string }) {
  const autoId = useId();
  const id = rest.id ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;

  const area = (
    <textarea {...rest} id={id} aria-describedby={describedBy(rest, hintId)} className={cx("textarea", className)} />
  );

  if (!label) return area;
  return (
    <Field label={label} hint={hint} htmlFor={id} hintId={hintId}>
      {area}
    </Field>
  );
}
