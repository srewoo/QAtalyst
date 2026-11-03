// Test cases as QAtalyst would generate them, run through the exporter on every
// `npm run test:export`. T-03 asserts something the app does not do: it MUST fail,
// which proves the exported specs really check behaviour.
const URL = 'http://127.0.0.1:4977/login';
module.exports = [
  { id: 'T-01', title: 'Wrong password shows an error', category: 'Negative', priority: 'P1', preconditions: `On ${URL}`,
    steps: ['Type "a@b.co" in the "Email" field', 'Type "nope" in the "Password" field', 'Click "Sign In"'],
    expected_result: '"Invalid password" is shown and POST /api/auth/login returns 401' },
  { id: 'T-02', title: 'Right password lands on the dashboard', category: 'Positive', priority: 'P1', preconditions: `On ${URL}`,
    steps: ['Type "a@b.co" in the "Email" field', 'Type "right" in the "Password" field', 'Click "Sign In"'],
    expected_result: 'The user lands on /dashboard and POST /api/auth/login returns 200' },
  { id: 'T-03', title: 'Wrong expectation is caught', category: 'Negative', priority: 'P2', preconditions: `On ${URL}`,
    steps: ['Type "a@b.co" in the "Email" field', 'Type "nope" in the "Password" field', 'Click "Sign In"'],
    expected_result: '"Welcome back" is shown' }
];
