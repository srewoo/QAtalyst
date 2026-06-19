/**
 * Robust JSON parser for AI-generated output.
 *
 * Extracted into its own module in v13.2 (previously lived in the now-removed
 * agents.js). The agentic engine depends on it via `self.parseRobustJSON`
 * (agent-tools.js, agent-loop.js) to salvage truncated/dirty LLM JSON, so it
 * must be loaded as part of the service worker.
 *
 * Pure logic, no browser/network dependency → unit-testable under Vitest.
 */

/**
 * Robust JSON parser that handles common AI-generated JSON errors,
 * including truncated responses from LLMs.
 */
function parseRobustJSON(jsonString) {
  // Try direct parse first
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    // Attempt to fix common issues
    let fixed = jsonString;

    // Remove trailing commas before } or ]
    fixed = fixed.replace(/,(\s*[}\]])/g, '$1');

    // Add missing commas between properties (common error)
    fixed = fixed.replace(/"\s*\n\s*"/g, '",\n"');

    // Fix missing commas after closing arrays/objects
    fixed = fixed.replace(/(\]|\})\s*\n\s*"/g, '$1,\n"');

    // Remove comments (if AI added them)
    fixed = fixed.replace(/\/\/.*/g, '');
    fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');

    try {
      return JSON.parse(fixed);
    } catch (e2) {
      // Truncated array: [{...}, {...}, {incomplete...
      if (fixed.trim().startsWith('[')) {
        const completeObjects = extractCompleteObjectsFromArray(fixed);
        if (completeObjects.length > 0) {
          console.log(`[parseRobustJSON] Recovered ${completeObjects.length} complete objects from truncated array`);
          return completeObjects;
        }
      }

      // Truncated wrapper object: {"testCases": [{...}, {incomplete...
      // Extract the inner array value and salvage complete items from it
      const innerArrayMatch = fixed.match(/"testCases"\s*:\s*(\[[\s\S]*)/);
      if (innerArrayMatch) {
        const innerArray = innerArrayMatch[1];
        const completeObjects = extractCompleteObjectsFromArray(innerArray);
        if (completeObjects.length > 0) {
          console.log(`[parseRobustJSON] Recovered ${completeObjects.length} test cases from truncated wrapper`);
          return { testCases: completeObjects };
        }
      }

      // Last resort: try to find any complete JSON object
      const match = fixed.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch (e3) {
          throw new Error(`JSON parsing failed: ${e.message} at ${e2.message}`);
        }
      }
      throw e2;
    }
  }
}

/**
 * Extract complete JSON objects from a truncated array response.
 * Handles cases like: [{...}, {...}, {incomplete...
 */
function extractCompleteObjectsFromArray(jsonString) {
  const objects = [];
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let objectStart = -1;

  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      if (depth === 0) {
        objectStart = i;
      }
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && objectStart !== -1) {
        // Found a complete object
        const objectStr = jsonString.substring(objectStart, i + 1);
        try {
          const parsed = JSON.parse(objectStr);
          objects.push(parsed);
        } catch (parseErr) {
          // Skip malformed objects
          console.warn('[extractCompleteObjects] Skipping malformed object');
        }
        objectStart = -1;
      }
    }
  }

  return objects;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseRobustJSON, extractCompleteObjectsFromArray };
}
if (typeof self !== 'undefined') {
  self.parseRobustJSON = parseRobustJSON;
  self.extractCompleteObjectsFromArray = extractCompleteObjectsFromArray;
}
