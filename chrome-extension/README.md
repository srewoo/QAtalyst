# 🚀 QAtalyst - AI Test Case Generator for Jira

## Serverless Chrome Extension (v6.0.0)

**No backend required!** QAtalyst is a serverless Chrome extension that calls OpenAI and Gemini APIs directly from your browser to generate intelligent test cases for Jira tickets.

## ✨ Features

### 🧬 Multi-Agent Test Generation System
- **Positive Test Agent**: Generates happy path scenarios
- **Negative Test Agent**: Creates error handling and validation tests
- **Edge Case Agent**: Identifies boundary conditions and corner cases
- **Regression Test Agent**: Ensures existing functionality remains intact
- **Integration Test Agent**: Tests API and system interactions
- **Review Agent**: Performs quality checks and gap analysis

### 🔍 Smart Requirement Analysis
- Automatically extracts requirements from Jira tickets
- Analyzes ticket description, comments, and attachments
- Integrates with Confluence, Figma, and Google Docs
- OCR support for images and screenshots

### ⚙️ Flexible Configuration
- Support for multiple AI providers:
  - **OpenAI** (GPT-4o, GPT-4.1, GPT-4o Mini, O4 Mini)
  - **Google Gemini** (Gemini 2.0 Flash Exp, Gemini 2.5 Pro/Flash)
- **Your API key stays in your browser** - Never sent to our servers
- Customizable temperature and max tokens
- Copy test cases to clipboard for easy integration

### 🔒 Privacy & Security
- ✅ No backend server - All processing in your browser
- ✅ Your API keys stored locally in Chrome
- ✅ Direct API calls to OpenAI/Gemini
- ✅ No data collection or tracking
- ✅ Open source and auditable

## 📦 Installation

### Option 1: Chrome Web Store (Coming Soon)
Search for "QAtalyst" in the Chrome Web Store and click "Add to Chrome"

### Option 2: Load Unpacked (For Testing)

1. **Download or Clone**
   ```bash
   # Clone the repository
   git clone https://github.com/yourorg/qatalyst.git
   cd qatalyst/chrome-extension
   ```

2. **Open Chrome Extensions**
   - Navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top-right corner)

3. **Load Extension**
   - Click "Load unpacked"
   - Select the `chrome-extension` folder
   - QAtalyst icon should appear in your toolbar

4. **Configure API Key**
   - Click the QAtalyst icon
   - Select AI Provider (OpenAI or Gemini)
   - Enter your API key
   - Click "Save Settings"

## 🚀 Quick Start

### 1. Get Your API Key

**OpenAI:**
- Go to https://platform.openai.com/api-keys
- Create new API key
- Recommended model: **GPT-4o** (best quality) or **GPT-4o Mini** (faster/cheaper)

**Google Gemini:**
- Go to https://aistudio.google.com/app/apikey
- Get your API key
- Recommended model: **Gemini 2.0 Flash Exp** (free tier available)

### 2. Configure Extension

1. Click the **QAtalyst** icon in Chrome toolbar
2. Select your AI provider (OpenAI or Gemini)
3. Choose the model
4. Paste your API key
5. Click **Save Settings**

### 3. Use on Jira Tickets

1. Open any Jira ticket: `https://your-company.atlassian.net/browse/PROJ-123`
2. **QAtalyst panel** appears on the right side
3. Click through the workflow:
   - **🔍 Analyse Requirements** - Extract and structure requirements
   - **📋 Generate Test Scope** - Create comprehensive test plan
   - **✓ Generate Test Cases** - Generate 20-30 detailed test cases
4. **Copy to Clipboard** - Paste test cases into Jira or your test management tool

## ⚙️ Configuration Options

Access **Open Full Settings** from the popup to configure:

### AI Settings
- **Temperature** (0-1): Controls creativity vs consistency
  - 0.3-0.5: More focused and deterministic
  - 0.7: Balanced (recommended)
  - 0.8-1.0: More creative and diverse
- **Max Tokens**: Maximum response length (default: 4000)

### What Gets Generated

**Test Case Distribution:**
- Positive scenarios: 40% (Happy path)
- Negative scenarios: 30% (Error handling)
- Edge cases: 20% (Boundary conditions)
- Integration: 10% (System interactions)

**Each Test Case Includes:**
- Unique ID (TC-XXX-NNN format)
- Clear title and description
- Category and Priority (P0-P3)
- Step-by-step instructions
- Expected results
- Preconditions
- Test data requirements

## 📊 Test Case Format

Generated test cases include:

```json
{
  "id": "TC-POS-001",
  "title": "Verify user login with valid credentials",
  "category": "Positive",
  "priority": "P0",
  "steps": [
    "Navigate to login page",
    "Enter valid username",
    "Enter valid password",
    "Click Login button"
  ],
  "expected_result": "User is successfully logged in and redirected to dashboard",
  "preconditions": "User account exists in the system",
  "test_data": "Username: testuser@example.com, Password: ValidPass123"
}
```

## 🎯 Best Practices

1. **Write Clear Acceptance Criteria** - Better Jira tickets = better test cases
2. **Include Context** - Add comments, attachments, and linked pages for comprehensive analysis
3. **Review Generated Tests** - Always review AI-generated tests before using
4. **Start with GPT-4o** - Best quality for critical features
5. **Use Gemini for Speed** - Faster generation for less critical features

## 🐛 Troubleshooting

### Panel Not Appearing
- Refresh Jira page (Ctrl+F5)
- Check extension is enabled in `chrome://extensions`
- Verify you're on `/browse/TICKET-ID` URL (not board view)
- Check browser console (F12) for errors

### API Key Errors
- Verify API key is correct and has no extra spaces
- Check API key has sufficient credits/quota
- OpenAI: https://platform.openai.com/usage
- Gemini: Check your Google Cloud quota

### Poor Quality Test Cases
- Ensure Jira ticket has detailed description
- Add acceptance criteria and business rules
- Try increasing temperature (0.7 → 0.9)
- Try different AI model (e.g., GPT-4o instead of GPT-4o Mini)

### Timeout Errors
- Reduce max_tokens setting (4000 → 2000)
- Try Gemini (faster than OpenAI)
- Check your internet connection

## 📝 Technical Details

### Architecture
- **100% Client-Side**: No backend server needed
- **Direct API Calls**: Chrome extension → OpenAI/Gemini
- **Local Storage**: API keys stored in Chrome's secure storage
- **Privacy First**: No data sent to third-party servers

### File Structure
```
chrome-extension/
├── manifest.json          # Extension config
├── background.js          # Direct AI API calls
├── content.js             # Jira page integration
├── styles.css             # UI styling
├── popup.html/js          # Quick settings
├── options.html/js        # Advanced settings
└── icons/                 # Extension icons
```

## 📄 License

MIT License - Free to use and modify

## 🎉 Version History

**v6.0.0** (Current - Serverless)
- ✅ No backend required
- ✅ Direct OpenAI & Gemini API calls
- ✅ Privacy-focused (keys stay in browser)
- ✅ Chrome Web Store ready
- ✅ Simplified 3-step workflow

**v5.x** (Legacy - Backend Required)
- Multi-agent system with Python backend
- MongoDB for caching
- TestRail integration
- Complex setup required

---

**🚀 Chrome Web Store Ready • 🔒 Privacy-First • 💡 AI-Powered**
