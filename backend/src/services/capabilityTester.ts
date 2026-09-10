import { CapabilityTest } from '../types';

export async function testCapabilities(provider: string, apiKey: string, baseUrl?: string): Promise<CapabilityTest[]> {
  const results: CapabilityTest[] = [];

  // Test vision capability
  results.push(await testVision(provider, apiKey, baseUrl));

  // Test function calling
  results.push(await testFunctionCalling(provider, apiKey, baseUrl));

  // Test JSON mode
  results.push(await testJsonMode(provider, apiKey, baseUrl));

  // Test streaming output
  results.push(await testStreaming(provider, apiKey, baseUrl));

  // Test non-streaming output
  results.push(await testNonStreaming(provider, apiKey, baseUrl));

  return results;
}

async function testVision(provider: string, apiKey: string, baseUrl?: string): Promise<CapabilityTest> {
  const test: CapabilityTest = {
    type: 'vision',
    name: 'Vision Capability',
    description: 'Can the model understand images?',
    passed: false,
  };

  try {
    // Simple 1x1 red pixel image (base64)
    const testImage =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

    const url = baseUrl || 'http://REDACTED:4001/v1';
    const model = provider === 'zai' ? 'z-ai/glm-4.7' : 'default';

    const response = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What color is this image?' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${testImage}` } },
            ],
          },
        ],
        max_tokens: 50,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const answer = data.choices?.[0]?.message?.content?.toLowerCase() || '';
      // Check if the color red was mentioned
      test.passed = answer.includes('red') || answer.includes('红');
      test.details = test.passed
        ? 'Model correctly identified the image color'
        : `Model response: ${answer.slice(0, 100)}`;
    } else {
      test.details = `API error: ${response.status}`;
    }
  } catch (error) {
    test.details = `Error: ${error instanceof Error ? error.message : 'Unknown'}`;
  }

  return test;
}

async function testFunctionCalling(provider: string, apiKey: string, baseUrl?: string): Promise<CapabilityTest> {
  const test: CapabilityTest = {
    type: 'function_calling',
    name: 'Function Calling',
    description: 'Can the model use tools/functions?',
    passed: false,
  };

  try {
    const url = baseUrl || 'http://REDACTED:4001/v1';
    const model = provider === 'zai' ? 'z-ai/glm-4.7' : 'default';

    const response = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'What is the weather in Beijing?' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get the current weather for a location',
              parameters: {
                type: 'object',
                properties: {
                  location: { type: 'string', description: 'City name' },
                },
                required: ['location'],
              },
            },
          },
        ],
        tool_choice: 'auto',
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string } }> } }>;
      };
      const toolCalls = data.choices?.[0]?.message?.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        test.passed = true;
        test.details = `Model requested to call: ${toolCalls[0].function?.name || 'unknown function'}`;
      } else {
        test.details = 'Model did not make a tool call';
      }
    } else {
      test.details = `API error: ${response.status}`;
    }
  } catch (error) {
    test.details = `Error: ${error instanceof Error ? error.message : 'Unknown'}`;
  }

  return test;
}

async function testJsonMode(provider: string, apiKey: string, baseUrl?: string): Promise<CapabilityTest> {
  const test: CapabilityTest = {
    type: 'json_mode',
    name: 'JSON Mode',
    description: 'Can the model output valid JSON?',
    passed: false,
  };

  try {
    const url = baseUrl || 'http://REDACTED:4001/v1';
    const model = provider === 'zai' ? 'z-ai/glm-4.7' : 'default';

    const response = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Return a JSON object with name "test" and value 123' }],
        response_format: { type: 'json_object' },
        max_tokens: 100,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content || '';

      try {
        const parsed = JSON.parse(content);
        test.passed = typeof parsed === 'object';
        test.details = test.passed ? `Valid JSON: ${JSON.stringify(parsed).slice(0, 50)}` : 'Parsed but not an object';
      } catch {
        test.details = `Invalid JSON: ${content.slice(0, 100)}`;
      }
    } else {
      test.details = `API error: ${response.status}`;
    }
  } catch (error) {
    test.details = `Error: ${error instanceof Error ? error.message : 'Unknown'}`;
  }

  return test;
}

async function testStreaming(provider: string, apiKey: string, baseUrl?: string): Promise<CapabilityTest> {
  const test: CapabilityTest = {
    type: 'streaming',
    name: 'Streaming Output',
    description: 'Does the API support SSE streaming responses?',
    passed: false,
  };

  try {
    const url = baseUrl || 'http://REDACTED:4001/v1';
    const model = provider === 'zai' ? 'z-ai/glm-4.7' : 'default';
    const start = Date.now();

    const response = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say hello.' }],
        max_tokens: 20,
        stream: true,
      }),
    });

    if (response.ok && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let gotChunks = 0;
      let firstChunkTime = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.includes('data:')) {
          gotChunks++;
          if (gotChunks === 1) firstChunkTime = Date.now() - start;
        }
        if (gotChunks >= 3) {
          reader.cancel();
          break;
        }
      }

      test.passed = gotChunks >= 2;
      test.latencyMs = firstChunkTime;
      test.details = test.passed
        ? `Received ${gotChunks} stream chunks, first chunk in ${firstChunkTime}ms`
        : `Only received ${gotChunks} chunks`;
    } else {
      test.details = `API error: ${response.status}`;
    }
  } catch (error) {
    test.details = `Error: ${error instanceof Error ? error.message : 'Unknown'}`;
  }

  return test;
}

async function testNonStreaming(provider: string, apiKey: string, baseUrl?: string): Promise<CapabilityTest> {
  const test: CapabilityTest = {
    type: 'non_streaming',
    name: 'Non-Streaming Output',
    description: 'Does the API support standard synchronous responses?',
    passed: false,
  };

  try {
    const url = baseUrl || 'http://REDACTED:4001/v1';
    const model = provider === 'zai' ? 'z-ai/glm-4.7' : 'default';
    const start = Date.now();

    const response = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say hello.' }],
        max_tokens: 20,
        stream: false,
      }),
    });

    const latency = Date.now() - start;

    if (response.ok) {
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content || '';
      test.passed = content.length > 0;
      test.latencyMs = latency;
      test.details = test.passed ? `Response in ${latency}ms: "${content.slice(0, 60)}"` : 'Empty response content';
    } else {
      test.details = `API error: ${response.status}`;
    }
  } catch (error) {
    test.details = `Error: ${error instanceof Error ? error.message : 'Unknown'}`;
  }

  return test;
}
