import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Input,
  InputNumber,
  Switch,
  Modal,
  Popconfirm,
  Segmented,
  Spin,
  Tooltip,
} from '../antdImports';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  CopyOutlined,
  SearchOutlined,
  PlayCircleOutlined,
  UpOutlined,
  DownOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { useTemplates, type EditableTask, type TemplatePayload } from '../hooks/useTemplates';
import { setPendingTemplate } from '../workflowTemplateBridge';
import type { WorkflowTemplateRecord } from '../types';

type FilterKey = 'all' | 'builtin' | 'custom';

interface TemplateForm {
  name: string;
  description: string;
  options: { stopOnFailure: boolean; cooldownBetweenTasks: number };
  tasks: EditableTask[];
}

const blankTask = (): EditableTask => ({
  name: '',
  description: '',
  prompt: '',
  systemPrompt: '',
  maxTokens: 500,
  concurrency: 1,
  iterations: 10,
  streaming: true,
});

function recordToForm(tpl: WorkflowTemplateRecord): TemplateForm {
  return {
    name: tpl.name,
    description: tpl.description || '',
    options: {
      stopOnFailure: tpl.options?.stopOnFailure ?? true,
      cooldownBetweenTasks: tpl.options?.cooldownBetweenTasks ?? 0,
    },
    tasks: (tpl.tasks || []).map((tk) => ({
      name: tk.name,
      description: tk.description || '',
      prompt: tk.config.prompt || '',
      systemPrompt: tk.config.systemPrompt || '',
      maxTokens: tk.config.maxTokens || 500,
      concurrency: tk.config.concurrency || 1,
      iterations: tk.config.iterations || 10,
      streaming: tk.config.streaming ?? true,
    })),
  };
}

function formToPayload(form: TemplateForm): TemplatePayload {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    options: {
      stopOnFailure: form.options.stopOnFailure,
      cooldownBetweenTasks: form.options.cooldownBetweenTasks,
    },
    // Each task's benchmark settings go under `config` — that matches the
    // backend `WorkflowTaskSchema` and the stored/loaded template shape.
    // Sending them flat at the task top level fails Zod validation with
    // "expected object, received undefined" (the missing `config` field).
    tasks: form.tasks.map((tk) => ({
      name: tk.name.trim(),
      description: tk.description?.trim() || undefined,
      config: {
        prompt: tk.prompt,
        systemPrompt: tk.systemPrompt?.trim() || undefined,
        maxTokens: tk.maxTokens,
        concurrency: tk.concurrency,
        iterations: tk.iterations,
        streaming: tk.streaming,
      },
    })),
  };
}

export function ModuleLibraryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { templates, loading, createTemplate, updateTemplate, removeTemplate } = useTemplates();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateForm>({
    name: '',
    description: '',
    options: { stopOnFailure: true, cooldownBetweenTasks: 0 },
    tasks: [blankTask()],
  });
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return templates.filter((tpl) => {
      if (filter === 'builtin' && !tpl.builtin) return false;
      if (filter === 'custom' && tpl.builtin) return false;
      if (!q) return true;
      return (
        tpl.name.toLowerCase().includes(q) ||
        (tpl.description || '').toLowerCase().includes(q)
      );
    });
  }, [templates, search, filter]);

  const builtinCount = templates.filter((t) => t.builtin).length;
  const customCount = templates.length - builtinCount;

  const openCreate = () => {
    setEditingId(null);
    setForm({
      name: '',
      description: '',
      options: { stopOnFailure: true, cooldownBetweenTasks: 0 },
      tasks: [blankTask()],
    });
    setCollapsed(new Set());
    setModalOpen(true);
  };

  const openEdit = (tpl: WorkflowTemplateRecord) => {
    if (tpl.builtin) return;
    setEditingId(tpl.id);
    setForm(recordToForm(tpl));
    setCollapsed(new Set());
    setModalOpen(true);
  };

  const openDuplicate = (tpl: WorkflowTemplateRecord) => {
    setEditingId(null);
    const base = recordToForm(tpl);
    base.name = `${tpl.name} ${t('modules.copySuffix')}`;
    setForm(base);
    setCollapsed(new Set());
    setModalOpen(true);
  };

  const applyTemplate = (tpl: WorkflowTemplateRecord) => {
    setPendingTemplate(tpl);
    navigate('/workflow');
  };

  const updateTask = (idx: number, patch: Partial<EditableTask>) => {
    setForm((f) => ({
      ...f,
      tasks: f.tasks.map((tk, i) => (i === idx ? { ...tk, ...patch } : tk)),
    }));
  };

  const removeTask = (idx: number) => {
    setForm((f) => ({ ...f, tasks: f.tasks.filter((_, i) => i !== idx) }));
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
  };

  const addTask = () => {
    setForm((f) => ({ ...f, tasks: [...f.tasks, blankTask()] }));
  };

  const toggleCollapse = (idx: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      Modal.warning({ title: t('modules.nameRequired') });
      return;
    }
    const invalid = form.tasks.find((tk) => !tk.name.trim() || !tk.prompt.trim());
    if (invalid) {
      Modal.warning({ title: t('modules.taskInvalid') });
      return;
    }
    const payload = formToPayload(form);
    const saved = editingId
      ? await updateTemplate(editingId, payload)
      : await createTemplate(payload);
    if (saved) setModalOpen(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="glass-card p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-[20px] font-semibold tracking-tight brand-text-gradient">
              {t('page.modules.title')}
            </h2>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-black/5 text-text-tertiary">
              {customCount} {t('modules.custom')} · {builtinCount} {t('modules.builtin')}
            </span>
          </div>
          <p className="text-[13px] text-text-secondary leading-relaxed">
            {t('page.modules.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Input
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('modules.search')}
            prefix={<SearchOutlined className="text-text-tertiary" />}
            style={{ width: 200 }}
          />
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium rounded-[8px] text-white brand-gradient hover:opacity-90 transition-opacity shadow-[0_6px_20px_rgba(37,99,235,0.3)] whitespace-nowrap"
          >
            <PlusOutlined style={{ fontSize: 13 }} />
            {t('modules.newTemplate')}
          </button>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Segmented
          value={filter}
          onChange={(v) => setFilter(v as FilterKey)}
          options={[
            { label: t('modules.filter.all'), value: 'all' },
            { label: t('modules.filter.builtin'), value: 'builtin' },
            { label: t('modules.filter.custom'), value: 'custom' },
          ]}
        />
        <span className="text-[12px] text-text-tertiary font-mono">
          {filtered.length} / {templates.length}
        </span>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass-card p-12 text-center w-full max-w-2xl mx-auto space-y-3">
          <div className="w-12 h-12 rounded-2xl brand-gradient flex items-center justify-center text-white text-xl mx-auto">
            <PlusOutlined />
          </div>
          <div className="text-[15px] font-medium text-text-primary">
            {search || filter !== 'all' ? t('modules.noMatch') : t('modules.empty')}
          </div>
          <p className="text-[13px] text-text-secondary leading-relaxed">
            {t('modules.emptyHint')}
          </p>
          <button
            onClick={openCreate}
            className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium rounded-[8px] text-white brand-gradient hover:opacity-90 transition-opacity"
          >
            <PlusOutlined style={{ fontSize: 13 }} />
            {t('modules.newTemplate')}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((tpl) => (
            <div key={tpl.id} className="module-card">
              <div className="flex items-start justify-between gap-2 mb-2">
                <h3 className="text-[15px] font-semibold text-text-primary leading-snug break-words">
                  {tpl.name}
                </h3>
                <span className={`tpl-badge ${tpl.builtin ? 'tpl-badge--builtin' : 'tpl-badge--custom'}`}>
                  {tpl.builtin ? t('modules.builtin') : t('modules.custom')}
                </span>
              </div>
              <p className="module-desc text-[12.5px] text-text-secondary leading-relaxed mb-3 min-h-[36px]">
                {tpl.description || t('modules.noDesc')}
              </p>
              <div className="mt-auto flex items-center gap-2 text-[11px] text-text-tertiary font-mono mb-3">
                <span className="px-2 py-0.5 rounded bg-black/5">
                  {tpl.tasks?.length ?? 0} {t('common.unit.tasks')}
                </span>
                {!tpl.builtin && tpl.updatedAt && (
                  <span>{t('modules.updatedAt', { date: new Date(tpl.updatedAt).toLocaleDateString() })}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 pt-3 border-t border-border">
                <button
                  onClick={() => applyTemplate(tpl)}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-medium rounded-[8px] text-white brand-gradient hover:opacity-90 transition-opacity"
                >
                  <PlayCircleOutlined style={{ fontSize: 13 }} />
                  {t('modules.apply')}
                </button>
                <Tooltip title={t('modules.duplicate')}>
                  <button
                    onClick={() => openDuplicate(tpl)}
                    className="p-2 rounded-[8px] border border-border text-text-secondary hover:text-accent-blue hover:border-accent-blue/40 transition-all"
                    aria-label={t('modules.duplicate')}
                  >
                    <CopyOutlined style={{ fontSize: 13 }} />
                  </button>
                </Tooltip>
                {!tpl.builtin && (
                  <>
                    <Tooltip title={t('modules.edit')}>
                      <button
                        onClick={() => openEdit(tpl)}
                        className="p-2 rounded-[8px] border border-border text-text-secondary hover:text-accent-violet hover:border-accent-violet/40 transition-all"
                        aria-label={t('modules.edit')}
                      >
                        <EditOutlined style={{ fontSize: 13 }} />
                      </button>
                    </Tooltip>
                    <Popconfirm
                      title={t('modules.confirmDelete')}
                      okText={t('common.action.delete')}
                      cancelText={t('common.action.cancel')}
                      okButtonProps={{ danger: true }}
                      onConfirm={() => removeTemplate(tpl.id)}
                    >
                      <button
                        className="p-2 rounded-[8px] border border-border text-text-secondary hover:text-accent-rose hover:border-accent-rose/40 transition-all"
                        aria-label={t('modules.delete')}
                      >
                        <DeleteOutlined style={{ fontSize: 13 }} />
                      </button>
                    </Popconfirm>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit modal */}
      <Modal
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        title={editingId ? t('modules.editTemplate') : t('modules.newTemplate')}
        width={780}
        style={{ top: 24 }}
        footer={
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-text-tertiary font-mono">
              {form.tasks.length} {t('common.unit.tasks')}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setModalOpen(false)}
                className="px-4 py-1.5 text-[13px] font-medium rounded-[8px] border border-border text-text-secondary hover:border-border-hover transition-all"
              >
                {t('common.action.cancel')}
              </button>
              <button
                onClick={handleSave}
                className="px-4 py-1.5 text-[13px] font-medium rounded-[8px] text-white brand-gradient hover:opacity-90 transition-opacity"
              >
                {t('common.action.save')}
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
          {/* Name + description */}
          <div className="space-y-2">
            <label className="text-[11px] font-medium text-text-secondary">{t('modules.name')}</label>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t('modules.namePlaceholder')}
            />
          </div>
          <div className="space-y-2">
            <label className="text-[11px] font-medium text-text-secondary">{t('modules.description')}</label>
            <Input.TextArea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder={t('modules.descriptionPlaceholder')}
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </div>

          {/* Options */}
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex items-center gap-2">
              <Switch
                checked={form.options.stopOnFailure}
                onChange={(v) => setForm((f) => ({ ...f, options: { ...f.options, stopOnFailure: v } }))}
                size="small"
              />
              <span className="text-[12px] text-text-secondary">{t('modules.stopOnFailure')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-text-secondary">{t('modules.cooldown')}</span>
              <InputNumber
                value={form.options.cooldownBetweenTasks}
                onChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    options: { ...f.options, cooldownBetweenTasks: v ?? 0 },
                  }))
                }
                min={0}
                max={60000}
                step={500}
                size="small"
                className="font-mono"
                style={{ width: 110 }}
                addonAfter="ms"
              />
            </div>
          </div>

          {/* Tasks */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="section-header" data-color="blue">
                {t('modules.tasks')}
              </span>
              <button
                onClick={addTask}
                className="flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium rounded-[7px] border border-accent-blue/30 text-accent-blue hover:bg-accent-blue/[0.06] transition-all"
              >
                <PlusOutlined style={{ fontSize: 11 }} />
                {t('modules.addTask')}
              </button>
            </div>

            <div className="space-y-2.5">
              {form.tasks.map((tk, idx) => {
                const isCollapsed = collapsed.has(idx);
                return (
                  <div key={idx} className="task-editor-row">
                    <div className="task-editor-row__head" onClick={() => toggleCollapse(idx)}>
                      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent-blue/10 text-accent-blue text-[11px] font-bold">
                        {idx + 1}
                      </span>
                      <span className="text-[13px] font-medium text-text-primary truncate flex-1">
                        {tk.name || t('modules.taskUntitled', { n: idx + 1 })}
                      </span>
                      <span className="text-[10px] font-mono text-text-tertiary">
                        {tk.concurrency}×{tk.iterations}
                      </span>
                      <button
                        className="p-1 text-text-tertiary hover:text-text-primary"
                        aria-label="toggle"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCollapse(idx);
                        }}
                      >
                        {isCollapsed ? <DownOutlined style={{ fontSize: 11 }} /> : <UpOutlined style={{ fontSize: 11 }} />}
                      </button>
                      {form.tasks.length > 1 && (
                        <button
                          className="p-1 text-text-tertiary hover:text-accent-rose"
                          aria-label={t('modules.deleteTask')}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeTask(idx);
                          }}
                        >
                          <CloseOutlined style={{ fontSize: 11 }} />
                        </button>
                      )}
                    </div>
                    {!isCollapsed && (
                      <div className="task-editor-row__body space-y-3">
                        <Input
                          value={tk.name}
                          onChange={(e) => updateTask(idx, { name: e.target.value })}
                          placeholder={t('modules.taskNamePlaceholder')}
                        />
                        <div className="space-y-1">
                          <label className="text-[11px] text-text-secondary">{t('modules.prompt')}</label>
                          <Input.TextArea
                            value={tk.prompt}
                            onChange={(e) => updateTask(idx, { prompt: e.target.value })}
                            placeholder={t('modules.promptPlaceholder')}
                            autoSize={{ minRows: 3, maxRows: 8 }}
                            style={{ fontSize: 13 }}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[11px] text-text-secondary">{t('modules.systemPrompt')}</label>
                          <Input.TextArea
                            value={tk.systemPrompt}
                            onChange={(e) => updateTask(idx, { systemPrompt: e.target.value })}
                            placeholder={t('modules.systemPromptPlaceholder')}
                            autoSize={{ minRows: 2, maxRows: 6 }}
                            style={{ fontSize: 13 }}
                          />
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <div className="space-y-1">
                            <label className="text-[10px] text-text-tertiary">{t('modules.maxTokens')}</label>
                            <InputNumber
                              value={tk.maxTokens}
                              onChange={(v) => updateTask(idx, { maxTokens: v ?? 500 })}
                              min={50}
                              max={32000}
                              size="small"
                              className="font-mono w-full"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[10px] text-text-tertiary">{t('modules.concurrency')}</label>
                            <InputNumber
                              value={tk.concurrency}
                              onChange={(v) => updateTask(idx, { concurrency: v ?? 1 })}
                              min={1}
                              max={5000}
                              size="small"
                              className="font-mono w-full"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[10px] text-text-tertiary">{t('modules.iterations')}</label>
                            <InputNumber
                              value={tk.iterations}
                              onChange={(v) => updateTask(idx, { iterations: v ?? 10 })}
                              min={1}
                              max={10000000}
                              size="small"
                              className="font-mono w-full"
                            />
                          </div>
                          <div className="space-y-1 flex flex-col justify-end">
                            <label className="text-[10px] text-text-tertiary">{t('modules.streaming')}</label>
                            <Switch
                              checked={tk.streaming}
                              onChange={(v) => updateTask(idx, { streaming: v })}
                              size="small"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
