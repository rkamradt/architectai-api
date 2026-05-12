'use strict';

const express    = require('express');
const { auth }   = require('express-oauth2-jwt-bearer');
const { MongoClient } = require('mongodb');
const { randomUUID }  = require('crypto');
const { runImplementationAgent } = require('./agent');

// ── Default model ─────────────────────────────────────────────────────────────
const DEFAULT_MODEL  = 'claude-sonnet-4-6';
const MAX_TOKENS     = 2048;

// ── Chat helpers ──────────────────────────────────────────────────────────────

function buildPrompt(services) {
  return `You are ArchitectAI — a senior software architect specializing in microservices, event-driven systems, and distributed architecture.

Your expertise includes: service decomposition and bounded contexts (DDD), REST/gRPC/GraphQL API design, event-driven patterns (Kafka, CQRS, event sourcing, Saga), resilience patterns (circuit breaker, bulkhead, retry with backoff), service mesh, distributed tracing, data ownership and consistency boundaries, Kubernetes, AWS, and GitOps/ArgoCD deployment.

Current ecosystem state:
${services.length === 0
  ? '(empty — no services defined yet)'
  : JSON.stringify(services, null, 2)}

When the user has agreed to add or update a service, emit EXACTLY this JSON block — no prose inside the tags:
<ecosystem_update>
{"action":"add","service":{"id":"kebab-case-id","name":"ServiceName","purpose":"One sentence: what this service owns and is responsible for","tech":"Spring Boot","archetype":"http","apis":[{"method":"POST","path":"/path","description":"what this endpoint does"}],"events":[{"direction":"produces","topic":"domain.event.name","description":"what payload this carries"}],"dependencies":["other-service-id"]}}
</ecosystem_update>

Emit ecosystem_update ONLY when formalizing agreed services — not speculatively during discussion.
Use "action": "add", "update", or "remove" as appropriate.

## Service archetypes

Every service must have one of these archetypes — choose the one that best describes its primary role:

- **http** — Standard REST/gRPC service with its own API surface and data store. No naming suffix required.
- **messaging** — Primarily event-driven; publishes and/or subscribes to topics. No naming suffix required.
- **provider** — Wraps a third-party or external API, exposing it to the ecosystem. The service id MUST end in \`-provider\` and the name MUST end in \`Provider\`. Include a \`foreignApi\` block: \`{"name":"...","baseUrl":"...","authMethod":"apiKey|oauth2|basic","generateMock":true}\`.
- **adaptor** — Bridges a foreign protocol or data format into the ecosystem. The service id MUST end in \`-adaptor\` and the name MUST end in \`Adaptor\`. Include an \`accepts\` block: \`{"protocol":"...","format":"...","foreignEntity":"...","generateMock":true,"mockBehavior":"..."}\`.

Provider example:
<ecosystem_update>
{"action":"add","service":{"id":"stripe-provider","name":"StripeProvider","purpose":"Wraps the Stripe payments API, exposing charge and refund operations to the ecosystem","tech":"Node.js/Express","archetype":"provider","foreignApi":{"name":"Stripe","baseUrl":"https://api.stripe.com","authMethod":"apiKey","generateMock":true},"apis":[{"method":"POST","path":"/charges","description":"Create a charge via Stripe"}],"events":[{"direction":"produces","topic":"payment.charged","description":"Emitted when a charge succeeds"}],"dependencies":[]}}
</ecosystem_update>

Adaptor example:
<ecosystem_update>
{"action":"add","service":{"id":"sftp-adaptor","name":"SftpAdaptor","purpose":"Polls an SFTP server for CSV files and emits structured events","tech":"Node.js/Express","archetype":"adaptor","accepts":{"protocol":"SFTP","format":"CSV","foreignEntity":"OrderExport","generateMock":true,"mockBehavior":"Emit one order.received event per CSV row"},"apis":[],"events":[{"direction":"produces","topic":"order.received","description":"Emitted for each row in an ingested CSV file"}],"dependencies":[]}}
</ecosystem_update>

Architectural principles to uphold:
- Single responsibility: each service owns one bounded context
- No shared databases between services
- Flag circular dependencies, chatty inter-service calls, data ownership violations
- Prefer async event-driven communication for cross-domain concerns
- Recommend specific patterns, not "it depends" hedging
- Call out when a proposed service is too broad or could be split`;
}

function parseUpdates(text) {
  const out = [];
  const re  = /<ecosystem_update>([\s\S]*?)<\/ecosystem_update>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try { out.push(JSON.parse(m[1].trim())); } catch {}
  }
  return out;
}

function stripTags(text) {
  return text.replace(/<ecosystem_update>[\s\S]*?<\/ecosystem_update>/g, '').trim();
}

function applyUpdates(services, updates) {
  let next = [...services];
  for (const u of updates) {
    if (!u.service) continue;
    const idx = next.findIndex(s => s.id === u.service.id);
    if (u.action === 'remove') {
      next = next.filter(s => s.id !== u.service.id);
    } else {
      if (idx >= 0) next[idx] = u.service;
      else next.push(u.service);
    }
  }
  return next;
}

// ── Ecosystem file generators ─────────────────────────────────────────────────
// Ported from the frontend so the backend owns file format knowledge.

function genEcosystemJson(services, projectName) {
  return JSON.stringify({ project: projectName, generated: new Date().toISOString(), services }, null, 2);
}

function genSpecMd(services, projectName) {
  const date = new Date().toISOString().slice(0, 10);
  const hash = Buffer.from(JSON.stringify(services)).toString('base64').slice(0, 12);

  const serviceBlocks = services.map(s => {
    const apiTable = s.apis?.length
      ? `| Method | Path | Description |\n|--------|------|-------------|\n` +
        s.apis.map(a => `| \`${a.method}\` | \`${a.path}\` | ${a.description} |`).join('\n')
      : '_No API endpoints defined._';
    const eventTable = s.events?.length
      ? `| Direction | Topic | Description |\n|-----------|-------|-------------|\n` +
        s.events.map(e => `| ${e.direction === 'produces' ? '**Produces**' : '**Consumes**'} | \`${e.topic}\` | ${e.description} |`).join('\n')
      : '_No event contracts defined._';
    const depTable = s.dependencies?.length
      ? `| Service |\n|---------|\n` + s.dependencies.map(d => `| \`${d}\` |`).join('\n')
      : '_No dependencies._';
    const archetypeSection = s.archetype && s.archetype !== 'http'
      ? `\n**Archetype:** ${s.archetype}` +
        (s.archetype === 'provider' && s.foreignApi
          ? `\n**Foreign API:** ${s.foreignApi.name || ''} — ${s.foreignApi.baseUrl || ''} (auth: ${s.foreignApi.authMethod || '?'})`
          : '') +
        (s.archetype === 'adaptor' && s.accepts
          ? `\n**Accepts:** ${s.accepts.protocol || ''}/${s.accepts.format || ''} — ${s.accepts.foreignEntity || ''}`
          : '')
      : '';
    return `<!-- service-start: ${s.id} -->\n## Service: ${s.name}\n\n**ID:** \`${s.id}\`\n**Tech:** ${s.tech || 'TBD'}\n**Purpose:** ${s.purpose}${archetypeSection}\n\n### API Surface\n\n${apiTable}\n\n### Event Contracts\n\n${eventTable}\n\n### Service Dependencies\n\n${depTable}\n\n### Data Ownership\n\nThis service is the sole owner of its data store. No other service may read or write its database directly.\n\n### Implementation Notes\n\n_Add service-specific constraints, patterns, and architectural decisions here._\n\n<!-- service-end: ${s.id} -->`;
  }).join('\n\n---\n\n');

  return `# ${projectName} — System Specification
<!-- spec-version: 1.0.0 -->
<!-- generated: ${date} -->
<!-- ecosystem-hash: ${hash} -->

## System Overview

**${projectName}** is a platform consisting of ${services.length} microservice${services.length !== 1 ? 's' : ''}.

### Services at a glance

${services.map(s => `- **${s.name}** (\`${s.id}\`) — ${s.purpose}`).join('\n') || '_No services defined yet._'}

---

${serviceBlocks}

---

## Changelog

| Date | Change | Author |
|------|--------|--------|
| ${date} | Initial specification generated by ArchitectAI | ArchitectAI |
`;
}

function genSpineClaudeMd(services, projectName) {
  const svcList = services.map(s => `- **${s.name}** (\`${s.id}\`) — ${s.purpose}`).join('\n');
  return `# ${projectName} — Platform Architecture Context

## Authoritative files
- @spec.md — human-readable living specification
- @ecosystem.json — machine-readable service registry

## Services in this platform
${svcList || '(none yet)'}

## Architecture principles
- Each service owns exactly one bounded context — no shared databases
- Cross-domain communication via Kafka events; same-domain via direct API calls
- spec.md is the contract — code must match spec, not the other way around
`;
}

function genServiceClaudeMd(svc, projectName) {
  const apis   = svc.apis?.map(a => `- \`${a.method} ${a.path}\` — ${a.description}`).join('\n') || '(none)';
  const events = svc.events?.map(e => `- ${e.direction === 'produces' ? '▶ Produces' : '◀ Consumes'} \`${e.topic}\` — ${e.description}`).join('\n') || '(none)';
  const deps   = svc.dependencies?.length ? svc.dependencies.map(d => `- \`${d}\``).join('\n') : '(none)';
  const arch   = svc.archetype || 'http';
  const archetypeBlock = arch === 'provider' && svc.foreignApi
    ? `\n## Foreign API (${svc.foreignApi.name || 'external'})\n- Base URL: \`${svc.foreignApi.baseUrl || 'TBD'}\`\n- Auth method: ${svc.foreignApi.authMethod || 'TBD'}\n`
    : arch === 'adaptor' && svc.accepts
    ? `\n## Accepts (foreign input)\n- Protocol: ${svc.accepts.protocol || 'TBD'}\n- Format: ${svc.accepts.format || 'TBD'}\n- Foreign entity: ${svc.accepts.foreignEntity || 'TBD'}\n`
    : '';
  return `# ${svc.name}\nPart of the **${projectName}** ecosystem.\nArchetype: **${arch}**\n\n## This service owns\n${svc.purpose}\n\n## Tech stack\n${svc.tech || 'TBD'}\n${archetypeBlock}\n## API contracts\n${apis}\n\n## Event contracts\n${events}\n\n## Service dependencies\n${deps}\n`;
}

function toRepoName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-services';
}

function buildPushFiles(ecosystem) {
  const { projectName, services } = ecosystem;
  const files = [
    { path: 'ecosystem.json', content: genEcosystemJson(services, projectName) },
    { path: 'spec.md',        content: genSpecMd(services, projectName) },
    { path: 'CLAUDE.md',      content: genSpineClaudeMd(services, projectName) },
    ...services.map(s => ({ path: `${s.id}/CLAUDE.md`, content: genServiceClaudeMd(s, projectName) })),
  ];
  return files;
}

const app = express();
app.use(express.json({ limit: '4mb' }));

// ── Disable caching for all API routes ────────────────────────────────────────
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ── Request logging ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms     = Date.now() - start;
    const userId = req.auth?.payload?.sub ?? '-';
    console.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms user=${userId}`);
  });
  next();
});

// ── Auth0 JWT middleware ──────────────────────────────────────────────────────
const checkJwt = auth({
  audience:      process.env.AUTH0_AUDIENCE,
  issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
});

// ── MongoDB — users collection only ──────────────────────────────────────────
// Schema: { userId, anthropicApiKey, githubToken, githubOwner, updatedAt }
let db;
MongoClient.connect(process.env.MONGODB_URI)
  .then(client => {
    db = client.db('architectai');
    console.log('MongoDB connected');
    db.collection('users').createIndex({ userId: 1 }, { unique: true }).catch(() => {});
    db.collection('ecosystems').createIndex({ userId: 1 }, { unique: true }).catch(() => {});
  })
  .catch(err => { console.error('MongoDB connection failed:', err); process.exit(1); });

// ── In-memory impl jobs ───────────────────────────────────────────────────────
// Ephemeral — lost on restart, which is acceptable for minute-long jobs.
// { userId, repoName, status, events[], createdAt }
const implJobs = new Map();

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── User profile ──────────────────────────────────────────────────────────────
app.get('/api/user/profile', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const doc = await db.collection('users').findOne({ userId });
    res.json({
      hasApiKey:       !!(doc?.anthropicApiKey),
      hasGithubToken:  !!(doc?.githubToken),
      githubOwner:     doc?.githubOwner || '',
      anthropicModel:  doc?.anthropicModel || DEFAULT_MODEL,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save Anthropic API key and/or model
app.put('/api/user/profile', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const { anthropicApiKey, anthropicModel } = req.body;
    const update = { updatedAt: new Date() };
    if (anthropicApiKey !== undefined) {
      if (!anthropicApiKey || !anthropicApiKey.startsWith('sk-')) {
        return res.status(400).json({ error: 'Invalid API key format' });
      }
      update.anthropicApiKey = anthropicApiKey;
    }
    if (anthropicModel !== undefined) {
      update.anthropicModel = anthropicModel;
    }
    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    await db.collection('users').updateOne(
      { userId },
      { $set: update },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save GitHub token + owner
app.put('/api/user/github', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const { githubToken, githubOwner } = req.body;
    const update = { updatedAt: new Date() };
    // Only overwrite token if a non-masked value is provided
    if (githubToken && githubToken !== '••••••••') update.githubToken = githubToken;
    if (githubOwner !== undefined) update.githubOwner = githubOwner;
    await db.collection('users').updateOne(
      { userId },
      { $set: update },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Anthropic chat ────────────────────────────────────────────────────────────
// Receives: { messages: apiHistory }
// Returns:  { content: displayText, updates: [{ action, service }] }
app.post('/api/messages', checkJwt, async (req, res) => {
  try {
    const userId  = req.auth.payload.sub;
    const [userDoc, ecosystemDoc] = await Promise.all([
      db.collection('users').findOne({ userId }),
      db.collection('ecosystems').findOne({ userId }),
    ]);

    const apiKey = userDoc?.anthropicApiKey;
    if (!apiKey) {
      return res.status(402).json({ error: 'No Anthropic API key configured. Please add your key in settings.' });
    }

    const model    = userDoc?.anthropicModel || DEFAULT_MODEL;
    const services = ecosystemDoc?.services  || [];
    const { messages } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system:     buildPrompt(services),
        messages,
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    const raw     = data.content?.map(b => b.text || '').join('') || '';
    const updates = parseUpdates(raw);
    const content = stripTags(raw);

    // Apply any service updates to the stored ecosystem
    if (updates.length) {
      const updatedServices = applyUpdates(services, updates);
      await db.collection('ecosystems').updateOne(
        { userId },
        { $set: { services: updatedServices, updatedAt: new Date() } },
        { upsert: true }
      );
    }

    res.json({ content, updates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ecosystem scratch-pad ─────────────────────────────────────────────────────
// Schema: { userId, projectName, services, repoName, updatedAt }
// This is the in-progress working state — persisted so sessions can resume
// from any device. GitHub is still the canonical published store.

app.get('/api/ecosystem', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const doc = await db.collection('ecosystems').findOne({ userId });
    res.json({
      projectName: doc?.projectName || '',
      services:    doc?.services    || [],
      repoName:    doc?.repoName    || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/ecosystem', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const { projectName = '', services = [], repoName = '' } = req.body;
    await db.collection('ecosystems').updateOne(
      { userId },
      { $set: { projectName, services, repoName, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GitHub helpers ────────────────────────────────────────────────────────────
async function getGithubCreds(userId) {
  const doc = await db.collection('users').findOne({ userId });
  if (!doc?.githubToken || !doc?.githubOwner) return null;
  return { token: doc.githubToken, owner: doc.githubOwner };
}

// ── GitHub pull (fetch ecosystem.json from a repo) ────────────────────────────
app.post('/api/github/pull', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const { repoName } = req.body;
    if (!repoName) return res.status(400).json({ error: 'repoName is required' });

    const creds = await getGithubCreds(userId);
    if (!creds) return res.status(400).json({ error: 'GitHub not configured' });

    const url = `https://api.github.com/repos/${creds.owner}/${repoName}/contents/ecosystem.json?ref=main&t=${Date.now()}`;
    const ghRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    if (!ghRes.ok) {
      const e = await ghRes.json().catch(() => ({}));
      return res.status(ghRes.status).json({ error: e.message || `GitHub ${ghRes.status}` });
    }
    const { content } = await ghRes.json();
    if (!content) return res.status(404).json({ error: 'ecosystem.json not found in that repo' });

    const text       = Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf-8');
    const parsed     = JSON.parse(text);
    const projectName = parsed.project  || '';
    const services    = parsed.services || [];

    // Persist to the scratch-pad so the session can resume from any device
    await db.collection('ecosystems').updateOne(
      { userId },
      { $set: { projectName, services, repoName, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ projectName, services, repoName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GitHub push helper ────────────────────────────────────────────────────────
async function pushFilesToGitHub(creds, repoName, files) {
  const ghHeaders = {
    Authorization: `Bearer ${creds.token}`,
    Accept:        'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
  const results = [];
  const errors  = [];

  for (const file of files) {
    const url = `https://api.github.com/repos/${creds.owner}/${repoName}/contents/${file.path}`;
    try {
      let sha;
      const getRes = await fetch(`${url}?ref=main`, { headers: ghHeaders });
      if (getRes.ok) {
        sha = (await getRes.json()).sha;
      } else if (getRes.status !== 404) {
        const e = await getRes.json();
        throw new Error(e.message || `GitHub ${getRes.status} reading ${file.path}`);
      }
      const body = {
        message: `chore: update ${file.path.split('/').pop()} via ArchitectAI [${new Date().toISOString().slice(0, 10)}]`,
        content: Buffer.from(file.content, 'utf-8').toString('base64'),
        branch:  'main',
        ...(sha ? { sha } : {}),
      };
      const putRes = await fetch(url, { method: 'PUT', headers: ghHeaders, body: JSON.stringify(body) });
      const data   = await putRes.json();
      if (!putRes.ok) {
        const isWorkflow = file.path.startsWith('.github/workflows/');
        const msg = (isWorkflow && putRes.status === 404)
          ? `Not Found — your PAT requires the 'workflow' scope to push GitHub Actions files. Regenerate your token with 'workflow' checked.`
          : (data.message || `GitHub ${putRes.status} on ${file.path}`);
        throw new Error(msg);
      }
      results.push({ path: file.path, sha: data.content?.sha });
    } catch (err) {
      errors.push({ path: file.path, error: err.message });
    }
  }
  return { results, errors };
}

// ── GitHub push ───────────────────────────────────────────────────────────────
// Reads the ecosystem from the DB scratch-pad — no body needed.
app.post('/api/github/push', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;

    const creds = await getGithubCreds(userId);
    if (!creds) return res.status(400).json({ error: 'GitHub not configured' });

    const ecosystemDoc = await db.collection('ecosystems').findOne({ userId });
    if (!ecosystemDoc?.repoName) return res.status(400).json({ error: 'No repo set — load an ecosystem or run implement first' });
    if (!ecosystemDoc?.services?.length) return res.status(400).json({ error: 'No services defined yet' });

    const files = buildPushFiles(ecosystemDoc);
    const { results, errors } = await pushFilesToGitHub(creds, ecosystemDoc.repoName, files);
    res.json({ ok: errors.length === 0, repoName: ecosystemDoc.repoName, results, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GitHub create repo ────────────────────────────────────────────────────────
app.post('/api/github/create-repo', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const creds = await getGithubCreds(userId);
    if (!creds) return res.status(400).json({ error: 'GitHub not configured' });

    const { repoName, description = '', private: isPrivate = false } = req.body;
    if (!repoName) return res.status(400).json({ error: 'repoName is required' });

    const ghRes = await fetch('https://api.github.com/user/repos', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${creds.token}`,
        Accept:         'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: repoName, description, private: isPrivate, auto_init: true }),
    });
    const data = await ghRes.json();
    if (ghRes.status === 422) return res.status(422).json({ error: `Repository "${repoName}" already exists` });
    if (!ghRes.ok)           return res.status(ghRes.status).json({ error: data.message || `GitHub error ${ghRes.status}` });
    res.json({ ok: true, repoUrl: data.html_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GitHub Actions status ─────────────────────────────────────────────────────
app.get('/api/github/actions-status', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const { repoName } = req.query;
    if (!repoName) return res.status(400).json({ error: 'repoName is required' });

    const creds = await getGithubCreds(userId);
    if (!creds) return res.status(400).json({ error: 'GitHub not configured' });

    const url = `https://api.github.com/repos/${creds.owner}/${repoName}/actions/runs?branch=main&per_page=100`;
    const ghRes = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.token}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!ghRes.ok) {
      const e = await ghRes.json().catch(() => ({}));
      return res.status(ghRes.status).json({ error: e.message || `GitHub ${ghRes.status}` });
    }

    const { workflow_runs: runs = [] } = await ghRes.json();
    const statuses = {};
    for (const run of runs) {
      const match = run.path?.match(/^\.github\/workflows\/(.+)\.yml$/);
      if (!match) continue;
      const serviceId = match[1];
      if (statuses[serviceId]) continue;
      statuses[serviceId] = {
        status:     run.status === 'completed' ? (run.conclusion === 'success' ? 'built' : 'build_failed') : 'building',
        conclusion: run.conclusion,
        url:        run.html_url,
        runId:      run.id,
        createdAt:  run.created_at,
      };
    }
    res.json({ statuses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Implement ecosystem via agent (polling) ───────────────────────────────────
//
//   POST /api/implement/start  { repoName, ecosystem }  → { jobId }
//   GET  /api/implement/:jobId/poll?since=N              → { status, events, total }
//   POST /api/implement/:jobId/cancel                    → { ok }
//
// Jobs are held in-memory (implJobs Map). Ephemeral by design.

app.post('/api/implement/start', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;

    const creds = await getGithubCreds(userId);
    if (!creds) return res.status(400).json({ error: 'GitHub not configured' });

    const ecosystem = await db.collection('ecosystems').findOne({ userId });
    if (!ecosystem?.repoName)          return res.status(400).json({ error: 'No repo set — create or load an ecosystem first' });
    if (!ecosystem?.services?.length)  return res.status(400).json({ error: 'No services defined' });
    const { repoName } = ecosystem;

    const userDoc = await db.collection('users').findOne({ userId });
    const apiKey  = userDoc?.anthropicApiKey;
    if (!apiKey) return res.status(400).json({ error: 'No Anthropic API key configured' });
    const sonnetModel = userDoc?.anthropicModel || DEFAULT_MODEL;

    const jobId = randomUUID();
    implJobs.set(jobId, { userId, repoName, status: 'running', events: [], createdAt: new Date() });
    res.json({ jobId });

    // ── Fire-and-forget agent run ─────────────────────────────────────────────
    const appendEvent = event => {
      const job = implJobs.get(jobId);
      if (job) job.events.push(event);
    };
    const isCancelled = async () => implJobs.get(jobId)?.status === 'cancelled';

    runImplementationAgent(ecosystem, apiKey, appendEvent, null, isCancelled, sonnetModel)
      .then(async workspace => {
        if (implJobs.get(jobId)?.status === 'cancelled') return;
        appendEvent({ type: 'push', message: `Pushing ${Object.keys(workspace).length} files to ${repoName}` });
        const files = Object.entries(workspace).map(([path, content]) => ({ path, content }));
        const { results, errors } = await pushFilesToGitHub(creds, repoName, files);
        if (errors.length) {
          console.error(`[push] ${errors.length} error(s) pushing to ${repoName}:`);
          errors.forEach(e => console.error(`  FAILED ${e.path}: ${e.error}`));
        }
        appendEvent({ type: 'done', message: 'Complete', repoUrl: `https://github.com/${creds.owner}/${repoName}`, pushed: results.length, errors });
        const job = implJobs.get(jobId);
        if (job) job.status = 'done';
      })
      .catch(err => {
        appendEvent({ type: 'error', message: err.message });
        const job = implJobs.get(jobId);
        if (job) job.status = 'error';
      });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/implement/:jobId/cancel', checkJwt, (req, res) => {
  const userId = req.auth.payload.sub;
  const { jobId } = req.params;
  const job = implJobs.get(jobId);
  if (job && job.userId === userId && job.status === 'running') {
    job.status = 'cancelled';
    res.json({ ok: true });
  } else {
    res.json({ ok: false });
  }
});

app.get('/api/implement/:jobId/poll', checkJwt, (req, res) => {
  const userId = req.auth.payload.sub;
  const { jobId } = req.params;
  const since = Math.max(0, parseInt(req.query.since || '0', 10));
  const job = implJobs.get(jobId);
  if (!job || job.userId !== userId) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, events: job.events.slice(since), total: job.events.length });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`architectai-api listening on ${PORT}`));
