import { useTranslation } from 'react-i18next';
import { RocketOutlined } from '@ant-design/icons';

export type WorkflowStage = 'configure' | 'running' | 'results';

interface StepperProps {
  stage: WorkflowStage;
}

const ORDER: WorkflowStage[] = ['configure', 'running', 'results'];

/**
 * Horizontal stepper that tells the user where they are in the
 * configure → run → inspect-results flow.
 */
export function WorkflowStepper({ stage }: StepperProps) {
  const { t } = useTranslation();
  const activeIndex = ORDER.indexOf(stage);

  return (
    <div className="flex items-center w-full" data-tour="workflow-steps">
      {ORDER.map((key, i) => {
        const done = i < activeIndex;
        const active = i === activeIndex;
        return (
          <div key={key} className="flex items-center flex-1 min-w-0 last:flex-none">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-semibold font-mono flex-shrink-0 transition-all ${
                  active
                    ? 'text-white brand-gradient shadow-[0_3px_12px_rgba(37,99,235,0.35)]'
                    : done
                      ? 'bg-accent-teal/15 text-accent-teal border border-accent-teal/30'
                      : 'bg-black/[0.04] text-text-tertiary border border-black/10'
                }`}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                className={`text-[12px] font-medium whitespace-nowrap truncate ${
                  active ? 'text-text-primary' : 'text-text-tertiary'
                }`}
              >
                {t(`workflow.stages.${key}`)}
              </span>
            </div>
            {i < ORDER.length - 1 && (
              <div
                className={`flex-1 h-px mx-3 transition-colors ${
                  i < activeIndex ? 'bg-accent-teal/40' : 'bg-black/10'
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface HeroProps {
  onStartTour: () => void;
}

/**
 * First-run hero: explains what to do before the user has any results.
 */
export function GettingStartedHero({ onStartTour }: HeroProps) {
  const { t } = useTranslation();

  const steps = [
    { icon: '✏️', text: t('page.heroStep1') },
    { icon: '🔌', text: t('page.heroStep2') },
    { icon: '⚙️', text: t('page.heroStep3') },
    { icon: '📊', text: t('page.heroStep4') },
  ];

  return (
    <div className="hero-panel">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 md:gap-6 items-start">
        <div className="min-w-0 w-full">
          <div className="flex items-center gap-2 mb-2">
            <RocketOutlined className="text-accent-blue text-[15px]" />
            <span className="text-[11px] font-mono uppercase tracking-[0.14em] text-accent-blue">
              {t('page.heroEyebrow')}
            </span>
          </div>
          <h2 className="text-[22px] font-semibold tracking-tight mb-1.5 brand-text-gradient break-words">
            {t('page.heroTitle')}
          </h2>
          <p className="text-[13px] text-text-secondary leading-relaxed w-full">
            {t('page.heroDesc')}
          </p>
        </div>
        <button
          onClick={onStartTour}
          className="justify-self-start md:justify-self-auto px-4 py-2 text-[12px] font-medium rounded-[8px] text-white brand-gradient hover:opacity-90 transition-opacity shadow-[0_6px_20px_rgba(37,99,235,0.3)]"
        >
          {t('guide.startTour')}
        </button>
      </div>

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {steps.map((s, i) => (
          <div
            key={i}
            className="surface-soft p-3.5 flex items-start gap-2.5 hover:border-border-hover transition-colors"
          >
            <span className="text-[15px] leading-none mt-0.5">{s.icon}</span>
            <span className="text-[12px] text-text-secondary leading-relaxed">{s.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
