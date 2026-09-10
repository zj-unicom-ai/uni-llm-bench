import i18next from 'i18next';

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return i18next.t('common.time.justNow');
  if (mins < 60) return i18next.t('common.time.minutesAgo', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return i18next.t('common.time.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return i18next.t('common.time.daysAgo', { count: days });
}
