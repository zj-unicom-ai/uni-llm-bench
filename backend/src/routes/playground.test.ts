import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ImageInput } from '../types';

/**
 * Playground route helpers: pure-ish helpers that build provider-specific request payloads,
 * fetch and base64-encode images, validate inputs, and resolve providers. The large
 * `/run` and `/stream` handlers are best validated E2E; we focus here on the helpers.
 */

const hooks = vi.hoisted(() => ({
  providerStoreGet: vi.fn(),
  providerStoreGetKey: vi.fn(),
}));

vi.mock('../services/providerStore', () => ({
  providerStore: { get: hooks.providerStoreGet, getDecryptedApiKey: hooks.providerStoreGetKey },
}));

import {
  buildOpenAIContent,
  fetchImageAsBase64,
  resolveImagesToBase64,
  buildAnthropicHeaders,
  resolveProvider,
  validateImages,
  buildGeminiParts,
} from './playground';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildOpenAIContent', () => {
  it('returns plain string when no images', () => {
    expect(buildOpenAIContent('hello', [])).toBe('hello');
  });

  it('returns plain string when images is empty', () => {
    expect(buildOpenAIContent('hello', [] as ImageInput[])).toBe('hello');
  });

  it('returns parts array with text first when images present (URL)', () => {
    const parts = buildOpenAIContent('describe', [{ type: 'url', url: 'https://example.com/img.png' }]);
    expect(Array.isArray(parts)).toBe(true);
    expect((parts as Array<{ type: string }>)[0].type).toBe('text');
    expect((parts as Array<{ type: string }>)[1].type).toBe('image_url');
  });

  it('builds data:URI for base64 images', () => {
    const parts = buildOpenAIContent('describe', [
      { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KG...' },
    ]) as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts[1].image_url?.url).toBe('data:image/png;base64,iVBORw0KG...');
  });

  it('skips base64 images missing data or mediaType', () => {
    const parts = buildOpenAIContent('x', [
      { type: 'base64', data: 'd1' }, // missing mediaType
      { type: 'base64', mediaType: 'image/png' }, // missing data
      { type: 'base64', mediaType: 'image/png', data: 'good' },
    ]) as Array<{ type: string }>;
    // text + 1 valid image
    expect(parts).toHaveLength(2);
    expect(parts[1].type).toBe('image_url');
  });

  it('skips url images with empty/missing url', () => {
    const parts = buildOpenAIContent('x', [{ type: 'url' }, { type: 'url', url: '' }]) as Array<{ type: string }>;
    expect(parts).toHaveLength(1); // only the text
  });

  it('handles many images (all valid)', () => {
    const imgs: ImageInput[] = Array.from({ length: 5 }, () => ({ type: 'url', url: 'https://x.png' }));
    const parts = buildOpenAIContent('x', imgs) as Array<unknown>;
    expect(parts).toHaveLength(6); // text + 5 images
  });
});

describe('fetchImageAsBase64', () => {
  it('returns base64 data + media type on a 200 response', async () => {
    const buf = Uint8Array.from([1, 2, 3, 4]).buffer;
    fetchMock.mockResolvedValueOnce(new Response(buf, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
    const r = await fetchImageAsBase64('https://example.com/img.jpg');
    expect(r).toEqual({ mediaType: 'image/jpeg', data: Buffer.from(buf).toString('base64') });
  });

  it('strips content-type parameters (e.g. "image/png; charset=utf-8" → "image/png")', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new ArrayBuffer(0), { status: 200, headers: { 'Content-Type': 'image/png; charset=utf-8' } }),
    );
    const r = await fetchImageAsBase64('https://example.com/img.png');
    expect(r?.mediaType).toBe('image/png');
  });

  it('defaults media type to "image/png" when Content-Type header missing', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new ArrayBuffer(0), { status: 200 }));
    const r = await fetchImageAsBase64('https://example.com/img.png');
    expect(r?.mediaType).toBe('image/png');
  });

  it('returns null on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await fetchImageAsBase64('https://example.com/x')).toBeNull();
  });

  it('returns null on thrown fetch (network error)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    expect(await fetchImageAsBase64('https://example.com/x')).toBeNull();
  });
});

describe('resolveImagesToBase64', () => {
  it('passes through already-base64 images unchanged', async () => {
    const input: ImageInput[] = [{ type: 'base64', mediaType: 'image/png', data: 'abc' }];
    const result = await resolveImagesToBase64(input);
    expect(result).toEqual(input);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches URL images and converts to base64', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(Uint8Array.from([5, 6]).buffer, { status: 200, headers: { 'Content-Type': 'image/gif' } }),
    );
    const result = await resolveImagesToBase64([{ type: 'url', url: 'https://example.com/x.gif' }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'base64', mediaType: 'image/gif', data: Buffer.from([5, 6]).toString('base64') });
  });

  it('drops URL images whose fetch fails (does not throw)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    const result = await resolveImagesToBase64([{ type: 'url', url: 'https://example.com/x.png' }]);
    expect(result).toEqual([]);
  });

  it('mixes base64 passthrough + fetched URLs', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new ArrayBuffer(0), { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    const result = await resolveImagesToBase64([
      { type: 'base64', mediaType: 'image/jpeg', data: 'jpeg-data' },
      { type: 'url', url: 'https://example.com/x.png' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].mediaType).toBe('image/jpeg');
    expect(result[1].mediaType).toBe('image/png');
  });
});

describe('buildAnthropicHeaders', () => {
  it('includes required Anthropic headers', () => {
    const h = buildAnthropicHeaders('sk-claude-key');
    expect(h['Content-Type']).toBe('application/json');
    expect(h['x-api-key']).toBe('sk-claude-key');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['x-app']).toBe('cli');
    expect(h['User-Agent']).toContain('claude-cli');
  });

  it('generates unique session and request IDs per call', () => {
    const h1 = buildAnthropicHeaders('k');
    const h2 = buildAnthropicHeaders('k');
    expect(h1['X-Claude-Code-Session-Id']).not.toBe(h2['X-Claude-Code-Session-Id']);
    expect(h1['x-client-request-id']).not.toBe(h2['x-client-request-id']);
  });
});

describe('resolveProvider', () => {
  it('returns error when provider id not found', () => {
    hooks.providerStoreGet.mockReturnValue(undefined);
    expect(resolveProvider('absent', 'gpt-4')).toEqual({ error: 'Provider not found' });
  });

  it('returns error when model name not in provider models', () => {
    hooks.providerStoreGet.mockReturnValue({
      id: 'p1',
      name: 'P',
      endpoint: 'http://x',
      apiKey: 'enc',
      format: 'openai',
      models: [{ id: 'm1', name: 'gpt-3', supportsVision: false, supportsTools: false, contextSize: 4096 }],
    });
    const r = resolveProvider('p1', 'gpt-4') as { error: string };
    expect(r.error).toContain('not found');
  });

  it('matches by model id as well as model name', () => {
    hooks.providerStoreGet.mockReturnValue({
      id: 'p1',
      name: 'P',
      endpoint: 'http://x',
      apiKey: 'enc',
      format: 'openai',
      models: [
        { id: 'model-uuid', name: 'gpt-4-display', supportsVision: false, supportsTools: false, contextSize: 4096 },
      ],
    });
    hooks.providerStoreGetKey.mockReturnValue('sk-test');
    const r = resolveProvider('p1', 'model-uuid');
    expect('config' in r).toBe(true);
  });

  it('returns error when model is inactive', () => {
    hooks.providerStoreGet.mockReturnValue({
      id: 'p1',
      name: 'P',
      endpoint: 'http://x',
      apiKey: 'enc',
      format: 'openai',
      models: [
        { id: 'm1', name: 'gpt-4', isActive: false, supportsVision: false, supportsTools: false, contextSize: 4096 },
      ],
    });
    const r = resolveProvider('p1', 'gpt-4') as { error: string };
    expect(r.error).toContain('inactive');
  });

  it('returns error when API key cannot be decrypted', () => {
    hooks.providerStoreGet.mockReturnValue({
      id: 'p1',
      name: 'P',
      endpoint: 'http://x',
      apiKey: 'enc',
      format: 'openai',
      models: [{ id: 'm1', name: 'gpt-4', supportsVision: false, supportsTools: false, contextSize: 4096 }],
    });
    hooks.providerStoreGetKey.mockReturnValue(undefined);
    expect(resolveProvider('p1', 'gpt-4')).toEqual({ error: 'Failed to decrypt API key' });
  });

  it('returns config + model + apiKey on success', () => {
    const provider = {
      id: 'p1',
      name: 'P',
      endpoint: 'http://x',
      apiKey: 'enc',
      format: 'openai' as const,
      models: [{ id: 'm1', name: 'gpt-4', supportsVision: false, supportsTools: false, contextSize: 4096 }],
    };
    hooks.providerStoreGet.mockReturnValue(provider);
    hooks.providerStoreGetKey.mockReturnValue('sk-decrypted');
    const r = resolveProvider('p1', 'gpt-4');
    if ('error' in r) throw new Error('expected success path');
    expect(r.config.id).toBe('p1');
    expect(r.model.name).toBe('gpt-4');
    expect(r.apiKey).toBe('sk-decrypted');
  });
});

describe('validateImages', () => {
  it('returns null when no images', () => {
    expect(validateImages()).toBeNull();
    expect(validateImages(undefined)).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(validateImages([])).toBeNull();
  });

  it('accepts a small base64 image under 10MB', () => {
    // 1KB of base64 ≈ 750 bytes decoded
    const data = 'A'.repeat(1024);
    expect(validateImages([{ type: 'base64', mediaType: 'image/png', data }])).toBeNull();
  });

  it('rejects a base64 image just over 10MB', () => {
    // 10MB decoded = (10*1024*1024 * 4/3) base64 chars ≈ 14,000,000 chars
    const data = 'A'.repeat(15 * 1024 * 1024); // 15M chars → ~11.25MB decoded
    const r = validateImages([{ type: 'base64', mediaType: 'image/png', data }]);
    expect(r).toContain('exceeds 10MB');
    expect(r).toContain('Image 1');
  });

  it('reports correct image index (1-based) in error message', () => {
    const big = 'A'.repeat(15 * 1024 * 1024);
    const small = 'A'.repeat(100);
    const r = validateImages([
      { type: 'base64', mediaType: 'image/png', data: small },
      { type: 'base64', mediaType: 'image/png', data: big },
    ]);
    expect(r).toContain('Image 2');
  });

  it('rejects > 10 images', () => {
    const imgs: ImageInput[] = Array.from({ length: 11 }, () => ({ type: 'url', url: 'http://x' }));
    expect(validateImages(imgs)).toBe('Maximum 10 images per request');
  });

  it('accepts exactly 10 images', () => {
    const imgs: ImageInput[] = Array.from({ length: 10 }, () => ({ type: 'url', url: 'http://x' }));
    expect(validateImages(imgs)).toBeNull();
  });

  it('skips URL images for size check (no data to measure)', () => {
    expect(validateImages([{ type: 'url', url: 'http://x' }])).toBeNull();
  });
});

describe('buildGeminiParts', () => {
  it('returns text-only parts when no images', async () => {
    const parts = await buildGeminiParts('hello');
    expect(parts).toEqual([{ text: 'hello' }]);
  });

  it('returns text-only parts when images is empty array', async () => {
    const parts = await buildGeminiParts('hello', []);
    expect(parts).toEqual([{ text: 'hello' }]);
  });

  it('includes inline_data for base64 images', async () => {
    const parts = await buildGeminiParts('describe', [{ type: 'base64', mediaType: 'image/png', data: 'abc123' }]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ inline_data: { mime_type: 'image/png', data: 'abc123' } });
    expect(parts[1]).toEqual({ text: 'describe' });
  });

  it('fetches URL images and inlines them', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(Uint8Array.from([9, 8]).buffer, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
    );
    const parts = await buildGeminiParts('describe', [{ type: 'url', url: 'https://x.jpg' }]);
    expect(parts).toHaveLength(2);
    expect((parts[0] as { inline_data: { mime_type: string } }).inline_data.mime_type).toBe('image/jpeg');
  });

  it('skips images that fail to resolve', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    const parts = await buildGeminiParts('describe', [{ type: 'url', url: 'https://x.png' }]);
    expect(parts).toEqual([{ text: 'describe' }]); // text only
  });
});
