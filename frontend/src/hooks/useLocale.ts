import { useTranslation } from 'react-i18next';
import zhCN from 'antd/es/locale/zh_CN';
import enUS from 'antd/es/locale/en_US';

const LOCALE_MAP: Record<string, any> = { zh: zhCN, en: enUS };

export function useLocale() {
  const { i18n } = useTranslation();
  const locale = i18n.language?.startsWith('zh') ? 'zh' : 'en';

  const setLocale = (lang: string) => {
    i18n.changeLanguage(lang);
  };

  return {
    locale,
    setLocale,
    antdLocale: LOCALE_MAP[locale] || enUS,
  };
}
