/**
 * Expected results must not assert status codes, exact messages or limits the
 * ticket never states. The LLM critic is asked not to; this is the deterministic
 * backstop.
 */
const { flagInventedSpecifics, unsupportedSpecifics, ticketCorpus, crawlEvidence } = require('../assertion-specifics.js');

const ticket = {
  summary: 'Users can sign in',
  acceptanceCriteria: 'An invalid password shows an error message\nThe account is locked after 5 failed attempts',
  comments: [{ text: 'Show "Your account is locked" when locked' }],
  documentAttachments: [{ text: 'Uploads above 100 KB must be rejected' }]
};
const kg = { pages: [{ url: 'https://app/login', apis: [{ method: 'POST', endpoint: '/api/login', statusCode: 401 }],
  features: [{ type: 'button', text: 'Sign In' }] }] };
const corpus = ticketCorpus(ticket);
const ev = crawlEvidence(kg);
const check = (expected) => unsupportedSpecifics(expected, corpus, ev);

describe('invented specifics', () => {
  test('an invented message and status code are flagged', () => {
    expect(check('"Invalid credentials (E401)" is shown and the API returns 403')).toEqual(
      ['status 403', 'the exact text "Invalid credentials (E401)"']);
  });

  test('specifics the ticket states, or the crawl observed, pass', () => {
    expect(check('The API returns 401 and "Your account is locked" is shown')).toEqual([]);   // crawl saw 401; comment states the text
    expect(check('The account is locked after 5 failed attempts')).toEqual([]);              // AC states 5
    expect(check('The "Sign In" button is disabled')).toEqual([]);                            // a real UI label
  });

  test('an invented limit is flagged, but plain test data is not', () => {
    expect(check('The page loads within 2 seconds')).toEqual(['the value "within 2 seconds"']);
    expect(check('All 3 rows are invited')).toEqual([]);
  });

  test('flagged tests carry a warning the panel already renders; clean ones are untouched', () => {
    const tests = [{ title: 'a', expected_result: 'Returns 500' }, { title: 'b', expected_result: 'An error message is shown' }];
    const { flagged } = flagInventedSpecifics(tests, ticket, kg);
    expect(flagged).toBe(1);
    expect(tests[0]._behaviorWarnings[0]).toMatch(/status 500.*does not state/);
    expect(tests[1]._behaviorWarnings).toBeUndefined();
  });

  test('no crawl and an empty ticket do not crash', () => {
    expect(flagInventedSpecifics([{ expected_result: 'Returns 200' }], {}, null).flagged).toBe(1);
  });
});
