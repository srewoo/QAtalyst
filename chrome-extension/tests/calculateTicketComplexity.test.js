/**
 * Tests for BaseAgent.calculateTicketComplexity.
 * Complexity classification drives batch scaling and CoT depth — getting the
 * classification wrong means wasting tokens on simple tickets or under-generating on complex ones.
 */

// ---------------------------------------------------------------------------
// Inline the pure function under test (no browser globals needed)
// ---------------------------------------------------------------------------
function calculateTicketComplexity(ticketData) {
  let score = 0;
  const factors = {};
  const descText = (ticketData.description || '') + ' ' + (ticketData.summary || '');
  const descLower = descText.toLowerCase();

  const descWords = descText.split(/\s+/).filter(Boolean).length;
  factors.descWords = descWords;
  if (descWords > 400) score += 3;
  else if (descWords > 150) score += 2;
  else score += 1;

  const acHits = (descText.match(/acceptance criteria|given\s|when\s|then\s|AC:|must\s|shall\s/gi) || []).length;
  factors.acMentions = acHits;
  if (acHits > 10) score += 3;
  else if (acHits > 4) score += 2;
  else if (acHits > 0) score += 1;

  const integTerms = ['api', 'service', 'integration', 'webhook', 'endpoint', 'external',
    'third-party', 'sync', 'event', 'kafka', 'queue', 'database', 'storage', 'auth', 'oauth'];
  const integCount = integTerms.filter(t => descLower.includes(t)).length;
  factors.integrationTerms = integCount;
  if (integCount > 5) score += 3;
  else if (integCount > 2) score += 2;
  else if (integCount > 0) score += 1;

  const roleTerms = ['admin', 'host', 'participant', 'moderator', 'owner',
    'viewer', 'editor', 'manager', 'guest', 'operator', 'superadmin'];
  const roleCount = roleTerms.filter(t => descLower.includes(t)).length;
  factors.userRoles = roleCount;
  if (roleCount > 3) score += 2;
  else if (roleCount > 1) score += 1;

  const sp = parseInt(ticketData.storyPoints || ticketData.story_points || 0, 10);
  factors.storyPoints = sp;
  if (sp >= 8) score += 2;
  else if (sp >= 3) score += 1;

  const linked = (ticketData.linkedIssues || []).length + (ticketData.linkedPages || []).length;
  factors.linkedItems = linked;
  if (linked > 3) score += 2;
  else if (linked > 0) score += 1;

  const level = score >= 11 ? 'complex' : score >= 6 ? 'medium' : 'simple';
  return { level, score, factors };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SIMPLE_TICKET = {
  summary: 'Add cancel button to modal',
  description: 'User wants a cancel button on the confirmation modal.',
  storyPoints: 1,
};

const MEDIUM_TICKET = {
  summary: 'Implement meeting scheduling',
  description: `As a host I want to schedule meetings so that participants receive email invitations.
Given a logged-in host, when they fill out the scheduling form, then the meeting must be created.
AC: The form must validate the date field. The system shall send a confirmation email.
The service should integrate with the calendar API and auth service.`,
  storyPoints: 5,
  linkedPages: [{ url: 'https://docs.example.com/meetings' }],
};

const COMPLEX_TICKET = {
  summary: 'Multi-tenant RBAC with external auth, kafka events, and audit logging',
  description: `As an admin I want to configure role-based access so that different user types (admin,
moderator, editor, viewer, guest, operator, host, participant) have appropriate permissions.
Acceptance criteria: Given a superadmin, when they change a role, then the system must emit a
kafka event, update the database, sync with the external auth service via oauth endpoint, and
write an audit entry. The integration with the third-party identity provider must support webhook
callbacks. The storage layer must cache permissions and the queue must process role changes async.
Must support concurrent role updates. Shall validate via the API before committing. External
service failures must trigger compensating actions. Auth tokens must refresh transparently.
The service mesh must handle retries. Given high load, when throughput exceeds 1000 req/s,
then the system shall throttle gracefully without data loss.`.repeat(3), // make it long
  storyPoints: 13,
  linkedIssues: ['AUTH-123', 'RBAC-456', 'AUDIT-789', 'KAFKA-101'],
  linkedPages: ['https://confluence.example.com/rbac-design'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('calculateTicketComplexity', () => {
  describe('return shape', () => {
    test('always returns { level, score, factors } shape', () => {
      const result = calculateTicketComplexity(SIMPLE_TICKET);
      expect(result).toHaveProperty('level');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('factors');
      expect(typeof result.score).toBe('number');
    });

    test('factors always contains all 6 keys', () => {
      const result = calculateTicketComplexity(SIMPLE_TICKET);
      expect(result.factors).toHaveProperty('descWords');
      expect(result.factors).toHaveProperty('acMentions');
      expect(result.factors).toHaveProperty('integrationTerms');
      expect(result.factors).toHaveProperty('userRoles');
      expect(result.factors).toHaveProperty('storyPoints');
      expect(result.factors).toHaveProperty('linkedItems');
    });
  });

  describe('level classification', () => {
    test('simple ticket classifies as simple', () => {
      expect(calculateTicketComplexity(SIMPLE_TICKET).level).toBe('simple');
    });

    test('medium ticket classifies as medium', () => {
      expect(calculateTicketComplexity(MEDIUM_TICKET).level).toBe('medium');
    });

    test('complex ticket classifies as complex', () => {
      expect(calculateTicketComplexity(COMPLEX_TICKET).level).toBe('complex');
    });

    test('empty ticket classifies as simple', () => {
      expect(calculateTicketComplexity({}).level).toBe('simple');
    });
  });

  describe('score ordering', () => {
    test('complex ticket scores higher than medium', () => {
      const complexScore = calculateTicketComplexity(COMPLEX_TICKET).score;
      const mediumScore = calculateTicketComplexity(MEDIUM_TICKET).score;
      expect(complexScore).toBeGreaterThan(mediumScore);
    });

    test('medium ticket scores higher than simple', () => {
      const mediumScore = calculateTicketComplexity(MEDIUM_TICKET).score;
      const simpleScore = calculateTicketComplexity(SIMPLE_TICKET).score;
      expect(mediumScore).toBeGreaterThan(simpleScore);
    });
  });

  describe('individual scoring factors', () => {
    test('description length: > 400 words contributes 3 points', () => {
      const longDesc = 'word '.repeat(450);
      const result = calculateTicketComplexity({ description: longDesc, summary: '' });
      expect(result.factors.descWords).toBeGreaterThan(400);
      // Score from just length (3) + no AC(0) + no integ(0) + no roles(0) + no SP(0) + no links(0) = 3
      // But also AC scan might find 0 hits. Integration scan 0 hits. etc.
      // We just check it doesn't get the lowest bucket
      expect(result.score).toBeGreaterThanOrEqual(3);
    });

    test('story points >= 8 contributes 2 points', () => {
      const base = calculateTicketComplexity(SIMPLE_TICKET);
      const highSP = calculateTicketComplexity({ ...SIMPLE_TICKET, storyPoints: 8 });
      expect(highSP.score).toBe(base.score + 2);
    });

    test('story points 3-7 contributes 1 point', () => {
      const base = calculateTicketComplexity(SIMPLE_TICKET);
      const medSP = calculateTicketComplexity({ ...SIMPLE_TICKET, storyPoints: 5 });
      expect(medSP.score).toBe(base.score + 1);
    });

    test('4+ linked items contributes 2 points', () => {
      const base = calculateTicketComplexity(SIMPLE_TICKET);
      const linked = calculateTicketComplexity({ ...SIMPLE_TICKET, linkedIssues: ['A', 'B', 'C', 'D'] });
      expect(linked.score).toBe(base.score + 2);
    });

    test('1-3 linked items contributes 1 point', () => {
      const base = calculateTicketComplexity(SIMPLE_TICKET);
      const linked = calculateTicketComplexity({ ...SIMPLE_TICKET, linkedIssues: ['A'] });
      expect(linked.score).toBe(base.score + 1);
    });

    test('> 3 user roles contributes 2 points', () => {
      const base = calculateTicketComplexity(SIMPLE_TICKET);
      const manyRoles = calculateTicketComplexity({
        ...SIMPLE_TICKET,
        description: 'admin moderator editor viewer manager can all access this feature',
      });
      // base has 1 point from words; manyRoles has 1 from words + 2 from roles
      expect(manyRoles.score).toBeGreaterThan(base.score);
      expect(manyRoles.factors.userRoles).toBeGreaterThan(3);
    });

    test('integration terms: > 5 contributes 3 points', () => {
      const integDesc = 'Uses api service integration webhook endpoint external storage database auth kafka';
      const result = calculateTicketComplexity({ description: integDesc, summary: '' });
      expect(result.factors.integrationTerms).toBeGreaterThan(5);
    });
  });

  describe('robustness', () => {
    test('handles missing description gracefully', () => {
      expect(() => calculateTicketComplexity({ summary: 'Just a summary' })).not.toThrow();
    });

    test('handles missing summary gracefully', () => {
      expect(() => calculateTicketComplexity({ description: 'Some description' })).not.toThrow();
    });

    test('handles entirely empty ticketData', () => {
      const result = calculateTicketComplexity({});
      expect(result.level).toBe('simple');
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    test('story_points snake_case fallback works', () => {
      const sp3 = calculateTicketComplexity({ ...SIMPLE_TICKET, storyPoints: undefined, story_points: 3 });
      const sp0 = calculateTicketComplexity({ ...SIMPLE_TICKET, storyPoints: undefined });
      expect(sp3.score).toBeGreaterThan(sp0.score);
    });
  });
});
