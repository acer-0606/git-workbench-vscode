import type * as React from 'react';
import type { IgnoreWhitespace } from '@git-workbench/domain';

export interface WhitespaceChange { readonly ignoreWhitespace: IgnoreWhitespace; readonly clearSelection: true }

interface Props {
  readonly value: IgnoreWhitespace;
  readonly settingsDefault: IgnoreWhitespace;
  readonly selectedCount: number;
  readonly onSessionWhitespaceChange: (change: WhitespaceChange) => void;
  readonly onPersistDefault: (value: IgnoreWhitespace) => void;
}

const options: readonly { readonly value: IgnoreWhitespace; readonly label: string }[] = [
  { value: 'none', label: '显示全部空白' },
  { value: 'eol', label: '忽略行尾空白' },
  { value: 'all', label: '忽略全部空白' },
];

/**
 * The three-state whitespace control. A normal click only changes the current
 * session (and clears the selection); persisting a new default is a separate,
 * explicit action so the VS Code setting is never written implicitly.
 */
export function CompareToolbar({ value, settingsDefault, selectedCount, onSessionWhitespaceChange, onPersistDefault }: Props): React.JSX.Element {
  return (
    <div role="toolbar" aria-label="比较选项">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onSessionWhitespaceChange({ ignoreWhitespace: option.value, clearSelection: true })}
        >
          {option.label}
        </button>
      ))}
      <span>已选 {selectedCount} 块</span>
      <button type="button" onClick={() => onPersistDefault(value)}>设为默认（{settingsDefault}）</button>
    </div>
  );
}
