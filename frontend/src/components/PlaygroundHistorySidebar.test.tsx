import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlaygroundHistorySidebar } from './PlaygroundHistorySidebar';
import type { PlaygroundHistoryItem } from '../hooks/usePlaygroundHistory';

// Minimal antd mocks to avoid full antd rendering
vi.mock('../antdImports', () => ({
  Popconfirm: ({ children, onConfirm }: any) => (
    <div data-testid="popconfirm" onClick={onConfirm}>
      {children}
    </div>
  ),
  Tooltip: ({ children }: any) => <>{children}</>,
}));

vi.mock('@ant-design/icons', () => ({
  DeleteOutlined: () => <span data-testid="delete-icon">delete</span>,
  CloseOutlined: () => <span data-testid="close-icon">close</span>,
  ClearOutlined: () => <span data-testid="clear-icon">clear</span>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'playgroundHistory.history': 'History',
        'playgroundHistory.clearAllConfirm': 'Clear all history?',
        'playgroundHistory.clearAll': 'Clear all',
        'playgroundHistory.loading': 'Loading...',
        'playgroundHistory.noHistory': 'No history yet. Run a prompt to see it here.',
        'common.action.clear': 'Clear',
        'common.action.cancel': 'Cancel',
        'common.action.clearAll': 'Clear all',
        'common.time.justNow': 'just now',
      };
      return map[key] ?? key;
    },
  }),
}));

vi.mock('../utils/timeFormat', () => ({
  formatRelativeTime: () => 'just now',
}));

function makeItem(overrides: Partial<PlaygroundHistoryItem> = {}): PlaygroundHistoryItem {
  return {
    id: 'item-1',
    providerName: 'OpenAI',
    providerId: 'openai-1',
    modelName: 'gpt-4',
    promptSnippet: 'Hello world',
    createdAt: new Date().toISOString(),
    responseTime: 1500,
    ...overrides,
  };
}

const defaultProps = {
  items: [] as PlaygroundHistoryItem[],
  loading: false,
  onSelect: vi.fn(),
  onDelete: vi.fn(),
  onClearAll: vi.fn(),
  onClose: vi.fn(),
};

describe('PlaygroundHistorySidebar', () => {
  describe('empty and loading states', () => {
    it('shows empty message when no items and not loading', () => {
      render(<PlaygroundHistorySidebar {...defaultProps} />);
      expect(screen.getByText('No history yet. Run a prompt to see it here.')).toBeInTheDocument();
    });

    it('shows loading message when loading with no items', () => {
      render(<PlaygroundHistorySidebar {...defaultProps} loading={true} />);
      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });

    it('does not show empty message when loading', () => {
      render(<PlaygroundHistorySidebar {...defaultProps} loading={true} />);
      expect(screen.queryByText('No history yet. Run a prompt to see it here.')).not.toBeInTheDocument();
    });
  });

  describe('rendering items', () => {
    it('displays model name and prompt snippet', () => {
      const items = [makeItem({ modelName: 'claude-3', promptSnippet: 'Test prompt' })];
      render(<PlaygroundHistorySidebar {...defaultProps} items={items} />);
      expect(screen.getByText('OpenAI/claude-3')).toBeInTheDocument();
      expect(screen.getByText('Test prompt')).toBeInTheDocument();
    });

    it('formats response time in seconds for >= 1000ms', () => {
      const items = [makeItem({ responseTime: 2500 })];
      render(<PlaygroundHistorySidebar {...defaultProps} items={items} />);
      expect(screen.getByText('2.5s')).toBeInTheDocument();
    });

    it('formats response time in ms for < 1000ms', () => {
      const items = [makeItem({ responseTime: 450 })];
      render(<PlaygroundHistorySidebar {...defaultProps} items={items} />);
      expect(screen.getByText('450ms')).toBeInTheDocument();
    });

    it('shows error indicator for items with errors', () => {
      const items = [makeItem({ error: 'timeout' })];
      const { container } = render(<PlaygroundHistorySidebar {...defaultProps} items={items} />);
      const errorDot = container.querySelector('.bg-accent-rose');
      expect(errorDot).toBeInTheDocument();
    });

    it('shows item count badge when items exist', () => {
      const items = [makeItem(), makeItem({ id: 'item-2' })];
      render(<PlaygroundHistorySidebar {...defaultProps} items={items} />);
      expect(screen.getByText('2')).toBeInTheDocument();
    });
  });

  describe('interactions', () => {
    it('calls onSelect when item is clicked', () => {
      const onSelect = vi.fn();
      const items = [makeItem({ id: 'click-test' })];
      render(<PlaygroundHistorySidebar {...defaultProps} items={items} onSelect={onSelect} />);

      const item = screen.getByText('OpenAI/gpt-4').closest('[role="button"]')!;
      fireEvent.click(item);
      expect(onSelect).toHaveBeenCalledWith('click-test');
    });

    it('calls onSelect on Enter key', () => {
      const onSelect = vi.fn();
      const items = [makeItem({ id: 'key-test' })];
      render(<PlaygroundHistorySidebar {...defaultProps} items={items} onSelect={onSelect} />);

      const item = screen.getByText('OpenAI/gpt-4').closest('[role="button"]')!;
      fireEvent.keyDown(item, { key: 'Enter' });
      expect(onSelect).toHaveBeenCalledWith('key-test');
    });

    it('calls onSelect on Space key', () => {
      const onSelect = vi.fn();
      const items = [makeItem({ id: 'space-test' })];
      render(<PlaygroundHistorySidebar {...defaultProps} items={items} onSelect={onSelect} />);

      const item = screen.getByText('OpenAI/gpt-4').closest('[role="button"]')!;
      fireEvent.keyDown(item, { key: ' ' });
      expect(onSelect).toHaveBeenCalledWith('space-test');
    });

    it('calls onDelete when delete button is clicked without triggering onSelect', () => {
      const onSelect = vi.fn();
      const onDelete = vi.fn();
      const items = [makeItem({ id: 'del-test' })];
      render(<PlaygroundHistorySidebar {...defaultProps} items={items} onSelect={onSelect} onDelete={onDelete} />);

      const deleteBtn = screen.getByTestId('delete-icon').closest('button')!;
      fireEvent.click(deleteBtn);
      expect(onDelete).toHaveBeenCalledWith('del-test');
      // onSelect should NOT be called because stopPropagation
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('calls onClose when close button is clicked', () => {
      const onClose = vi.fn();
      render(<PlaygroundHistorySidebar {...defaultProps} onClose={onClose} />);

      const closeBtn = screen.getByTestId('close-icon').closest('button')!;
      fireEvent.click(closeBtn);
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('selected state', () => {
    it('highlights the selected item', () => {
      const items = [makeItem({ id: 'sel-1' }), makeItem({ id: 'sel-2', modelName: 'gpt-3.5' })];
      render(<PlaygroundHistorySidebar {...defaultProps} items={items} selectedId="sel-1" />);

      const selectedItem = screen.getByText('OpenAI/gpt-4').closest('[role="button"]')!;
      expect(selectedItem.className).toContain('border-accent-blue');
    });
  });

  // === REGRESSION TESTS ===

  describe('regression: no nested buttons (QA bug #1)', () => {
    it('history item container is NOT a <button> element', () => {
      const items = [makeItem()];
      render(<PlaygroundHistorySidebar {...defaultProps} items={items} />);

      const itemContainer = screen.getByText('OpenAI/gpt-4').closest('[role="button"]')!;
      expect(itemContainer.tagName).not.toBe('BUTTON');
      // Should be a div with role="button"
      expect(itemContainer.tagName).toBe('DIV');
      expect(itemContainer.getAttribute('role')).toBe('button');
    });

    it('delete button IS a real <button> element', () => {
      const items = [makeItem()];
      render(<PlaygroundHistorySidebar {...defaultProps} items={items} />);

      const deleteBtn = screen.getByTestId('delete-icon').closest('button')!;
      expect(deleteBtn.tagName).toBe('BUTTON');
    });

    it('no <button> is nested inside another <button>', () => {
      const items = [makeItem(), makeItem({ id: 'item-2', modelName: 'gpt-3.5' })];
      const { container } = render(<PlaygroundHistorySidebar {...defaultProps} items={items} />);

      const allButtons = container.querySelectorAll('button');
      for (const btn of allButtons) {
        // No button ancestor should also be a button
        let parent = btn.parentElement;
        while (parent) {
          expect(parent.tagName).not.toBe('BUTTON');
          parent = parent.parentElement;
        }
      }
    });

    it('item container has tabIndex for keyboard accessibility', () => {
      const items = [makeItem()];
      render(<PlaygroundHistorySidebar {...defaultProps} items={items} />);

      const itemContainer = screen.getByText('OpenAI/gpt-4').closest('[role="button"]')!;
      expect(itemContainer.getAttribute('tabindex')).toBe('0');
    });
  });
});
