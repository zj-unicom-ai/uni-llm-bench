import { Popconfirm, Tooltip } from '../antdImports';
import { DeleteOutlined, CloseOutlined, ClearOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { PlaygroundHistoryItem } from '../hooks/usePlaygroundHistory';
import { formatRelativeTime } from '../utils/timeFormat';

interface Props {
  items: PlaygroundHistoryItem[];
  loading: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onClose: () => void;
  selectedId?: string;
}

export function PlaygroundHistorySidebar({
  items,
  loading,
  onSelect,
  onDelete,
  onClearAll,
  onClose,
  selectedId,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="w-full md:w-80 shrink-0 glass-card p-4 space-y-3 self-start sticky top-4 fixed md:static inset-0 z-50 md:z-auto overflow-y-auto md:overflow-visible bg-bg-primary md:bg-transparent">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-text-primary">{t('playgroundHistory.history')}</span>
          {items.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/8 text-text-tertiary font-mono">
              {items.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {items.length > 0 && (
            <Popconfirm
              title={t('playgroundHistory.clearAllConfirm')}
              onConfirm={onClearAll}
              okText={t('common.action.clear')}
              cancelText={t('common.action.cancel')}
            >
              <Tooltip title={t('common.action.clearAll')}>
                <button className="text-[12px] text-text-tertiary hover:text-accent-rose transition-colors p-1">
                  <ClearOutlined />
                </button>
              </Tooltip>
            </Popconfirm>
          )}
          <button
            onClick={onClose}
            className="text-[12px] text-text-tertiary hover:text-text-primary transition-colors p-1"
          >
            <CloseOutlined />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="space-y-1.5 overflow-y-auto max-h-[calc(100vh-200px)] pr-1">
        {loading && items.length === 0 && (
          <div className="text-center py-4 text-text-tertiary text-[12px] animate-pulse">
            {t('playgroundHistory.loading')}
          </div>
        )}
        {!loading && items.length === 0 && (
          <div className="text-center py-6 text-text-tertiary text-[12px]">{t('playgroundHistory.noHistory')}</div>
        )}
        {items.map((item) => (
          <div
            key={item.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(item.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(item.id);
              }
            }}
            className={`w-full text-left rounded border p-2.5 transition-colors group cursor-pointer ${
              selectedId === item.id
                ? 'border-accent-blue/40 bg-accent-blue/5'
                : 'border-border hover:border-border-hover bg-transparent'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-mono text-[11px] text-text-primary truncate max-w-[180px]">
                {item.providerName}/{item.modelName.includes('/') ? item.modelName.split('/').pop() : item.modelName}
              </span>
              <div className="flex items-center gap-1.5">
                {item.responseTime && (
                  <span className="text-[10px] text-text-tertiary font-mono">
                    {item.responseTime < 1000 ? `${item.responseTime}ms` : `${(item.responseTime / 1000).toFixed(1)}s`}
                  </span>
                )}
                {item.error && <span className="w-1.5 h-1.5 rounded-full bg-accent-rose" />}
              </div>
            </div>
            <div className="text-[11px] text-text-secondary truncate mb-1">{item.promptSnippet}</div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-text-tertiary">{formatRelativeTime(item.createdAt)}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(item.id);
                }}
                className="text-[10px] text-text-tertiary hover:text-accent-rose opacity-0 group-hover:opacity-100 transition-all p-0.5"
              >
                <DeleteOutlined />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
