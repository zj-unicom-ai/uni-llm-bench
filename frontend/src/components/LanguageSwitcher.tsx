import { GlobalOutlined } from '@ant-design/icons';
import { Tooltip } from '../antdImports';
import { useLocale } from '../hooks/useLocale';

export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale();

  return (
    <Tooltip title={locale === 'en' ? '切换到中文' : 'Switch to English'}>
      <button
        onClick={() => setLocale(locale === 'en' ? 'zh' : 'en')}
        className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-black/20 text-text-secondary hover:text-text-primary hover:border-black/40 transition-colors"
      >
        <GlobalOutlined style={{ fontSize: 11 }} />
        {locale === 'en' ? '中文' : 'EN'}
      </button>
    </Tooltip>
  );
}
