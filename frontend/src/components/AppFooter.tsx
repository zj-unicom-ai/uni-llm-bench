import { useTranslation } from 'react-i18next';
import { APP_NAME, APP_VERSION, COPYRIGHT_HOLDER, COPYRIGHT_YEAR } from '../constants';

/** Global footer with copyright and build info. */
export function AppFooter() {
  const { t } = useTranslation();

  return (
    <footer className="app-footer">
      <div className="flex items-center gap-2 min-w-0">
        <span>
          © {COPYRIGHT_YEAR} {COPYRIGHT_HOLDER}
        </span>
        <span className="text-border">·</span>
        <span>{t('footer.rights')}</span>
      </div>
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span>{t('footer.tagline')}</span>
        <span className="text-border">·</span>
        <span>
          {APP_NAME} {APP_VERSION}
        </span>
      </div>
    </footer>
  );
}
