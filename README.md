# 🚀 QAtalyst - AI-Powered Test Case Generation for Jira

**Advanced Chrome Extension with Multi-Agent System & Evolutionary Optimization**

[![Version](https://img.shields.io/badge/version-11.2.1-blue.svg)](https://github.com/your-repo)
[![Chrome Extension](https://img.shields.io/badge/chrome-extension-green.svg)](https://chrome.google.com/webstore)
[![License](https://img.shields.io/badge/license-Proprietary-red.svg)](LICENSE)

## 📋 Overview

QAtalyst is a Chrome extension that generates grounded, full-coverage test cases for Jira tickets. Its core is an **agentic planner loop**: one orchestrating LLM decides each step (search the crawled app, inspect an element, check coverage, propose tests, query Jira history, finish), and every proposed test must pass an **acceptance gate** — grounding against the real crawled app, relevance to the ticket, and de-duplication — before it counts. Coverage is re-measured each round and fed back into the next decision.

### ✨ Key Highlights

- **🧭 Agentic Planner Loop**: observe → decide → act over a tool registry, with a deterministic fallback controller that guarantees forward progress even if the LLM misbehaves.
- **🛡️ Grounded Acceptance Gate**: tests that reference UI elements/fields/APIs not found in the crawled knowledge graph are repaired or rejected — not hallucinated. Vague, zero-reference tests are rejected when crawl data exists.
- **🎯 Coverage Feedback + AC Mapping**: coverage of real app features AND of the ticket's acceptance criteria drives generation and the stop condition.
- **🔁 Regression Support**: past bugs mined from Jira ground regression tests; optional de-dupe against an existing TestRail suite.
- **🔄 Response Streaming**: real-time AI output with a stop button; truncated output is salvaged rather than discarded.
- **🔗 External Integrations**: Confluence, Figma, Google Docs auto-fetch.
- **🤖 Multiple AI Providers**: OpenAI, Claude, Gemini, and AWS Bedrock.
- **📊 Smart Test Count**: configurable 20-100 tests, dynamically distributed by ticket shape.

> **Note (v13):** earlier versions described an "8-agent pipeline" and a "genetic algorithm" (`agents.js`, `evolution.js`). Those were removed in v13.2 and replaced by the agentic planner + acceptance gate documented here and in `chrome-extension/AGENTIC.md`. This README reflects the current design.

## 🏗️ Architecture

**Pure Chrome Extension** - No backend server required!

### Components
- **Content Script** (`content.js`): Injects the QAtalyst panel into Jira pages, fetches ticket data (description, comments, linked issues, acceptance criteria, attachments).
- **Background Service Worker** (`background.js`): Orchestrates generation and makes direct API calls to AI providers.
- **Agentic Planner** (`agent-loop.js`, `agent-tools.js`): the observe→decide→act loop and its tool registry.
- **Acceptance Gate** (`acceptance-gate.js`): grounding + relevance + dedup choke-point.
- **Grounded Verifier** (`grounded-verifier.js`): matches test references against real crawled entities; repairs near-misses.
- **Coverage Mapper** (`coverage-mapper.js`): maps tests to app features and acceptance criteria, surfaces gaps.
- **Crawler** (`crawler.js`, `dom-extractor.js`, `network-monitor.js`): builds the knowledge graph of the app under test.
- **Historical Mining** (`historical-mining.js`): Jira search for past bugs to ground regression tests.
- **External Integrations** (`integrations.js`): Confluence, Figma, Google Docs, TestRail, Xray, Zephyr, Qmetry.
- **Popup Interface** (`popup.html`) and **Options Page** (`options.html`): configuration.

### Why No Backend?
- ✅ **Direct API Calls**: Extension calls OpenAI/Claude/Gemini directly
- ✅ **Client-Side Processing**: All logic runs in the browser
- ✅ **Zero Latency**: No intermediary server delays
- ✅ **Easy Deployment**: Just load the extension
- ✅ **Privacy**: API keys stored locally in browser

## 🚀 Quick Start

### 1. Install Extension

```bash
# Open Chrome and navigate to:
chrome://extensions/

# Enable "Developer mode" (toggle in top-right)
# Click "Load unpacked"
# Select: chrome-extension folder
```

### 2. Configure AI Provider

1. **Click QAtalyst extension icon** in Chrome toolbar
2. **Select AI Provider**: OpenAI / Claude / Gemini
3. **Choose Model**: gpt-4.1 (Recommended) / Claude 3.5 Sonnet / Gemini 2.0 Flash
4. **Enter API Key**:
   - OpenAI: https://platform.openai.com/api-keys
   - Claude: https://console.anthropic.com/settings/keys
   - Gemini: https://aistudio.google.com/app/apikey
5. **Click "Save Settings"**

### 3. Configure Advanced Features (Optional)

1. **Click "Open Advanced Settings"** in popup
2. **Enable features** (all enabled by default):
   - ✅ Response Streaming
   - ✅ Multi-Agent System (7 agents)
   - ✅ Enhanced Test Generation (gap analysis)
   - ✅ Evolutionary Optimization (Balanced)
3. **Set test count**: 20-100 (default: 30)
4. **Configure integrations** (optional):
   - Confluence URL + Token
   - Figma Access Token
   - Google API Key

### 4. Generate Test Cases

1. **Open any Jira ticket** (e.g., PROJECT-123)
2. **QAtalyst panel** appears on right side
3. **Click "Analyse Requirements"** → AI extracts requirements
4. **Click "Generate Test Scope"** → Creates test plan
5. **Click "Generate Test Cases"** → Generates 20-100 tests
6. **Watch progress**: the planner reports each step (searching the app, checking coverage, proposing a category, etc.) and a running accepted-test count.
7. **Review results** → Add to Jira

## 🧭 Agentic Planner (v13)

Instead of a fixed multi-agent pipeline, one planner LLM runs an **observe → decide → act** loop over a tool registry:

| Tool | Purpose |
|------|---------|
| `bm25_search` | Find the crawled pages/features most relevant to the ticket |
| `inspect_element` | Check whether a selector / field / button exists in the crawled app |
| `run_coverage_check` | Map accepted tests to app features **and acceptance criteria**, return gaps |
| `propose_tests` | Generate grounded candidate tests for a category, focused on a gap |
| `query_jira` | Search Jira for past bugs to ground regression tests |
| `fetch_confluence` | Pull extra requirement context |
| `finish` | Stop when further tests would be redundant |

**How it works**

1. **Grounding-first**: every proposed test passes the acceptance gate (grounding + relevance + dedup) before it counts.
2. **Coverage feedback**: coverage of app features and acceptance criteria is re-measured each round and steers the next proposal; the loop won't finish while an acceptance criterion is uncovered and budget remains.
3. **Deterministic fallback**: if the LLM emits malformed output or stalls, a deterministic controller takes the next sensible action, guaranteeing forward progress.
4. **Dynamic distribution**: category mix (Positive/Negative/Edge/Regression/Integration) is derived from the ticket shape rather than a fixed split.

Category distribution is configured in **Options → Categories**.

## 🎯 All Features

> Historical note: the sections below were written around an earlier "5-phase / multi-agent / genetic" design. The generation engine is now the agentic planner described above (see `chrome-extension/AGENTIC.md` for the authoritative design); treat any "agent"/"evolution" phrasing below as historical.

### Phase 1: Foundation
- ✅ **3 AI Providers**: OpenAI (gpt-4.1, GPT-4 Turbo), Claude (3.5 Sonnet, 3 Opus), Gemini (2.0 Flash, 1.5 Pro)
- ✅ **Response Streaming**: Real-time output with stop button
- ✅ **Test Count Slider**: Configure 20-100 tests

### Phase 2: Multi-Agent System
- ✅ **7 Specialized Agents**: Requirement, Positive, Negative, Edge, Regression, Integration, Review
- ✅ **Agent Configuration**: Enable/disable individual agents
- ✅ **Progress Tracking**: Real-time agent status updates

### Phase 3: Evolutionary Optimization
- ✅ **Genetic Algorithm**: Population-based test improvement
- ✅ **5 Mutation Strategies**: Data variation, scenario expansion, boundary testing, error injection, context shifting
- ✅ **Intensity Levels**: Light (3 gen), Balanced (5 gen), Intensive (8 gen), Exhaustive (10 gen)
- ✅ **Fitness Evaluation**: Coverage diversity (30%) + Quality (40%) + Completeness (30%)

### Phase 4: External Integrations
- ✅ **Confluence**: Auto-fetch requirement pages
- ✅ **Figma**: Extract design specifications
- ✅ **Google Docs**: Fetch documentation content
- ✅ **Rate Limit Handling**: Smart retry with backoff

### Phase 5: Enhanced Features
- ✅ **Gap Analysis**: AI identifies missing coverage
- ✅ **Auto Gap-Filling**: Generates tests for critical gaps
- ✅ **Smart Complexity Scaling**: Adjusts test count based on ticket complexity
- ✅ **Context-Aware Generation**: Uses project/domain terminology

## ⚙️ Configuration Options

### 5 Settings Tabs

**1. API Settings**
- LLM Provider & Model selection
- API Key configuration
- Temperature & Max Tokens
- Enable Streaming toggle
- Enable Multi-Agent toggle

**2. Agent Configuration**
- Enable/disable each of 7 agents
- View agent descriptions

**3. Test Case Settings**
- Test count slider (20-100)
- Enable Enhanced Generation
- Test distribution percentages
- Evolutionary optimization settings

**4. Integrations**
- Confluence URL + API Token
- Figma Personal Access Token
- Google API Key

**5. Help & Docs**
- Complete feature documentation
- Setup guides with links
- Troubleshooting tips
- Best practices

## 📁 Project Structure

```
QAtalyst/
├── chrome-extension/              # Complete Extension
│   ├── manifest.json             # Extension config (v9.2.2)
│   ├── background.js             # Service worker + API calls
│   ├── content.js                # Jira panel injection
│   ├── agents.js                 # 7-agent system
│   ├── evolution.js              # Genetic algorithm
│   ├── integrations.js           # External APIs (Confluence/Figma/Docs)
│   ├── enhancements.js           # Gap analysis + complexity scaling
│   ├── popup.html/js             # Quick settings popup
│   ├── options.html/js           # Advanced settings page
│   ├── styles.css                # UI styling
│   └── icons/                    # Extension icons
│
├── README.md                      # This file
├── QUICK_START.md                # Quick start guide
└── qatalyst-v9.2.2-webstore.zip   # Packaged extension
```

## 🔧 Technical Stack

- **Platform**: Chrome Extension (Manifest V3)
- **Language**: Pure JavaScript (ES6+)
- **APIs**: OpenAI, Anthropic Claude, Google Gemini
- **External**: Confluence REST API, Figma API, Google Docs API
- **Storage**: Chrome Storage API (sync)
- **UI**: Vanilla HTML/CSS with modern styling

## 📊 Performance

| Operation | Time | Notes |
|-----------|------|-------|
| **Requirement Analysis** | ~10s | Single AI call |
| **Test Scope** | ~15s | Single AI call |
| **Test Generation (Multi-Agent)** | ~2-3 min | 7 sequential agents |
| **With Evolution (Balanced)** | ~4-5 min | +5 generations |
| **External Integration Fetch** | ~2-5s per source | Parallel fetching |

### Optimization Tips
- Disable streaming for faster results
- Reduce test count for quicker generation
- Use Light evolution intensity
- Disable unused agents

## 💡 Usage Example

### Input: Jira Ticket
```
PROJ-123: Add User Authentication
Description: Implement OAuth 2.0 login with Google and GitHub
Acceptance Criteria:
- Users can log in with Google
- Users can log in with GitHub  
- Session persists for 7 days
- Logout clears session
```

### Output: Generated Tests (with all features enabled)

**Phase 1 - Multi-Agent Generation**: 30 base tests
- 12 Positive tests (happy path login flows)
- 9 Negative tests (invalid credentials, expired tokens)
- 6 Edge cases (concurrent logins, session expiry)
- 2 Regression tests (existing user data intact)
- 1 Integration test (OAuth provider API)

**Phase 2 - Enhancement**: +5 gap-filling tests
- Missing: Password reset flow
- Missing: Account linking scenarios
- Complexity score: 75/100 → Auto-scaled

**Phase 3 - Evolution**: +15 optimized tests
- Data variations (different OAuth scopes)
- Scenario expansions (multi-device login)
- Error injections (network failures)

**Total**: 50 comprehensive test cases ✅

## 🐛 Troubleshooting

### Extension Issues
| Problem | Solution |
|---------|----------|
| Panel doesn't appear | Refresh Jira page, ensure on ticket page (not board view) |
| Settings won't save | Update to v9.1.2, clear browser cache |
| Extension icon missing | Reload extension in chrome://extensions/ |

### API Issues
| Problem | Solution |
|---------|----------|
| "API Key required" error | Configure API key in popup settings |
| Rate limit exceeded | Wait 60s, or switch to different provider |
| Slow responses | Reduce max tokens (4000→2000), disable evolution |
| Figma rate limits | Extension auto-retries with backoff |

### Generation Issues
| Problem | Solution |
|---------|----------|
| No tests generated | Check browser console (F12) for errors |
| Poor test quality | Increase temperature (0.7→0.9), try Claude |
| Too many tests | Disable evolution, reduce test count slider |
| Missing test types | Enable all agents in Agent Configuration |

### Performance Issues
| Problem | Solution |
|---------|----------|
| Takes too long | Disable evolution or use Light intensity |
| Browser freezes | Reduce test count, close other tabs |
| Streaming stops | Check network connection, reload extension |

## 🎯 Best Practices

### For Maximum Coverage
1. **Write detailed Jira tickets** with clear acceptance criteria
2. **Link external docs** (Confluence, Figma, Google Docs)
3. **Enable all 7 agents** for comprehensive test types
4. **Use Balanced evolution** for optimal coverage vs. time
5. **Set test count to 40-50** for most tickets
6. **Review gap analysis badges** to identify missing coverage

### For Speed
1. **Disable streaming** (faster, but no real-time updates)
2. **Disable evolution** (cuts generation time in half)
3. **Reduce test count** to 20-30
4. **Use Light intensity** if evolution is needed
5. **Disable unused agents** (e.g., if no regression needed)

### For Quality
1. **Enable Enhanced Generation** (gap analysis + complexity scaling)
2. **Use Claude 3.5 Sonnet** (best quality, slower)
3. **Increase temperature** to 0.8-0.9 for creativity
4. **Add context** in Jira description (user personas, workflows)
5. **Review and refine** generated tests before using

## 🔄 Version History

| Version | Date | Features |
|---------|------|----------|
| **v10.0.1** | 2025-10-30 | 🐛 Bug fixes (settings save, DOM loading) |
| **v9.2.2** | 2025-10-30 | 🔒 Security fixes, user review feature, bug fixes |
| **v9.1.2** | 2025-10-29 | 🐛 Bug fixes (settings save, DOM loading) |
| **v9.1.0** | 2025-10-29 | 📚 Enhanced Help & Docs tab |
| **v9.0.0** | 2025-10-29 | 🎯 Phase 5: Enhanced Features |
| **v8.0.1** | 2025-10-29 | 🔧 Figma rate limit handling |
| **v8.0.0** | 2025-10-29 | 🔗 Phase 4: External Integrations |
| **v7.5.0** | 2025-10-29 | 🧬 Phase 3: Evolutionary Optimization |
| **v7.0.0** | 2025-10-29 | 🤖 Phase 2: Multi-Agent System |
| **v6.3.0** | 2025-10-29 | 📊 Phase 1.3: Test Count Slider |
| **v6.2.0** | 2025-10-29 | ⚡ Phase 1.2: Response Streaming |
| **v6.1.0** | 2025-10-29 | 🎨 Phase 1.1: Claude API Support |

## 📄 License

Proprietary - Internal Use Only

## 🙏 Acknowledgments

Built with OpenAI API, Anthropic Claude API, Google Gemini API, Chrome Extension APIs, Confluence API, Figma API, and Google Docs API.

---

**Version**: 9.2.2
**Status**: ✅ Production Ready
**Built for**: Smarter, faster QA workflows
**Maintained by**: QA Engineering Team
