import { describe, it, expect } from 'vitest';
import {
  LoginSchema,
  ChangePasswordSchema,
  StartBenchmarkSchema,
  ProviderConfigInputSchema,
  ProviderConfigUpdateSchema,
  TestConnectionSchema,
  CreateWorkflowSchema,
} from '../validation/schemas';

describe('Validation Schemas', () => {
  describe('LoginSchema', () => {
    it('should accept valid login data', () => {
      const result = LoginSchema.safeParse({ username: 'admin', password: 'secret' });
      expect(result.success).toBe(true);
    });

    it('should reject missing username', () => {
      const result = LoginSchema.safeParse({ username: '', password: 'secret' });
      expect(result.success).toBe(false);
    });

    it('should reject missing password', () => {
      const result = LoginSchema.safeParse({ username: 'admin', password: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('ChangePasswordSchema', () => {
    it('should accept valid change password data', () => {
      const result = ChangePasswordSchema.safeParse({ currentPassword: 'old', newPassword: 'newpass' });
      expect(result.success).toBe(true);
    });

    it('should reject short new password', () => {
      const result = ChangePasswordSchema.safeParse({ currentPassword: 'old', newPassword: 'short' });
      expect(result.success).toBe(false);
    });
  });

  describe('StartBenchmarkSchema', () => {
    it('should accept valid benchmark request', () => {
      const result = StartBenchmarkSchema.safeParse({
        providers: ['openai'],
        config: { prompt: 'test', maxTokens: 100, concurrency: 1, iterations: 5 },
        apiKeys: { openai: 'sk-test' },
      });
      expect(result.success).toBe(true);
    });

    it('should reject empty providers array', () => {
      const result = StartBenchmarkSchema.safeParse({
        providers: [],
        config: { prompt: 'test', maxTokens: 100, concurrency: 1, iterations: 5 },
        apiKeys: {},
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing prompt', () => {
      const result = StartBenchmarkSchema.safeParse({
        providers: ['openai'],
        config: { maxTokens: 100, concurrency: 1, iterations: 5 },
        apiKeys: {},
      });
      expect(result.success).toBe(false);
    });

    it('should reject concurrency above 5000', () => {
      const result = StartBenchmarkSchema.safeParse({
        providers: ['openai'],
        config: { prompt: 'test', maxTokens: 100, concurrency: 5001, iterations: 5 },
        apiKeys: {},
      });
      expect(result.success).toBe(false);
    });

    it('should accept concurrency up to 5000', () => {
      const result = StartBenchmarkSchema.safeParse({
        providers: ['openai'],
        config: { prompt: 'test', maxTokens: 100, concurrency: 5000, iterations: 5 },
        apiKeys: {},
      });
      expect(result.success).toBe(true);
    });

    it('should reject iterations above 10000000', () => {
      const result = StartBenchmarkSchema.safeParse({
        providers: ['openai'],
        config: { prompt: 'test', maxTokens: 100, concurrency: 1, iterations: 10000001 },
        apiKeys: {},
      });
      expect(result.success).toBe(false);
    });

    it('should accept iterations up to 10000000', () => {
      const result = StartBenchmarkSchema.safeParse({
        providers: ['openai'],
        config: { prompt: 'test', maxTokens: 100, concurrency: 1, iterations: 10000000 },
        apiKeys: {},
      });
      expect(result.success).toBe(true);
    });

    it('should accept request without apiKeys (optional with default)', () => {
      const result = StartBenchmarkSchema.safeParse({
        providers: ['openai'],
        config: { prompt: 'test', maxTokens: 100, concurrency: 1, iterations: 5 },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.apiKeys).toEqual({});
      }
    });
  });

  describe('ProviderConfigInputSchema', () => {
    it('should accept valid provider config', () => {
      const result = ProviderConfigInputSchema.safeParse({
        name: 'My-Provider',
        endpoint: 'https://api.openai.com',
        apiKey: 'sk-test',
        format: 'openai',
        models: [{ name: 'gpt-4', contextSize: 128000, supportsVision: true, supportsTools: true }],
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid format', () => {
      const result = ProviderConfigInputSchema.safeParse({
        name: 'My Provider',
        endpoint: 'https://api.test.com',
        apiKey: 'key',
        format: 'invalid',
        models: [{ name: 'model', contextSize: 4096, supportsVision: false, supportsTools: false }],
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty models array', () => {
      const result = ProviderConfigInputSchema.safeParse({
        name: 'My-Provider',
        endpoint: 'https://api.test.com',
        apiKey: 'key',
        format: 'openai',
        models: [],
      });
      expect(result.success).toBe(false);
    });

    it('should reject provider name with spaces', () => {
      const result = ProviderConfigInputSchema.safeParse({
        name: 'My Provider',
        endpoint: 'https://api.openai.com',
        apiKey: 'sk-test',
        format: 'openai',
        models: [{ name: 'gpt-4', contextSize: 128000, supportsVision: true, supportsTools: true }],
      });
      expect(result.success).toBe(false);
    });

    it('should accept model ID with slash (LiteLLM format)', () => {
      const result = ProviderConfigInputSchema.safeParse({
        name: 'LiteLLM-Proxy',
        endpoint: 'https://api.example.com',
        apiKey: 'sk-test',
        format: 'openai',
        models: [{ name: 'z-ai/glm-4.7', contextSize: 128000, supportsVision: false, supportsTools: false }],
      });
      expect(result.success).toBe(true);
    });

    it('should accept model with displayName', () => {
      const result = ProviderConfigInputSchema.safeParse({
        name: 'Test-Provider',
        endpoint: 'https://api.example.com',
        apiKey: 'sk-test',
        format: 'openai',
        models: [
          {
            name: 'glm-5.1',
            displayName: 'GLM 5.1',
            contextSize: 128000,
            supportsVision: false,
            supportsTools: false,
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('should reject model ID longer than 64 chars', () => {
      const result = ProviderConfigInputSchema.safeParse({
        name: 'Test-Provider',
        endpoint: 'https://api.example.com',
        apiKey: 'sk-test',
        format: 'openai',
        models: [{ name: 'a'.repeat(65), contextSize: 4096, supportsVision: false, supportsTools: false }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ProviderConfigUpdateSchema', () => {
    it('should accept partial update with only name', () => {
      const result = ProviderConfigUpdateSchema.safeParse({ name: 'New-Name' });
      expect(result.success).toBe(true);
    });

    it('should accept full update', () => {
      const result = ProviderConfigUpdateSchema.safeParse({
        name: 'My-Provider',
        endpoint: 'https://api.openai.com',
        apiKey: 'sk-test',
        format: 'openai',
        models: [{ name: 'gpt-4', contextSize: 128000, supportsVision: true, supportsTools: true }],
      });
      expect(result.success).toBe(true);
    });

    it('should accept empty object (no-op update)', () => {
      const result = ProviderConfigUpdateSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should reject invalid format', () => {
      const result = ProviderConfigUpdateSchema.safeParse({ format: 'invalid' });
      expect(result.success).toBe(false);
    });

    it('should reject empty models array when provided', () => {
      const result = ProviderConfigUpdateSchema.safeParse({ models: [] });
      expect(result.success).toBe(false);
    });
  });

  describe('CreateWorkflowSchema', () => {
    it('should accept valid workflow without apiKeys (optional with default)', () => {
      const result = CreateWorkflowSchema.safeParse({
        name: 'My Workflow',
        providers: ['openai'],
        tasks: [{ name: 'Task 1', config: { prompt: 'test', maxTokens: 100, concurrency: 1, iterations: 5 } }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.apiKeys).toEqual({});
      }
    });

    it('should accept workflow with apiKeys', () => {
      const result = CreateWorkflowSchema.safeParse({
        name: 'My Workflow',
        providers: ['openai'],
        apiKeys: { openai: 'sk-test' },
        tasks: [{ name: 'Task 1', config: { prompt: 'test', maxTokens: 100, concurrency: 1, iterations: 5 } }],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TestConnectionSchema', () => {
    it('should accept valid connection test data', () => {
      const result = TestConnectionSchema.safeParse({
        endpoint: 'https://api.openai.com',
        apiKey: 'sk-test',
        format: 'openai',
        modelName: 'gpt-4',
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing fields', () => {
      const result = TestConnectionSchema.safeParse({ endpoint: 'https://api.openai.com' });
      expect(result.success).toBe(false);
    });
  });

  describe('PlaygroundRunSchema', () => {
    it('should accept a valid run request', () => {
      const result = PlaygroundRunSchema.safeParse({
        providerId: 'abc-123',
        modelName: 'gpt-4',
        prompt: 'Hello',
        maxTokens: 100,
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing required fields', () => {
      const result = PlaygroundRunSchema.safeParse({ providerId: 'abc-123' });
      expect(result.success).toBe(false);
    });
  });

});

