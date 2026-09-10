import { useTranslation } from 'react-i18next';
import { Input, InputNumber, Switch, Tooltip } from '../antdImports';
import { InfoCircleOutlined } from '@ant-design/icons';

interface WorkflowBasicsProps {
  name: string;
  description: string;
  stopOnFailure: boolean;
  cooldown: number;
  selectedModelsCount: number;
  onNameChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onStopOnFailureChange: (v: boolean) => void;
  onCooldownChange: (v: number) => void;
}

/** Step 1 — workflow identity + global execution options. */
export function WorkflowBasics({
  name,
  description,
  stopOnFailure,
  cooldown,
  selectedModelsCount,
  onNameChange,
  onDescriptionChange,
  onStopOnFailureChange,
  onCooldownChange,
}: WorkflowBasicsProps) {
  const { t } = useTranslation();

  return (
    <section className="wf-rail-card" data-tour="config-basics">
      <div className="wf-section-head">
        <span className="wf-step-badge">1</span>
        <div>
          <h3>{t('workflow.setup')}</h3>
          <p>{t('workflow.configHint')}</p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="param-chip-label">{t('workflow.workflowName')}</label>
          <Input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={t('workflow.workflowName')}
            status={!name.trim() ? 'warning' : undefined}
            size="middle"
          />
        </div>

        <div className="space-y-1.5">
          <label className="param-chip-label">{t('workflow.description')}</label>
          <Input
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder={t('workflow.description')}
            size="middle"
          />
        </div>

        <div className="grid grid-cols-2 gap-3 pt-1">
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-bg-soft px-3 py-2">
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-[11.5px] font-medium text-text-secondary truncate">
                {t('workflow.stopOnFailure')}
              </span>
              <Tooltip title={t('workflow.stopOnFailureTooltip')}>
                <InfoCircleOutlined className="text-[10px] text-text-tertiary cursor-help shrink-0" />
              </Tooltip>
            </div>
            <Switch checked={stopOnFailure} onChange={onStopOnFailureChange} size="small" />
          </div>

          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-bg-soft px-3 py-2">
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-[11.5px] font-medium text-text-secondary truncate">
                {t('workflow.cooldown')}
              </span>
              <Tooltip title={t('workflow.cooldownTooltip')}>
                <InfoCircleOutlined className="text-[10px] text-text-tertiary cursor-help shrink-0" />
              </Tooltip>
            </div>
            <InputNumber
              changeOnBlur
              value={cooldown}
              onChange={(v) => onCooldownChange(v ?? 3000)}
              min={0}
              max={30000}
              step={1000}
              size="small"
              controls={false}
              className="font-mono w-[78px]"
              suffix="ms"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-md bg-accent-blue/[0.06] border border-accent-blue/20 px-3 py-2">
          <span className="text-[11px] text-text-secondary">
            {t('workflow.modelsSelected', { count: selectedModelsCount })}
          </span>
        </div>
      </div>
    </section>
  );
}
