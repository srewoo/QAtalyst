/**
 * bg-connections.js — Connection tests for AI providers and integrations (Settings → Test connection), and AWS SigV4 request signing.
 *
 * Moved verbatim out of background.js. Plain script: the worker importScripts it,
 * so these functions stay globals and every call site is unchanged.
 */


async function handleTestIntegration(data) {
  const { type, ...credentials } = data;

  switch (type) {
    case 'confluence':
      return testConfluence(credentials);
    case 'figma':
      return testFigma(credentials);
    case 'google':
      return testGoogle(credentials);
    case 'testrail':
      return testTestRail(credentials);
    default:
      return { success: false, message: 'Unknown integration type' };
  }
}

/**
 * Test AI provider connection using lightweight/free API endpoints
 * - OpenAI:  GET /v1/models (no tokens used)
 * - Claude:  GET /v1/models (no tokens used)
 * - Gemini:  GET /v1beta/models (no tokens used)
 * - Bedrock: InvokeModel with max_tokens=1 (minimal cost, confirms auth + model access)
 */
async function handleTestAIConnection({ provider, model, apiKey, ollamaBaseUrl, bedrockAccessKeyId, bedrockSecretKey, bedrockSessionToken, bedrockRegion }) {
  switch (provider) {
    case 'openai':
      return testOpenAIConnection(apiKey);
    case 'claude':
      return testClaudeConnection(apiKey);
    case 'gemini':
      return testGeminiConnection(apiKey);
    case 'ollama':
      return testOllamaConnection({ model, ollamaBaseUrl });
    case 'bedrock':
      return testBedrockConnection({ model, bedrockAccessKeyId, bedrockSecretKey, bedrockSessionToken, bedrockRegion });
    default:
      return { success: false, message: `Unknown provider: ${provider}` };
  }
}

/**
 * Ollama: confirm the daemon is reachable AND that the selected model is pulled.
 * Reaching the daemon is not enough — generation fails just as hard when the tag
 * is missing, and that failure is far more confusing at generation time.
 */
async function testOllamaConnection({ model, ollamaBaseUrl }) {
  const base = (ollamaBaseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      res = await fetch(`${base}/api/tags`, { signal: controller.signal });
    } finally { clearTimeout(timer); }

    if (!res.ok) {
      return { success: false, message: `Ollama responded with HTTP ${res.status} at ${base}` };
    }
    const data = await res.json();
    const tags = (data.models || []).map(m => m.name);
    if (!tags.length) {
      return { success: false, message: `Ollama is running at ${base} but no models are installed. Run: ollama pull llama3.1` };
    }
    if (model && !tags.includes(model)) {
      return {
        success: false,
        message: `Ollama is running, but "${model}" is not installed. Available: ${tags.slice(0, 5).join(', ')}${tags.length > 5 ? '…' : ''}. Run: ollama pull ${model}`
      };
    }
    return {
      success: true,
      message: `Connected to Ollama at ${base}. ${model ? `Model "${model}" is ready.` : `${tags.length} model(s) installed.`} No data leaves your machine.`
    };
  } catch (error) {
    const hint = /abort/i.test(error.message)
      ? 'it did not respond in time'
      : 'it may not be running, or it is blocking this extension';
    return {
      success: false,
      message: `Could not reach Ollama at ${base} — ${hint}. Start it with: OLLAMA_ORIGINS=chrome-extension://* ollama serve`
    };
  }
}

async function testOpenAIConnection(apiKey) {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    if (response.ok) {
      const data = await response.json();
      const count = data.data?.length || 0;
      return { success: true, message: `OpenAI connection successful! ${count} models available.` };
    }
    const err = await response.json().catch(() => ({}));
    return { success: false, message: err.error?.message || `OpenAI returned HTTP ${response.status}. Check your API key.` };
  } catch (e) {
    return { success: false, message: `Network error: ${e.message}` };
  }
}

async function testClaudeConnection(apiKey) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    });
    if (response.ok) {
      const data = await response.json();
      const count = data.data?.length || 0;
      return { success: true, message: `Anthropic Claude connection successful! ${count} models available.` };
    }
    const err = await response.json().catch(() => ({}));
    return { success: false, message: err.error?.message || `Claude returned HTTP ${response.status}. Check your API key.` };
  } catch (e) {
    return { success: false, message: `Network error: ${e.message}` };
  }
}

async function testGeminiConnection(apiKey) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      method: 'GET'
    });
    if (response.ok) {
      const data = await response.json();
      const count = data.models?.length || 0;
      return { success: true, message: `Google Gemini connection successful! ${count} models available.` };
    }
    const err = await response.json().catch(() => ({}));
    return { success: false, message: err.error?.message || `Gemini returned HTTP ${response.status}. Check your API key.` };
  } catch (e) {
    return { success: false, message: `Network error: ${e.message}` };
  }
}

async function testBedrockConnection({ model, bedrockAccessKeyId, bedrockSecretKey, bedrockSessionToken, bedrockRegion }) {
  try {
    const region = bedrockRegion || 'us-east-1';
    // Global inference profiles work from any AWS region (shown as "Global" in Bedrock console).
    // US-specific profiles only work in us-east-1/us-east-2/us-west-2.
    const usRegions = ['us-east-1', 'us-east-2', 'us-west-2'];
    const defaultPrefix = usRegions.includes(region) ? 'us.' : 'global.';
    const testModel = model || `${defaultPrefix}anthropic.claude-sonnet-4-5-20250929-v1:0`;
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(testModel)}/invoke`;

    // Minimal payload — 1 token max to confirm auth + model access at near-zero cost
    const requestBody = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    });

    const headers = { 'Content-Type': 'application/json' };
    await awsSignRequest({
      method: 'POST',
      url,
      headers,
      body: requestBody,
      region,
      accessKeyId: bedrockAccessKeyId,
      secretAccessKey: bedrockSecretKey,
      sessionToken: bedrockSessionToken,
      service: 'bedrock'
    });

    const response = await fetch(url, { method: 'POST', headers, body: requestBody });

    if (response.ok) {
      return { success: true, message: `AWS Bedrock connection successful! Model "${testModel}" is accessible in ${region}.` };
    }

    const err = await response.json().catch(() => ({}));
    const msg = err.message || err.Message || `Bedrock returned HTTP ${response.status}`;

    if (response.status === 403) {
      return { success: false, message: `Access denied (403): ${msg}. Check IAM permissions or Session Token.` };
    }
    if (response.status === 400) {
      // Direct model IDs (e.g. anthropic.claude-...) don't work in most regions.
      // Models shown as "Global" in the Bedrock console require global.* inference profiles.
      const isDirectId = !testModel.startsWith('global.') && !testModel.startsWith('us.') && !testModel.startsWith('eu.');
      const hint = isDirectId
        ? ` — Use a "Global" inference profile ID instead (e.g. "global.${testModel}"). Select one from the Model dropdown.`
        : '';
      return { success: false, message: `HTTP 400: ${msg}${hint}` };
    }
    return { success: false, message: `HTTP ${response.status}: ${msg}` };
  } catch (e) {
    return { success: false, message: `Network error: ${e.message}` };
  }
}

async function testConfluence({ url, email, token }) {
  if (!url || !email || !token) {
    return { success: false, message: 'URL, email, and token are required' };
  }
  try {
    const credentials = btoa(`${email}:${token}`);
    const response = await fetch(`${url}/wiki/rest/api/space`, {
      headers: { 
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      },
    });
    if (response.ok) {
      return { success: true };
    } else {
      return { success: false, message: `Failed with status: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function testFigma({ token }) {
  if (!token) {
    return { success: false, message: 'Token is required' };
  }
  try {
    const response = await fetch('https://api.figma.com/v1/me', {
      headers: { 'X-Figma-Token': token },
    });
    if (response.ok) {
      return { success: true };
    } else {
      return { success: false, message: `Failed with status: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function testGoogle({ apiKey }) {
  if (!apiKey) {
    return { success: false, message: 'API key is required' };
  }
  try {
    const response = await fetch(`https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=017576662512468239146:omuauf_lfve&q=testrail`);
    if (response.ok) {
      return { success: true };
    } else {
      return { success: false, message: `Failed with status: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function testTestRail({ url, username, apiKey }) {
  if (!url || !username || !apiKey) {
    return { success: false, message: 'URL, username, and API key are required' };
  }
  try {
    const response = await fetch(`${url}/index.php?/api/v2/get_statuses`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + btoa(`${username}:${apiKey}`),
      },
    });
    if (response.ok) {
      return { success: true };
    } else {
      return { success: false, message: `Failed with status: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

// Sleep utility for retry delays
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ AWS SigV4 Signing for Bedrock ============

async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, typeof data === 'string' ? new TextEncoder().encode(data) : data));
}

async function sha256(data) {
  const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SigV4 URI encoding per AWS spec:
 * Encode every character except the unreserved set: A-Z a-z 0-9 - . _ ~
 * This is stricter than encodeURIComponent — it also encodes ! ' ( ) *
 * Critically, it encodes '%' itself (as %25), so an already-encoded %3A becomes %253A,
 * which is exactly what AWS expects in the canonical URI.
 */
function sigV4UriEncode(str) {
  return str.replace(/[^A-Za-z0-9\-._~]/g, c => {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  });
}

/**
 * Build the SigV4 canonical URI from a URL pathname.
 * Each path segment is individually SigV4-encoded; '/' separators are preserved.
 */
function buildCanonicalUri(pathname) {
  return pathname.split('/').map(sigV4UriEncode).join('/');
}

async function awsSignRequest({ method, url, headers, body, region, accessKeyId, secretAccessKey, sessionToken, service = 'bedrock' }) {
  const parsedUrl = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);

  headers['x-amz-date'] = amzDate;
  headers['host'] = parsedUrl.host;

  // Required for temporary credentials (ASIA... Access Key ID)
  if (sessionToken && sessionToken.trim()) {
    headers['x-amz-security-token'] = sessionToken.trim();
  }

  const payloadHash = toHex(await sha256(body || ''));
  headers['x-amz-content-sha256'] = payloadHash;

  // Canonical headers - must be sorted by lowercase key
  const signedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[Object.keys(headers).find(h => h.toLowerCase() === k)].trim()}`).join('\n') + '\n';
  const signedHeaders = signedHeaderKeys.join(';');

  // Canonical request — path must be SigV4-encoded (e.g. %3A → %253A)
  const canonicalRequest = [
    method,
    buildCanonicalUri(parsedUrl.pathname),
    parsedUrl.search ? parsedUrl.search.substring(1) : '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    toHex(await sha256(canonicalRequest))
  ].join('\n');

  // Derive signing key
  const kDate = await hmacSha256('AWS4' + secretAccessKey, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');

  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

// Call AWS Bedrock API (Claude models)
// Detect if a Bedrock model ID is an OpenAI model
function isBedrockOpenAIModel(modelId) {
  // Real Bedrock OpenAI model IDs are openai.gpt-oss-* (not us.openai.*)
  return modelId && modelId.startsWith('openai.');
}

// callBedrock is provided by llm-client.js (importScripts above).

// Streaming version of Bedrock API (Claude + OpenAI models)
// callBedrockStream is provided by llm-client.js (importScripts above).

// Call OpenAI API directly
// callOpenAI is provided by llm-client.js (importScripts above).

// Call Gemini API directly
// callGemini is provided by llm-client.js (importScripts above).

// Call Claude (Anthropic) API directly
// callClaude is provided by llm-client.js (importScripts above).

// Streaming version of OpenAI API
// callOpenAIStream is provided by llm-client.js (importScripts above).

// Streaming version of Claude API
// callClaudeStream is provided by llm-client.js (importScripts above).

// Streaming version of Gemini API (Note: Gemini uses SSE differently)
// callGeminiStream is provided by llm-client.js (importScripts above).

// Unified streaming AI call function
// callAIStream is provided by llm-client.js (importScripts above).

// Cancel active stream
function cancelStream(requestId) {
  const controller = activeStreams.get(requestId);
  if (controller) {
    controller.abort();
    activeStreams.delete(requestId);
    return true;
  }
  return false;
}
