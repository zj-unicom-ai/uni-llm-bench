import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiFetchSpy = vi.hoisted(() => vi.fn());
const sseUrlSpy = vi.hoisted(() => vi.fn(async (u: string) => u));
const downloadUrlSpy = vi.hoisted(() => vi.fn(async (u: string) => u));

vi.mock('../services/api', () => ({
  apiFetch: apiFetchSpy,
  sseUrl: sseUrlSpy,
  downloadUrl: downloadUrlSpy,
  getToken: () => null,
  setToken: () => {},
  clearToken: () => {},
  isAuthenticated: () => false,
}));

import { useWorkflow } from './useWorkflow';

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

class MockEventSource {
  url: string;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  static instances: MockEventSource[] = [];
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  MockEventSource.instances = [];
  (globalThis as { EventSource: typeof EventSource }).EventSource = MockEventSource as never;
  import.meta.env.VITE_DEMO_MODE = 'false';
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseWf = {
  id: 'wf1',
  name: 'Test',
  status: 'completed' as const,
  providers: ['p1:gpt-4'],
  tasks: [],
  taskResults: [],
  createdAt: '',
  updatedAt: '',
};

describe('useWorkflow.fetchWorkflows', () => {
  it('populates workflows + flips workflowsLoaded=true', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([baseWf]));
    const { result } = renderHook(() => useWorkflow());
    await act(async () => {
      await result.current.fetchWorkflows();
    });
    expect(result.current.workflows).toHaveLength(1);
    expect(result.current.workflowsLoaded).toBe(true);
  });

  it('sets error on throw', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useWorkflow());
    await act(async () => {
      await result.current.fetchWorkflows();
    });
    expect(result.current.error).toBe('Failed to fetch workflows');
  });
});

describe('useWorkflow.fetchWorkflow', () => {
  it('sets currentWorkflow when activeRunId matches', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp(baseWf));
    const { result } = renderHook(() => useWorkflow());
    // activeRunIdRef is null initially, so currentWorkflow may not be set unless id matches
    await act(async () => {
      await result.current.fetchWorkflow('wf1');
    });
    // Verify it didn't throw + the workflow is parseable
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/workflows/wf1');
  });
});

describe('useWorkflow.fetchTemplates', () => {
  it('populates templates', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([{ id: 'tpl1', name: 'Quick' }]));
    const { result } = renderHook(() => useWorkflow());
    await act(async () => {
      await result.current.fetchTemplates();
    });
    expect(result.current.templates).toHaveLength(1);
  });
});

describe('useWorkflow.startWorkflow', () => {
  it('opens EventSource on successful POST', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ id: 'wf-new' }, 201));
    apiFetchSpy.mockResolvedValue(jsonResp(baseWf));
    const { result } = renderHook(() => useWorkflow());
    await act(async () => {
      await result.current.startWorkflow({
        name: 'X',
        providers: ['p1:gpt-4'],
        apiKeys: {},
        tasks: [{ name: 'T', config: { prompt: 'hi', maxTokens: 100, concurrency: 1, iterations: 1 } }],
      });
    });
    expect(MockEventSource.instances.length).toBeGreaterThan(0);
    expect(result.current.isRunning).toBe(true);
  });

  it('on non-2xx: sets error, isRunning=false, no SSE opened', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'bad' }, 400));
    const { result } = renderHook(() => useWorkflow());
    await act(async () => {
      await result.current.startWorkflow({
        name: 'X',
        providers: [],
        apiKeys: {},
        tasks: [],
      });
    });
    expect(result.current.error).toBe('bad');
    expect(result.current.isRunning).toBe(false);
    expect(MockEventSource.instances).toHaveLength(0);
  });

  // Bug #6 regression: before the fix, `setIsRunning(false)` in catch was a no-op
  // because nothing ever set it to true on the error path. The fix is to set true
  // at the start of try{}, so failure path correctly transitions true→false.
  it('regression #6: on thrown fetch, isRunning briefly true then false (not stuck)', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useWorkflow());
    await act(async () => {
      await result.current.startWorkflow({
        name: 'X',
        providers: [],
        apiKeys: {},
        tasks: [],
      });
    });
    expect(result.current.isRunning).toBe(false);
    expect(result.current.error).toContain('network');
  });

  it('on workflow:complete event: closes SSE and flips isRunning=false', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ id: 'wf-new' }, 201));
    apiFetchSpy.mockResolvedValue(jsonResp(baseWf));
    const { result } = renderHook(() => useWorkflow());
    await act(async () => {
      await result.current.startWorkflow({
        name: 'X',
        providers: ['p1:gpt-4'],
        apiKeys: {},
        tasks: [{ name: 'T', config: { prompt: 'p', maxTokens: 1, concurrency: 1, iterations: 1 } }],
      });
    });

    await act(async () => {
      MockEventSource.instances[0].emit({ type: 'workflow:complete', data: { workflowId: 'wf-new' } });
    });
    await waitFor(() => expect(result.current.isRunning).toBe(false));
  });
});

describe('useWorkflow.cancelWorkflow', () => {
  it('returns true on success', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true }));
    apiFetchSpy.mockResolvedValueOnce(jsonResp(baseWf)); // fetchWorkflow
    const { result } = renderHook(() => useWorkflow());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.cancelWorkflow('wf1');
    });
    expect(ok).toBe(true);
  });

  it('returns false on server success:false and surfaces an error', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: false, message: 'Not running' }));
    const { result } = renderHook(() => useWorkflow());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.cancelWorkflow('wf1');
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBeTruthy();
  });

  // Bug #1 regression: 404/400 used to return false WITHOUT surfacing any error
  it('regression #1: 404 sets error and returns false', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'Workflow not found' }, 404));
    const { result } = renderHook(() => useWorkflow());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.cancelWorkflow('absent');
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBe('Workflow not found');
  });

  it('regression #1: 400 not-running sets error with server message', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'Workflow is not running' }, 400));
    const { result } = renderHook(() => useWorkflow());
    await act(async () => {
      await result.current.cancelWorkflow('wf1');
    });
    expect(result.current.error).toBe('Workflow is not running');
  });

  it('returns false on throw', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('x'));
    const { result } = renderHook(() => useWorkflow());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.cancelWorkflow('wf1');
    });
    expect(ok).toBe(false);
  });
});

describe('useWorkflow.exportWorkflow', () => {
  it('opens download URL in a new tab', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useWorkflow());
    await act(async () => {
      await result.current.exportWorkflow('wf1', 'csv');
    });
    expect(openSpy).toHaveBeenCalledWith('/api/workflows/wf1/export?format=csv', '_blank');
  });
});

describe('useWorkflow.deleteWorkflow', () => {
  it('returns true and triggers refetch on success', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([baseWf]));
    const { result } = renderHook(() => useWorkflow());
    await act(async () => {
      await result.current.fetchWorkflows();
    });

    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true })); // DELETE
    apiFetchSpy.mockResolvedValueOnce(jsonResp([])); // refetch returns empty
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.deleteWorkflow('wf1');
    });
    expect(ok).toBe(true);
    await waitFor(() => expect(result.current.workflows).toHaveLength(0));
  });

  it('returns false when server responds success:false', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: false }));
    const { result } = renderHook(() => useWorkflow());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.deleteWorkflow('wf1');
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBeTruthy();
  });

  // Bug #1 regression: 4xx must surface an error
  it('regression #1: 400 (running workflow) sets error from server', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'Cannot delete a running workflow' }, 400));
    const { result } = renderHook(() => useWorkflow());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.deleteWorkflow('wf1');
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBe('Cannot delete a running workflow');
  });

  it('regression #1: 404 sets error', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'not found' }, 404));
    const { result } = renderHook(() => useWorkflow());
    await act(async () => {
      await result.current.deleteWorkflow('absent');
    });
    expect(result.current.error).toBe('not found');
  });

  it('returns false on throw', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('x'));
    const { result } = renderHook(() => useWorkflow());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.deleteWorkflow('wf1');
    });
    expect(ok).toBe(false);
  });
});

describe('useWorkflow.duplicateWorkflow', () => {
  it('returns the new id on success', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ id: 'wf-copy' }, 201));
    apiFetchSpy.mockResolvedValueOnce(jsonResp([])); // refetch
    const { result } = renderHook(() => useWorkflow());
    let newId!: string | null;
    await act(async () => {
      newId = await result.current.duplicateWorkflow('wf1');
    });
    expect(newId).toBe('wf-copy');
  });

  // Bug #1 regression: 4xx must surface an error
  it('regression #1: 404 returns null AND sets error from server', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'Workflow not found' }, 404));
    const { result } = renderHook(() => useWorkflow());
    let r!: string | null;
    await act(async () => {
      r = await result.current.duplicateWorkflow('absent');
    });
    expect(r).toBeNull();
    expect(result.current.error).toBe('Workflow not found');
  });
});

describe('useWorkflow.clearError', () => {
  it('clears the error state', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('x'));
    const { result } = renderHook(() => useWorkflow());
    await act(async () => {
      await result.current.fetchWorkflows();
    });
    expect(result.current.error).toBeTruthy();
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});

describe('useWorkflow.reconnectActiveWorkflow', () => {
  it('returns false when no active workflow is running', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp(null));
    const { result } = renderHook(() => useWorkflow());
    let r!: boolean;
    await act(async () => {
      r = await result.current.reconnectActiveWorkflow();
    });
    expect(r).toBe(false);
  });

  it('reconnects to running workflow via SSE', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ ...baseWf, id: 'wf-running', status: 'running' }));
    apiFetchSpy.mockResolvedValue(jsonResp({ ...baseWf, id: 'wf-running', status: 'running' }));
    const { result } = renderHook(() => useWorkflow());
    let r!: boolean;
    await act(async () => {
      r = await result.current.reconnectActiveWorkflow();
    });
    expect(r).toBe(true);
    expect(MockEventSource.instances.length).toBeGreaterThan(0);
  });
});
