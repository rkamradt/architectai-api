/**
 * Standalone test for agent.js
 *
 * Runs the implementation agent against a hardcoded ContactFlow spec
 * and writes the resulting workspace files to ./test-output/.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node test-agent.js
 *   node -r dotenv/config test-agent.js   (if using .env.local)
 */

const fs = require('fs');
const path = require('path');
const { runImplementationAgent } = require('./agent');

// ── Hardcoded test spec ───────────────────────────────────────────────────────

const spec = {
  projectName: 'ContactFlow',
  services: [
    {
      id: 'contacts-service',
      name: 'ContactsService',
      purpose: 'Manages contact records — people, their personal and professional details, and contact information',
      tech: 'Node.js/Express',
      apis: [
        { method: 'GET',    path: '/contacts',     description: 'List all contacts with optional search/filter' },
        { method: 'POST',   path: '/contacts',     description: 'Create a new contact' },
        { method: 'GET',    path: '/contacts/:id', description: 'Get a contact by ID' },
        { method: 'PUT',    path: '/contacts/:id', description: 'Update a contact' },
        { method: 'DELETE', path: '/contacts/:id', description: 'Delete a contact' },
      ],
      events: [
        { direction: 'produces', topic: 'contact.created', description: 'Emitted when a new contact is created, includes full contact payload' },
        { direction: 'produces', topic: 'contact.updated', description: 'Emitted when a contact record is changed' },
        { direction: 'produces', topic: 'contact.deleted', description: 'Emitted when a contact is removed' },
      ],
      dependencies: [],
    },
    {
      id: 'accounts-service',
      name: 'AccountsService',
      purpose: 'Manages company and organisation accounts that contacts belong to',
      tech: 'Node.js/Express',
      apis: [
        { method: 'GET',  path: '/accounts',              description: 'List all accounts' },
        { method: 'POST', path: '/accounts',              description: 'Create a new account' },
        { method: 'GET',  path: '/accounts/:id',          description: 'Get an account by ID' },
        { method: 'PUT',  path: '/accounts/:id',          description: 'Update an account' },
        { method: 'GET',  path: '/accounts/:id/contacts', description: 'List all contacts associated with an account' },
        { method: 'POST', path: '/accounts/:id/contacts', description: 'Associate a contact with an account' },
      ],
      events: [
        { direction: 'consumes', topic: 'contact.created', description: 'Optionally auto-links new contacts to accounts based on email domain' },
        { direction: 'produces', topic: 'account.created', description: 'Emitted when a new account is created' },
      ],
      dependencies: ['contacts-service'],
    },
    {
      id: 'activities-service',
      name: 'ActivitiesService',
      purpose: 'Tracks interactions and activities (calls, emails, meetings, notes) associated with contacts and accounts',
      tech: 'Node.js/Express',
      apis: [
        { method: 'GET',  path: '/activities',                       description: 'List all activities with optional filtering by type or date range' },
        { method: 'POST', path: '/activities',                       description: 'Log a new activity' },
        { method: 'GET',  path: '/activities/:id',                   description: 'Get an activity by ID' },
        { method: 'PUT',  path: '/activities/:id',                   description: 'Update an activity record' },
        { method: 'GET',  path: '/contacts/:contactId/activities',   description: 'List all activities for a specific contact' },
        { method: 'GET',  path: '/accounts/:accountId/activities',   description: 'List all activities for a specific account' },
      ],
      events: [
        { direction: 'produces', topic: 'activity.logged',    description: 'Emitted when a new activity is recorded, includes type and participants' },
        { direction: 'consumes', topic: 'contact.created',    description: 'Initialises an empty activity log for new contacts' },
        { direction: 'consumes', topic: 'account.created',    description: 'Initialises an empty activity log for new accounts' },
      ],
      dependencies: ['contacts-service', 'accounts-service'],
    },
  ],
};

// ── Output helpers ────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(__dirname, 'test-output');


// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is not set.');
    console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... node test-agent.js');
    process.exit(1);
  }

  // Clean output dir
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true });
  }
  fs.mkdirSync(OUTPUT_DIR);

  console.log(`\nRunning ArchitectAI implementation agent`);
  console.log(`Project: ${spec.projectName}`);
  console.log(`Services: ${spec.services.map(s => s.id).join(', ')}`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  const start = Date.now();

  try {
    let fileCount = 0;
    const workspace = await runImplementationAgent(spec, apiKey, ({ type, message, service }) => {
      const ts      = new Date().toISOString().slice(11, 19);
      const svcTag  = service ? `[${service}]` : '';
      if (type === 'service') {
        process.stdout.write(`\n[${ts}] ── ${message} ──\n`);
      } else if (type === 'thinking') {
        process.stdout.write(`[${ts}] ${svcTag} ⟳  ${message}\n`);
      } else if (type === 'file') {
        fileCount++;
        process.stdout.write(`[${ts}] ${svcTag} ✎  ${message}\n`);
      }
    }, OUTPUT_DIR);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`\n✓ Done in ${elapsed}s — wrote ${fileCount} files to ${OUTPUT_DIR}/`);
    console.log('\nFiles written:');
    Object.keys(workspace).sort().forEach(f => {
      const size = Buffer.byteLength(workspace[f], 'utf-8');
      console.log(`  ${f.padEnd(60)} ${size} bytes`);
    });
  } catch (err) {
    console.error(`\n✗ Agent failed: ${err.message}`);
    process.exit(1);
  }
}

main();
