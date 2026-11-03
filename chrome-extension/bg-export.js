/**
 * bg-export.js — Export of a generated suite to the configured test-management tool.
 *
 * Moved verbatim out of background.js. Plain script: the worker importScripts it,
 * so these functions stay globals and every call site is unchanged.
 */


// Test Management Export Handler
async function handleExportToTestManagement(testCases, jiraTicket) {
  try {
    // Get settings from storage
    const settings = await chrome.storage.sync.get([
      'testMgmtPlatform',
      'testrailUrl',
      'testrailUsername',
      'testrailApiKey',
      'testrailProjectId',
      'testrailSection',
      'zephyrScaleApiToken',
      'zephyrScaleProjectKey',
      'zephyrScaleFolderId',
      'zephyrSquadJiraUrl',
      'zephyrSquadUsername',
      'zephyrSquadApiToken',
      'zephyrSquadProjectKey',
      'zephyrSquadVersionId',
      'xrayIsCloud',
      'xrayJiraUrl',
      'xrayUsername',
      'xrayApiToken',
      'xrayClientId',
      'xrayClientSecret',
      'xrayProjectKey',
      'qmetryIsCloud',
      'qmetryApiUrl',
      'qmetryApiKey',
      'qmetryUsername',
      'qmetryPassword',
      'qmetryProjectId',
      'qmetryReleaseId',
      'fieldMappings'
    ]);

    const platform = settings.testMgmtPlatform;

    if (!platform || platform === 'none') {
      throw new Error('No test management platform configured. Please configure one in Settings > Integrations.');
    }

    let integration;
    let results;
    let fieldMappings = {};

    // Parse field mappings if available
    if (settings.fieldMappings) {
      try {
        fieldMappings = JSON.parse(settings.fieldMappings);
      } catch (e) {
        console.warn('Failed to parse field mappings:', e);
      }
    }

    // Create integration instance based on platform
    switch (platform) {
      case 'testrail':
        integration = new TestRailIntegration({
          testrailUrl: settings.testrailUrl,
          testrailUsername: settings.testrailUsername,
          testrailApiKey: settings.testrailApiKey,
          testrailProjectId: settings.testrailProjectId,
          testrailSection: settings.testrailSection
        });
        // Store for cancellation
        activeIntegration = integration;
        results = await integration.uploadTestCases(testCases, jiraTicket, null, fieldMappings);
        break;

      case 'zephyr-scale':
        integration = new ZephyrScaleIntegration({
          zephyrScaleApiToken: settings.zephyrScaleApiToken,
          zephyrScaleProjectKey: settings.zephyrScaleProjectKey,
          zephyrScaleFolderId: settings.zephyrScaleFolderId
        });
        results = await integration.uploadTestCases(testCases, jiraTicket, `QAtalyst: ${jiraTicket}`, { customFields: fieldMappings });
        break;

      case 'zephyr-squad':
        integration = new ZephyrSquadIntegration({
          zephyrSquadJiraUrl: settings.zephyrSquadJiraUrl,
          zephyrSquadUsername: settings.zephyrSquadUsername,
          zephyrSquadApiToken: settings.zephyrSquadApiToken,
          zephyrSquadProjectKey: settings.zephyrSquadProjectKey,
          zephyrSquadVersionId: settings.zephyrSquadVersionId
        });
        results = await integration.uploadTestCases(testCases, jiraTicket, null, { customFields: fieldMappings });
        break;

      case 'xray':
        integration = new XrayIntegration({
          xrayIsCloud: settings.xrayIsCloud,
          xrayJiraUrl: settings.xrayJiraUrl,
          xrayUsername: settings.xrayUsername,
          xrayApiToken: settings.xrayApiToken,
          xrayClientId: settings.xrayClientId,
          xrayClientSecret: settings.xrayClientSecret,
          xrayProjectKey: settings.xrayProjectKey
        });
        results = await integration.uploadTestCases(testCases, jiraTicket, null, { customFields: fieldMappings });
        break;

      case 'qmetry':
        integration = new QmetryIntegration({
          qmetryIsCloud: settings.qmetryIsCloud,
          qmetryApiUrl: settings.qmetryApiUrl,
          qmetryApiKey: settings.qmetryApiKey,
          qmetryUsername: settings.qmetryUsername,
          qmetryPassword: settings.qmetryPassword,
          qmetryProjectId: settings.qmetryProjectId,
          qmetryReleaseId: settings.qmetryReleaseId
        });
        results = await integration.uploadTestCases(testCases, jiraTicket, `QAtalyst: ${jiraTicket}`, { customFields: fieldMappings });
        break;

      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }

    // Return success response with results
    return {
      success: true,
      platform: getPlatformDisplayName(platform),
      results: results
    };

  } catch (error) {
    console.error('Export to test management failed:', error);
    throw error;
  }
}
