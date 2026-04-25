const express = require('express');
const cors = require('cors');
const { auth } = require('express-oauth2-jwt-bearer');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
}));

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
  })
  .catch(err => { console.error('MongoDB connection failed:', err); process.exit(1); });

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── Anthropic proxy ───────────────────────────────────────────────────────────
// Key stays server-side; browser never sees it.
app.post('/api/messages', checkJwt, async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
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

// ── GitHub push (commits one or more files to configured repo) ────────────────
app.post('/api/github/push', checkJwt, async (req, res) => {
  try {
    const userId = req.auth.payload.sub;
    const cfgDoc = await db.collection('github_configs').findOne({ userId });
    const cfg = cfgDoc?.config;
    if (!cfg?.token || !cfg?.owner || !cfg?.repo) {
      return res.status(400).json({ error: 'GitHub not configured' });
    }
    // req.body.files = [{ path, content (utf-8 string), sha (optional) }]
    const { files } = req.body;
    const results = [];
    for (const file of files) {
      const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${file.path}`;
      const body = {
        message: `chore: update ${file.path.split('/').pop()} via ArchitectAI [${new Date().toISOString().slice(0, 10)}]`,
        content: Buffer.from(file.content, 'utf-8').toString('base64'),
        branch: cfg.branch || 'main',
      };
      if (file.sha) body.sha = file.sha;
      const ghRes = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data = await ghRes.json();
      if (!ghRes.ok) throw new Error(data.message || `GitHub ${ghRes.status} on ${file.path}`);
      results.push({ path: file.path, sha: data.content?.sha });
    }
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`architectai-api listening on ${PORT}`));
