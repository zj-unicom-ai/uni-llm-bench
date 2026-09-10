import type { WorkflowTemplate } from './types';

/**
 * Tiny bridge that lets the module library "apply" a template: the library
 * stores a serialized WorkflowTemplate in sessionStorage, then navigates to
 * /workflow where WorkflowConfigPanel consumes and loads it on mount.
 */
const PENDING_KEY = 'llm-bench.pendingTemplate';

export function setPendingTemplate(tpl: WorkflowTemplate): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(tpl));
  } catch {
    /* ignore quota / serialization issues */
  }
}

export function consumePendingTemplate(): WorkflowTemplate | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_KEY);
    return JSON.parse(raw) as WorkflowTemplate;
  } catch {
    return null;
  }
}
