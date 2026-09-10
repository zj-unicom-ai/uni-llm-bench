import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface TourStep {
  /** Value of the `data-tour` attribute on the element to highlight. */
  target: string;
  title: string;
  content: string;
}

interface GuidedTourProps {
  steps: TourStep[];
  /** Whether the tour is currently active. */
  run: boolean;
  onFinish: () => void;
}

interface SpotlightBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

const CARD_WIDTH = 320;
const CARD_GAP = 12;
const EDGE = 16;
const SPOTLIGHT_PADDING = 6;

/**
 * Lightweight spotlight tour. Highlights an element marked with `data-tour`
 * and shows an explanation card next to it. No external dependency.
 */
export function GuidedTour({ steps, run, onFinish }: GuidedTourProps) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<SpotlightBox | null>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const step = steps[index];
    if (!step) return;

    const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    if (!el) {
      // Target not rendered (e.g. different page) — centre the card instead.
      setSpot(null);
      setCardPos({
        top: Math.max(EDGE, window.innerHeight / 2 - 90),
        left: Math.max(EDGE, window.innerWidth / 2 - CARD_WIDTH / 2),
      });
      return;
    }

    const r = el.getBoundingClientRect();
    const box: SpotlightBox = {
      top: r.top - SPOTLIGHT_PADDING,
      left: r.left - SPOTLIGHT_PADDING,
      width: r.width + SPOTLIGHT_PADDING * 2,
      height: r.height + SPOTLIGHT_PADDING * 2,
    };
    setSpot(box);

    const cardH = cardRef.current?.offsetHeight ?? 170;
    let top = r.bottom + CARD_GAP;
    if (top + cardH > window.innerHeight - EDGE) {
      const above = r.top - cardH - CARD_GAP;
      top = above >= EDGE ? above : Math.max(EDGE, window.innerHeight - cardH - EDGE);
    }
    const centered = r.left + r.width / 2 - CARD_WIDTH / 2;
    const left = Math.min(Math.max(EDGE, centered), Math.max(EDGE, window.innerWidth - CARD_WIDTH - EDGE));
    setCardPos({ top, left });
  }, [index, steps]);

  // Restart from the first step whenever the tour is (re)opened.
  const [prevRun, setPrevRun] = useState(run);
  if (run !== prevRun) {
    setPrevRun(run);
    if (run) setIndex(0);
  }

  // Bring the target into view and measure it after layout settles.
  useLayoutEffect(() => {
    if (!run) return;
    const step = steps[index];
    if (!step) return;
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const raf = requestAnimationFrame(() => measure());
    return () => cancelAnimationFrame(raf);
  }, [run, index, steps, measure]);

  // Keep the spotlight aligned while the page moves or resizes.
  useEffect(() => {
    if (!run) return;
    const handler = () => measure();
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
    const timer = setInterval(handler, 400);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
      clearInterval(timer);
    };
  }, [run, measure]);

  // Esc closes the tour.
  useEffect(() => {
    if (!run) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFinish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run, onFinish]);

  if (!run || steps.length === 0) return null;

  const step = steps[index];
  if (!step) return null;
  const isLast = index === steps.length - 1;

  return (
    <>
      <div className="tour-backdrop" onClick={onFinish} aria-hidden="true" />
      {spot && (
        <div
          className="tour-spotlight"
          style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
          aria-hidden="true"
        />
      )}
      <div
        ref={cardRef}
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-label={t('guide.title')}
        style={{ top: cardPos?.top ?? EDGE, left: cardPos?.left ?? EDGE }}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-tertiary">
            {t('guide.stepOf', { current: index + 1, total: steps.length })}
          </span>
          <button
            onClick={onFinish}
            className="text-[11px] text-text-tertiary hover:text-text-primary transition-colors"
          >
            {t('guide.skip')}
          </button>
        </div>

        <h4 className="text-[14px] font-semibold text-text-primary mb-1.5">{step.title}</h4>
        <p className="text-[12px] leading-relaxed text-text-secondary mb-3.5">{step.content}</p>

        <div className="flex items-center gap-1.5 mb-3.5">
          {steps.map((s, i) => (
            <span
              key={s.target + i}
              className={`h-1 rounded-full transition-all ${
                i === index ? 'w-5 bg-accent-blue' : 'w-1.5 bg-black/20'
              }`}
            />
          ))}
        </div>

        <div className="flex items-center justify-end gap-2">
          {index > 0 && (
            <button
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              className="px-3 py-1.5 text-[12px] rounded-[6px] border border-border text-text-secondary hover:text-text-primary hover:border-border-hover transition-colors"
            >
              {t('guide.prev')}
            </button>
          )}
          <button
            onClick={() => (isLast ? onFinish() : setIndex((i) => i + 1))}
            className="px-3.5 py-1.5 text-[12px] font-medium rounded-[6px] text-white brand-gradient hover:opacity-90 transition-opacity"
          >
            {isLast ? t('guide.done') : t('guide.next')}
          </button>
        </div>
      </div>
    </>
  );
}
