'use strict';

const express    = require('express');
const { auth }   = require('express-oauth2-jwt-bearer');
const { MongoClient } = require('mongodb');
const { randomUUID }  = require('crypto');
const { runImplementationAgent } = require('./agent');

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
      hasApiKey:      !!(doc?.anthropicApiKey),
      hasGithubToken: !!(doc?.githubToken),
      githubOwner:    doc?.githubOwner || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save Anthropic API key
app.put('/api/user/profile', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const { anthropicApiKey } = req.body;
    if (!anthropicApiKey || !anthropicApiKey.startsWith('sk-')) {
      return res.status(400).json({ error: 'Invalid API key format' });
    }
    await db.collection('users').updateOne(
      { userId },
      { $set: { anthropicApiKey, updatedAt: new Date() } },
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

// ── Anthropic proxy ───────────────────────────────────────────────────────────
app.post('/api/messages', checkJwt, async (req, res) => {
  try {
    const userId  = req.auth.payload.sub;
    const userDoc = await db.collection('users').findOne({ userId });
    const apiKey  = userDoc?.anthropicApiKey;
    if (!apiKey) {
      return res.status(402).json({ error: 'No Anthropic API key configured. Please add your key in settings.' });
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
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
    const data = await ghRes.json();
    res.status(ghRes.status).json(data);
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
app.post('/api/github/push', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const { repoName, files = [] } = req.body;
    if (!repoName) return res.status(400).json({ error: 'repoName is required' });

    const creds = await getGithubCreds(userId);
    if (!creds) return res.status(400).json({ error: 'GitHub not configured' });

    const { results, errors } = await pushFilesToGitHub(creds, repoName, files);
    res.json({ ok: errors.length === 0, results, errors });
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
    const { repoName, ecosystem } = req.body;
    if (!repoName)                   return res.status(400).json({ error: 'repoName is required' });
    if (!ecosystem?.services?.length) return res.status(400).json({ error: 'No ecosystem defined' });

    const creds = await getGithubCreds(userId);
    if (!creds) return res.status(400).json({ error: 'GitHub not configured' });

    const userDoc = await db.collection('users').findOne({ userId });
    const apiKey  = userDoc?.anthropicApiKey;
    if (!apiKey) return res.status(400).json({ error: 'No Anthropic API key configured' });

    const jobId = randomUUID();
    implJobs.set(jobId, { userId, repoName, status: 'running', events: [], createdAt: new Date() });
    res.json({ jobId });

    // ── Fire-and-forget agent run ─────────────────────────────────────────────
    const appendEvent = event => {
      const job = implJobs.get(jobId);
      if (job) job.events.push(event);
    };
    const isCancelled = async () => implJobs.get(jobId)?.status === 'cancelled';

    runImplementationAgent(ecosystem, apiKey, appendEvent, null, isCancelled)
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
