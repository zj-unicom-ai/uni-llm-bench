import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Segmented, Empty, Tag } from '../antdImports';
import { WorkflowTemplate } from '../types';

type TemplateTab = 'all' | 'builtin' | 'custom';

interface TemplateGalleryProps {
  templates: WorkflowTemplate[];
  getName: (name: string) => string;
  getDesc: (name: string, fallback: string) => string;
  onLoad: (template: WorkflowTemplate) => void;
}

/** Step 3 — quick-start from a curated benchmark template. */
export function TemplateGallery({ templates, getName, getDesc, onLoad }: TemplateGalleryProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TemplateTab>('all');

  const visible = useMemo(() => {
    if (tab === 'builtin') return templates.filter((tp) => tp.builtin === true);
    if (tab === 'custom') return templates.filter((tp) => tp.builtin !== true);
    return templates;
  }, [tab, templates]);

  const counts = useMemo(
    () => ({
      all: templates.length,
      builtin: templates.filter((tp) => tp.builtin === true).length,
      custom: templates.filter((tp) => tp.builtin !== true).length,
    }),
    [templates],
  );

  return (
    <section className="wf-rail-card">
      <div className="wf-section-head">
        <span className="wf-step-badge">3</span>
        <div>
          <h3>{t('workflow.quickTemplates')}</h3>
          <p>{t('workflow.templatesHint')}</p>
        </div>
      </div>

      <div className="template-tabs" style={{ marginBottom: 12 }}>
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as TemplateTab)}
          options={[
            { label: `${t('workflow.templateTabAll')} (${counts.all})`, value: 'all' },
            { label: `${t('workflow.templateTabBuiltin')} (${counts.builtin})`, value: 'builtin' },
            { label: `${t('workflow.templateTabCustom')} (${counts.custom})`, value: 'custom' },
          ]}
        />
      </div>

      {visible.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t('workflow.templateEmpty', { scope: t(`workflow.templateTab${tab[0].toUpperCase()}${tab.slice(1)}`) })}
          style={{ margin: '12px 0' }}
        />
      ) : (
        <div className="template-grid">
          {visible.map((template) => (
            <button
              key={template.id ?? template.name}
              type="button"
              className="template-card"
              onClick={() => onLoad(template)}
            >
              <div className="t-name">
                <span>{getName(template.name)}</span>
                {template.builtin !== true && <Tag color="purple">{t('workflow.templateCustomBadge')}</Tag>}
                <span className="t-meta">{t('workflow.templateTasks', { count: template.tasks.length })}</span>
              </div>
              <div className="t-desc">{getDesc(template.name, template.description)}</div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
