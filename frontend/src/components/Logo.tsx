import { APP_NAME, APP_VERSION } from '../constants';

/**
 * Uni LLM Bench brand mark.
 * A rounded gradient tile holding three ascending bars: the bars stand for
 * measured results, the ascending order for comparison, the shared baseline
 * for "one unified benchmark across every provider".
 */
export function LogoMark({ size = 34, radius = 10 }: { size?: number; radius?: number }) {
  return (
    <div
      className="brand-gradient flex items-center justify-center flex-shrink-0"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        boxShadow: '0 4px 14px rgba(37, 99, 235, 0.32)',
      }}
      aria-hidden="true"
    >
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="none">
        {/* unified baseline across every provider */}
        <line x1="3" y1="20" x2="21" y2="20" stroke="#ffffff" strokeOpacity="0.32" strokeWidth="1.4" strokeLinecap="round" />
        {/* slower model */}
        <rect x="4.5" y="11.5" width="4.6" height="8.5" rx="2.3" fill="#ffffff" fillOpacity="0.66" />
        {/* faster model */}
        <rect x="15" y="5.5" width="4.6" height="14.5" rx="2.3" fill="#ffffff" />
        {/* comparison trend line connecting the two peaks */}
        <polyline points="6.8,11.5 17.3,5.5" fill="none" stroke="#ffffff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        {/* peak / first-token point */}
        <circle cx="17.3" cy="5.5" r="2.2" fill="#ffffff" />
      </svg>
    </div>
  );
}

/** Mark + wordmark, used in the sidebar header and login screen. */
export function LogoLockup({
  size = 34,
  showVersion = true,
  subtitle,
}: {
  size?: number;
  showVersion?: boolean;
  subtitle?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <LogoMark size={size} />
      <div className="min-w-0">
        <div
          className="font-semibold text-text-primary leading-tight tracking-tight truncate"
          style={{ fontSize: size >= 40 ? 16 : 14 }}
        >
          {APP_NAME}
        </div>
        <div className="text-[10px] text-text-tertiary mt-0.5 font-mono truncate">
          {subtitle ?? (showVersion ? APP_VERSION : '')}
        </div>
      </div>
    </div>
  );
}
