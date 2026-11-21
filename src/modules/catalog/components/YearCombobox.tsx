import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useI18n } from '@/shared/i18n/i18n';
import styles from './YearCombobox.module.css';

const MIN_YEAR = 1880;
const MAX_YEAR = 2100;
/** The dropdown lists the years a catalogue can plausibly hold. */
const LIST_FIRST_YEAR = 1900;

interface YearComboboxProps {
  value: number | null;
  onCommit: (year: number | null) => void;
  label: string;
  placeholder: string;
}

/**
 * A year picker you can also type into: a field with a dropdown of years
 * (newest first). Typing narrows the list to the years that start with what
 * was typed; Enter or leaving the field commits a real year (or clears an
 * empty field), anything else falls back to the current value.
 */
export function YearCombobox({ value, onCommit, label, placeholder }: YearComboboxProps) {
  const { t } = useI18n();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const [lastValue, setLastValue] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Whether the viewer typed since opening: only then does the list narrow.
  const [typed, setTyped] = useState(false);

  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value == null ? '' : String(value));
  }

  const years = useMemo(() => {
    const newest = new Date().getFullYear() + 1;
    const all: number[] = [];
    for (let year = newest; year >= LIST_FIRST_YEAR; year -= 1) all.push(year);
    return all;
  }, []);
  const options = useMemo(
    () => (typed && draft ? years.filter((year) => String(year).startsWith(draft)) : years),
    [draft, typed, years],
  );

  const revert = () => setDraft(value == null ? '' : String(value));
  const commit = (text: string) => {
    const year = Number.parseInt(text, 10);
    if (!text.trim()) onCommit(null);
    else if (Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR) onCommit(year);
    else revert();
  };
  const close = () => {
    setOpen(false);
    setActive(-1);
    setTyped(false);
  };
  const choose = (year: number) => {
    setDraft(String(year));
    onCommit(year);
    close();
    inputRef.current?.focus();
  };

  // Opening scrolls the current year (or the first match) into view.
  useEffect(() => {
    if (!open) return;
    const target = listRef.current?.querySelector<HTMLElement>(
      active >= 0 ? `[data-index="${active}"]` : '[aria-selected="true"]',
    );
    target?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, options]);

  // A click anywhere else closes the list and commits what was typed.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      commit(draft);
      close();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft]);

  const move = (step: number) => {
    if (!open) {
      setOpen(true);
      return;
    }
    if (options.length === 0) return;
    setActive((current) => Math.min(options.length - 1, Math.max(0, current + step)));
  };

  return (
    <div className={styles.root} ref={rootRef}>
      <input
        ref={inputRef}
        className={`uiField ${styles.input}`}
        role="combobox"
        aria-label={t(label)}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        inputMode="numeric"
        maxLength={4}
        autoComplete="off"
        placeholder={t(placeholder)}
        value={draft}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setDraft(event.target.value.replace(/\D/g, ''));
          setTyped(true);
          setActive(-1);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            move(1);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            move(-1);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const highlighted = active >= 0 ? options[active] : undefined;
            if (highlighted !== undefined) choose(highlighted);
            else {
              commit(draft);
              close();
            }
          } else if (event.key === 'Escape' && open) {
            event.stopPropagation();
            revert();
            close();
          }
        }}
        onBlur={(event) => {
          // Moving into the list keeps it open; leaving the control commits.
          if (rootRef.current?.contains(event.relatedTarget as Node | null)) return;
          commit(draft);
          close();
        }}
      />
      <button
        type="button"
        className={styles.toggle}
        tabIndex={-1}
        aria-label={t(label)}
        aria-hidden="true"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) close();
          else {
            setOpen(true);
            inputRef.current?.focus();
          }
        }}
      >
        <ChevronDown size={14} />
      </button>
      {open && (
        <ul id={listId} ref={listRef} role="listbox" className={styles.list} aria-label={t(label)}>
          {options.length === 0 ? (
            <li className={styles.empty}>{t('No matching year')}</li>
          ) : (
            options.map((year, index) => (
              <li
                key={year}
                id={`${listId}-${index}`}
                role="option"
                data-index={index}
                aria-selected={year === value}
                className={`${styles.option} ${index === active ? styles.optionActive : ''} ${
                  year === value ? styles.optionSelected : ''
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(year)}
              >
                {year}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
