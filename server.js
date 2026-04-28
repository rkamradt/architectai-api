const express = require('express');
const { auth } = require('express-oauth2-jwt-bearer');
const { MongoClient, ObjectId } = require('mongodb');
const { runImplementationAgent } = require('./agent');

const app = express();
app.use(express.json({ limit: '4mb' }));

// ── Auth0 JWT middleware ───────────────────────────────────────────────────────
const checkJwt = auth({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
});

// ── MongoDB ───────────────────────────────────────────────────────────────────
let db;
MongoClient.connect(process.env.MONGODB_URI)
  .then(client => {
    db = client.db('architectai');
    console.log('MongoDB connected');
    db.collection('ecosystems').createIndex({ userId: 1 }, { unique: true }).catch(() => {});
    db.collection('github_configs').createIndex({ userId: 1 }, { unique: true }).catch(() => {});
    db.collection('users').createIndex({ userId: 1 }, { unique: true }).catch(() => {});
  })
  .catch(err => { console.error('MongoDB connection failed:', err); process.exit(1); });

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── User profile (API key management) ────────────────────────────────────────
app.get('/api/user/profile', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const doc = await db.collection('users').findOne({ userId });
    res.json({ hasApiKey: !!(doc?.anthropicApiKey) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// ── Anthropic proxy ───────────────────────────────────────────────────────────
// Key is stored per-user in MongoDB — never in env or exposed to browser.
app.post('/api/messages', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const userDoc = await db.collection('users').findOne({ userId });
    const apiKey = userDoc?.anthropicApiKey;
    if (!apiKey) {
      return res.status(402).json({ error: 'No Anthropic API key configured. Please add your key in settings.' });
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
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

// ── Ecosystem CRUD (per Auth0 user) ───────────────────────────────────────────
app.get('/api/ecosystem', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const doc = await db.collection('ecosystems').findOne({ userId });
    res.json(doc ? { projectName: doc.projectName, services: doc.services } : { projectName: 'New Ecosystem', services: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/ecosystem', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const { projectName, services } = req.body;
    await db.collection('ecosystems').updateOne(
      { userId },
      { $set: { projectName, services, userId, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GitHub config (stored per user, PAT kept server-side) ─────────────────────
app.get('/api/github/config', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const doc = await db.collection('github_configs').findOne({ userId });
    if (!doc) return res.json({});
    // Return config but mask the token for display
    const { token, ...rest } = doc.config || {};
    res.json({ ...rest, token: token ? '••••••••' : '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/github/config', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const incoming = req.body;
    // Don't overwrite a stored token if the client sends back the masked placeholder
    if (incoming.token === '••••••••') {
      const existing = await db.collection('github_configs').findOne({ userId });
      incoming.token = existing?.config?.token || '';
    }
    await db.collection('github_configs').updateOne(
      { userId },
      { $set: { config: incoming, userId, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GitHub pull (fetches ecosystem.json from configured repo) ─────────────────
app.post('/api/github/pull', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const cfgDoc = await db.collection('github_configs').findOne({ userId });
    const cfg = cfgDoc?.config;
    if (!cfg?.token || !cfg?.owner || !cfg?.repo) {
      return res.status(400).json({ error: 'GitHub not configured' });
    }
    const { owner, repo, branch = 'main', path = 'ecosystem.json' } = cfg;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}&t=${Date.now()}`;
    const ghRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    const data = await ghRes.json();
    res.status(ghRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GitHub shared push helper ─────────────────────────────────────────────────
// Pushes an array of { path, content } files to a repo. Auto-fetches SHA for
// existing files so pushes are idempotent. Errors per file are collected and
// returned rather than aborting the entire batch.

async function pushFilesToGitHub(cfg, repoName, files) {
  const branch = cfg.branch || 'main';
  const owner  = cfg.owner;
  const ghHeaders = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  const results = [];
  const errors  = [];

  for (const file of files) {
    const url = `https://api.github.com/repos/${owner}/${repoName}/contents/${file.path}`;
    try {
      // Fetch current SHA if the file already exists
      let sha;
      const getRes = await fetch(`${url}?ref=${branch}`, { headers: ghHeaders });
      if (getRes.ok) {
        sha = (await getRes.json()).sha;
      } else if (getRes.status !== 404) {
        const e = await getRes.json();
        throw new Error(e.message || `GitHub ${getRes.status} reading ${file.path}`);
      }

      const body = {
        message: `chore: update ${file.path.split('/').pop()} via ArchitectAI [${new Date().toISOString().slice(0, 10)}]`,
        content: Buffer.from(file.content, 'utf-8').toString('base64'),
        branch,
        ...(sha ? { sha } : {}),
      };
      const putRes = await fetch(url, { method: 'PUT', headers: ghHeaders, body: JSON.stringify(body) });
      const data   = await putRes.json();
      if (!putRes.ok) throw new Error(data.message || `GitHub ${putRes.status} on ${file.path}`);
      results.push({ path: file.path, sha: data.content?.sha });
    } catch (err) {
      errors.push({ path: file.path, error: err.message });
    }
  }

  return { results, errors };
}

// ── GitHub push (commits one or more files to configured repo) ────────────────
app.post('/api/github/push', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const cfgDoc = await db.collection('github_configs').findOne({ userId });
    const cfg = cfgDoc?.config;
    if (!cfg?.token || !cfg?.owner || !cfg?.repo) {
      return res.status(400).json({ error: 'GitHub not configured' });
    }
    const { results, errors } = await pushFilesToGitHub(cfg, cfg.repo, req.body.files || []);
    res.json({ ok: errors.length === 0, results, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GitHub create repo ────────────────────────────────────────────────────────
app.post('/api/github/create-repo', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const cfgDoc = await db.collection('github_configs').findOne({ userId });
    const cfg = cfgDoc?.config;
    if (!cfg?.token) {
      return res.status(400).json({ error: 'GitHub not configured' });
    }

    const { repoName, description = '', private: isPrivate = false } = req.body;
    if (!repoName) return res.status(400).json({ error: 'repoName is required' });

    const ghRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: repoName, description, private: isPrivate, auto_init: true }),
    });

    const data = await ghRes.json();

    if (ghRes.status === 422) {
      return res.status(422).json({ error: `Repository "${repoName}" already exists` });
    }
    if (!ghRes.ok) {
      return res.status(ghRes.status).json({ error: data.message || `GitHub error ${ghRes.status}` });
    }

    res.json({ ok: true, repoUrl: data.html_url, cloneUrl: data.clone_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Implement ecosystem via agent (SSE) ───────────────────────────────────────
app.post('/api/implement', checkJwt, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);

  // Heartbeat: send a ping every 20 s so Cloudflare/nginx don't close the
  // idle connection during long Claude API calls between progress events.
  const heartbeat = setInterval(() => res.write('data: {"type":"ping"}\n\n'), 20000);

  try {
    const userId = req.auth.payload.sub;
    const { repoName } = req.body;
    if (!repoName) { send({ type: 'error', message: 'repoName is required' }); clearInterval(heartbeat); return res.end(); }

    // Load user data from MongoDB
    const [ecoDoc, cfgDoc, userDoc] = await Promise.all([
      db.collection('ecosystems').findOne({ userId }),
      db.collection('github_configs').findOne({ userId }),
      db.collection('users').findOne({ userId }),
    ]);

    const ecosystem = ecoDoc ? { projectName: ecoDoc.projectName, services: ecoDoc.services } : null;
    const cfg       = cfgDoc?.config;
    const apiKey    = userDoc?.anthropicApiKey;

    if (!ecosystem?.services?.length) { send({ type: 'error', message: 'No ecosystem defined' }); clearInterval(heartbeat); return res.end(); }
    if (!cfg?.token)                  { send({ type: 'error', message: 'GitHub not configured' }); clearInterval(heartbeat); return res.end(); }
    if (!apiKey)                      { send({ type: 'error', message: 'No Anthropic API key configured' }); clearInterval(heartbeat); return res.end(); }

    send({ type: 'start', message: 'Starting implementation' });

    const workspace = await runImplementationAgent(ecosystem, apiKey, event => send(event));

    // Push all workspace files to GitHub
    send({ type: 'push', message: `Pushing ${Object.keys(workspace).length} files to ${repoName}` });
    const files = Object.entries(workspace).map(([path, content]) => ({ path, content }));
    const { results, errors } = await pushFilesToGitHub(cfg, repoName, files);

    const repoUrl = `https://github.com/${cfg.owner}/${repoName}`;
    send({ type: 'done', message: 'Complete', repoUrl, pushed: results.length, errors });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }

  clearInterval(heartbeat);
  res.end();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`architectai-api listening on ${PORT}`));
