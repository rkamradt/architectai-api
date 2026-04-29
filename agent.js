/**
 * ArchitectAI Implementation Agent
 *
 * Runs multiple independent agentic sessions against the Anthropic API to
 * scaffold a full Node.js/Express mono-repo from an ecosystem spec:
 *   - One session per service (writes only that service's directory)
 *   - For provider/adaptor services with generateMock=true: one additional session
 *     per service generating a companion mock in {service-id}-mock/
 *   - One final session for root files (ecosystem.json, CLAUDE.md, README.md)
 *   - [STUB] One helm session after the root session — see buildHelmPrompt() below
 *
 * Usage:
 *   const { runImplementationAgent } = require('./agent');
 *   const workspace = await runImplementationAgent(spec, apiKey, onProgress, outputDir);
 */

const fs       = require('fs');
const nodePath = require('path');
const { getAllConventions } = require('./helmConventions');

const ANTHROPIC_API   = 'https://api.anthropic.com/v1/messages';
const MODEL_SONNET    = 'claude-sonnet-4-6';
const MODEL_HAIKU     = 'claude-haiku-4-5-20251001';
const MAX_TOKENS      = 16000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const TOOLS = [
  {
    name: 'write_file',
    description: 'Write content to a file in the workspace. Use this for every file you create.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the workspace root (e.g. "contacts-service/src/index.js")',
        },
        content: {
          type: 'string',
          description: 'Complete file content',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file previously written to the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to read',
        },
      },
      required: ['path'],
    },
    // cache_control on the last tool caches the entire tools array across turns
    cache_control: { type: 'ephemeral' },
  },
];

// ── Prompt builders ───────────────────────────────────────────────────────────

// ── Archetype naming enforcement ──────────────────────────────────────────────

function correctArchetypeNames(spec, onProgress) {
  const corrected = { ...spec, services: spec.services.map(s => {
    const arch = s.archetype || 'http';
    let { id, name } = s;
    const msgs = [];

    if (arch === 'provider') {
      if (!id.endsWith('-provider')) {
        const newId = id.replace(/-provider$|-adaptor$/, '') + '-provider';
        msgs.push(`id: "${id}" → "${newId}"`);
        id = newId;
      }
      if (!name.endsWith('Provider')) {
        const newName = name.replace(/Provider$|Adaptor$/, '') + 'Provider';
        msgs.push(`name: "${name}" → "${newName}"`);
        name = newName;
      }
    } else if (arch === 'adaptor') {
      if (!id.endsWith('-adaptor')) {
        const newId = id.replace(/-provider$|-adaptor$/, '') + '-adaptor';
        msgs.push(`id: "${id}" → "${newId}"`);
        id = newId;
      }
      if (!name.endsWith('Adaptor')) {
        const newName = name.replace(/Provider$|Adaptor$/, '') + 'Adaptor';
        msgs.push(`name: "${name}" → "${newName}"`);
        name = newName;
      }
    }

    if (msgs.length) {
      onProgress({ type: 'info', message: `Corrected ${arch} naming: ${msgs.join(', ')}` });
    }

    return { ...s, id, name };
  })};
  return corrected;
}

function ecosystemSummary(spec) {
  return spec.services.map(s => {
    const arch   = s.archetype || 'http';
    const apis   = s.apis?.map(a => `    ${a.method} ${a.path} — ${a.description}`).join('\n') || '    (none)';
    const events = s.events?.map(e => `    ${e.direction === 'produces' ? '▶' : '◀'} ${e.topic} — ${e.description}`).join('\n') || '    (none)';
    const deps   = s.dependencies?.length ? s.dependencies.join(', ') : 'none';
    const extra  = arch === 'provider' && s.foreignApi
      ? `\n  Foreign API: ${s.foreignApi.name} (${s.foreignApi.baseUrl}) auth=${s.foreignApi.authMethod} mock=${s.foreignApi.generateMock}`
      : arch === 'adaptor' && s.accepts
      ? `\n  Accepts: ${s.accepts.protocol}/${s.accepts.format} entity=${s.accepts.foreignEntity} mock=${s.accepts.generateMock}`
      : '';
    return `### ${s.name} (id: ${s.id}) [archetype: ${arch}]
  Purpose: ${s.purpose}
  Tech: ${s.tech || 'Node.js/Express'}${extra}
  API endpoints:
${apis}
  Events:
${events}
  Depends on: ${deps}`;
  }).join('\n\n');
}

// ── Archetype constraints text (embedded verbatim in generated CLAUDE.md) ──────

function archetypeConstraintsText(arch, service) {
  switch (arch) {
    case 'http':
      return `## Archetype Constraints — HTTP service

This service IS responsible for:
- Owning and persisting its domain data (in-memory or database)
- Implementing every API endpoint declared in its spec exactly as specified
- Input validation on all mutating endpoints (POST, PUT, PATCH)
- All business logic for its bounded context

This service is NOT responsible for:
- Wrapping external third-party APIs (use a provider service for that)
- Accepting foreign-format payloads (use an adaptor service for that)
- Event-driven processing that is not declared in its event contracts`;

    case 'messaging':
      return `## Archetype Constraints — Messaging service

This service IS responsible for:
- Consuming events from every topic listed in its "consumes" contracts
- Running business logic in response to those events
- Publishing to every topic listed in its "produces" contracts
- Managing its own consumer group offset

This service is NOT responsible for:
- Exposing HTTP domain routes — /health is the only HTTP endpoint
- Owning a persistent authoritative data store
- Wrapping external APIs or accepting foreign-format payloads`;

    case 'provider':
      return `## Archetype Constraints — Provider service

This service IS responsible for:
- Calling the ${service.foreignApi?.name || 'foreign'} API via src/client.js
- Translating foreign API responses to internal event format via src/translator.js
- Publishing translated events to the ecosystem via Kafka (src/producer.js)

This service is NOT responsible for:
- ANY business logic — translation only, no domain decisions
- Persisting data
- Exposing domain HTTP routes — /health is the only HTTP endpoint

IMPORTANT: This service contains no business logic.
It translates foreign API responses to internal events only.
If you find yourself adding conditional logic beyond field mapping, stop — that logic belongs in a domain service.`;

    case 'adaptor':
      return `## Archetype Constraints — Adaptor service

This service IS responsible for:
- Accepting inbound ${service.accepts?.protocol || 'foreign'} payloads on POST /webhook
- Validating and verifying signatures on inbound payloads (src/validator.js)
- Translating foreign payloads to internal event format (src/translator.js)
- Publishing translated events to the ecosystem via Kafka (src/producer.js)

This service is NOT responsible for:
- ANY business logic — translation only, no domain decisions
- Persisting data
- Exposing domain HTTP routes — /health and /webhook are the only HTTP endpoints

IMPORTANT: This service contains no business logic.
It translates foreign payloads to internal events only.
If you find yourself adding conditional logic beyond field mapping, stop — that logic belongs in a domain service.`;

    default:
      return '';
  }
}

// ── Per-archetype required-files manifest ─────────────────────────────────────

function requiredFilesSection(spec, service) {
  const arch     = service.archetype || 'http';
  const sid      = service.id;
  const produces = (service.events || []).filter(e => e.direction === 'produces');
  const consumes  = (service.events || []).filter(e => e.direction === 'consumes');
  const apis     = service.apis || [];

  const commonFiles = `
${sid}/package.json
  - name: "${sid}", version: "1.0.0"
  - scripts: { "start": "node src/index.js", "dev": "nodemon src/index.js", "test": "jest" }
  - engines: { "node": ">=20" }
  - dependencies: ${
      arch === 'http'      ? 'express, cors, morgan, uuid, express-validator' :
      arch === 'messaging' ? 'express, cors, morgan, kafkajs, uuid' :
      arch === 'provider'  ? 'express, cors, morgan, kafkajs, node-fetch, uuid' :
                             'express, cors, morgan, kafkajs, uuid'
    }

${sid}/Dockerfile
  - Multi-stage node:20-alpine build
  - Stage 1 (deps): WORKDIR /app, COPY package*.json ., RUN npm ci --only=production
  - Stage 2 (runtime): WORKDIR /app, COPY --from=deps /app/node_modules ./node_modules, COPY . ., EXPOSE 8080, CMD ["node","src/index.js"]

${sid}/CLAUDE.md
  - Context file for future Claude Code sessions on this service
  - Opening: "# ${service.name} — Claude Code Context"
  - Section: role in the ${spec.projectName} ecosystem, purpose
  - Section: API surface (list endpoints or "no HTTP domain routes")
  - Section: Event contracts (list produces/consumes topics)
  - Section: Dependencies
  - Section: Tech stack and environment variables
  - Then append VERBATIM the following archetype constraints block:
${archetypeConstraintsText(arch, service)}

${sid}/spec.md
  - "# ${service.name} — Service Specification"
  - Purpose, tech stack, archetype
  - API endpoints table (method, path, description, request body, response shape) or note "no domain HTTP routes"
  - Events produced table (topic, trigger, payload shape)
  - Events consumed table (topic, handler, what it does)
  - Dependencies and rationale
  - Environment variables table`;

  // ── HTTP ─────────────────────────────────────────────────────────────────────
  if (arch === 'http') {
    // Group endpoints by first path segment for route files
    const routeGroups = {};
    for (const a of apis) {
      const seg = (a.path.split('/').filter(Boolean)[0] || 'root');
      (routeGroups[seg] = routeGroups[seg] || []).push(a);
    }
    const segments = Object.keys(routeGroups);

    const routeFiles = segments.map(seg =>
`
${sid}/src/routes/${seg}.js
  - Express Router
  - Routes:
${routeGroups[seg].map(r => `      ${r.method} ${r.path} — ${r.description}`).join('\n')}
  - Each handler: validate input with express-validator (POST/PUT), call src/services/${seg}.js, return JSON
  - Import { validateResult } from src/middleware/validate.js`).join('\n');

    const serviceFiles = segments.map(seg =>
`
${sid}/src/services/${seg}.js
  - Business logic for the "${seg}" domain
  - In-memory store: realistic field names for ${service.purpose}
  - One exported async function per route operation (list, get, create, update, delete)
  - No HTTP knowledge — pure functions that return data or throw errors`).join('\n');

    return `${commonFiles}

${sid}/src/index.js
  - Express app with cors(), morgan('combined')
  - Mount routes: ${segments.map(seg => `require('./routes/${seg}')`).join(', ')}
  - GET /health → { ok: true, service: "${sid}" }
  - Error handler (src/middleware/errorHandler.js) mounted LAST
  - Listen on process.env.PORT || 8080, log startup message

${sid}/src/middleware/validate.js
  - Import { validationResult } from express-validator
  - Export: validateResult(req) — calls validationResult(req), throws { status: 400, errors } if invalid

${sid}/src/middleware/errorHandler.js
  - 4-argument Express error handler (err, req, res, next)
  - Maps err.status to HTTP status (default 500)
  - Returns { error: err.message, details: err.errors || [] }
${routeFiles}
${serviceFiles}`;
  }

  // ── MESSAGING ─────────────────────────────────────────────────────────────────
  if (arch === 'messaging') {
    const consumesList = consumes.map(e => `    "${e.topic}" — ${e.description}`).join('\n') || '    (none)';
    const producesList = produces.map(e => `    "${e.topic}" — ${e.description}`).join('\n') || '    (none)';

    const handlerFiles = consumes.map(e => {
      const safe = e.topic.replace(/\./g, '-');
      return `
${sid}/src/handlers/${safe}.js
  - Handler function for topic "${e.topic}"
  - Purpose: ${e.description}
  - Signature: async function handle(payload) { ... }
  - Calls business logic from src/services/ as needed
  - Returns { topic, payload } for any events to publish, or null if no outbound event`;
    }).join('\n');

    const svcName = sid.replace(/-/g, '_');
    return `${commonFiles}

${sid}/src/index.js
  - Express app with cors(), morgan('combined')
  - GET /health → { ok: true, service: "${sid}" }
  - NO domain HTTP routes — health only
  - On startup: await producer.connect(), await startConsumer()
  - Listen on process.env.PORT || 8080

${sid}/src/kafka.js
  - const { Kafka } = require('kafkajs')
  - Export: new Kafka({ clientId: '${sid}', brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',') })

${sid}/src/consumer.js
  - Import kafka from ./kafka
  - consumer = kafka.consumer({ groupId: '${sid}-group' })
  - async startConsumer(): connect, subscribe to topics (fromBeginning: false):
${consumesList}
  - eachMessage: parse JSON payload, route to handler in src/handlers/, if handler returns event call producer.publish()
  - Export: startConsumer

${sid}/src/producer.js
  - Import kafka from ./kafka
  - producer = kafka.producer()
  - Export: connect(), publish(topic, payload) — JSON.stringify payload, send to topic
  - Topics this producer publishes to:
${producesList}
${handlerFiles}

${sid}/src/services/${svcName}.js
  - Business logic stubs called by handlers
  - Realistic in-memory data for: ${service.purpose}
  - Pure functions — no Kafka or HTTP knowledge`;
  }

  // ── PROVIDER ──────────────────────────────────────────────────────────────────
  if (arch === 'provider') {
    const fa = service.foreignApi || {};
    const producesList = produces.map(e => `    "${e.topic}" — ${e.description}`).join('\n') || '    (none)';
    const authNote =
      fa.authMethod === 'oauth2'   ? 'OAuth2: fetch bearer token from token endpoint, cache it, refresh on 401 response' :
      fa.authMethod === 'basic'    ? 'Basic auth: base64(FOREIGN_API_USER + ":" + FOREIGN_API_PASS), set as Authorization header' :
                                     'API key: read from process.env.FOREIGN_API_KEY, set as Authorization: Bearer or x-api-key header per foreign API docs';

    const mockNote = fa.generateMock
      ? `\n  Note: a companion mock service will be generated in ${sid}-mock/ — do NOT generate any mock files here`
      : '';

    return `${commonFiles}

${sid}/src/index.js
  - Comment line 1: // This service contains no business logic. It translates foreign API responses to internal events only.
  - Express app with cors(), morgan('combined')
  - GET /health → { ok: true, service: "${sid}" }
  - NO domain HTTP routes
  - On startup: await producer.connect(), then start polling loop or schedule (setInterval / recursive setTimeout)
    The loop: call client functions → translate → producer.publish()
  - Listen on process.env.PORT || 8080
  - Environment variable: FOREIGN_API_BASE_URL (default: '${fa.baseUrl || ''}')${fa.generateMock ? `\n    In dev/stage: set FOREIGN_API_BASE_URL=http://${sid}-mock:3000` : ''}
${mockNote}

${sid}/src/client.js
  - Wraps ${fa.name || 'foreign API'} using node-fetch
  - BASE_URL = process.env.FOREIGN_API_BASE_URL || '${fa.baseUrl || ''}'
  - Comment: // Set FOREIGN_API_BASE_URL=http://${sid}-mock:3000 in dev/stage to use the companion mock
  - Auth: ${authNote}
  - One exported async function per foreign operation needed by translator
  - Returns raw parsed JSON — no interpretation

${sid}/src/translator.js
  - Comment line 1: // This service contains no business logic. It translates foreign API responses to internal events only.
  - Maps foreign response shapes → internal event payloads
  - One exported function per produces topic
  - Input: raw foreign response object; Output: internal event object with realistic field names

${sid}/src/producer.js
  - const { Kafka } = require('kafkajs')
  - kafka = new Kafka({ clientId: '${sid}', brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',') })
  - producer = kafka.producer()
  - Export: connect(), publish(topic, payload) — JSON.stringify payload
  - Topics published:
${producesList}`;
  }

  // ── ADAPTOR ───────────────────────────────────────────────────────────────────
  if (arch === 'adaptor') {
    const ac = service.accepts || {};
    const producesList = produces.map(e => `    "${e.topic}" — ${e.description}`).join('\n') || '    (none)';
    const knownSigEntities = ['stripe', 'github', 'twilio', 'shopify'];
    const needsRealSig = ac.foreignEntity && knownSigEntities.some(k => ac.foreignEntity.toLowerCase().includes(k));
    const sigNote = needsRealSig
      ? `Signature verification for ${ac.foreignEntity}: read the appropriate header (e.g. X-${ac.foreignEntity}-Signature), use crypto.createHmac('sha256', process.env.WEBHOOK_SECRET) to verify HMAC of raw body`
      : `Signature verification stub: if no signature header present, log a warning but do not reject (add a TODO comment to implement real verification when key is known)`;

    const mockNote = ac.generateMock
      ? `\n  Note: a companion mock service will be generated in ${sid}-mock/ — do NOT generate any mock files here`
      : '';

    return `${commonFiles}

${sid}/src/index.js
  - Comment line 1: // This service contains no business logic. It translates foreign payloads to internal events only.
  - express.raw({ type: '*/*' }) middleware BEFORE routes — needed for raw body signature verification
  - Express app with cors(), morgan('combined') AFTER raw body parser
  - GET /health → { ok: true, service: "${sid}" }
  - POST /webhook:
      1. const payload = validator.validate(req)  — throws on failure
      2. const event   = translator.translate(payload)
      3. await producer.publish(eventTopic, event)
      4. res.json({ ok: true })
      On validation error: res.status(400).json({ error: err.message })
  - On startup: await producer.connect()
  - Listen on process.env.PORT || 8080
${mockNote}

${sid}/src/validator.js
  - Validates inbound ${ac.format || 'unknown'} payload from ${ac.foreignEntity || 'foreign entity'}
  - ${sigNote}
  - Parses req.body (Buffer) to JSON or appropriate format
  - Validates required fields are present
  - Export: validate(req) → returns parsed payload object on success, throws on failure

${sid}/src/translator.js
  - Comment line 1: // This service contains no business logic. It translates foreign payloads to internal events only.
  - Maps ${ac.foreignEntity || 'foreign'} payload → internal event object
  - Input: validated payload from validator.js
  - Output: internal event matching the produces topic schema
  - Export: translate(payload) → internal event object
  - Topics translated to:
${producesList}

${sid}/src/producer.js
  - const { Kafka } = require('kafkajs')
  - kafka = new Kafka({ clientId: '${sid}', brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',') })
  - producer = kafka.producer()
  - Export: connect(), publish(topic, payload) — JSON.stringify payload
  - Topics published:
${producesList}`;
  }

  // Fallback (should not be reached)
  return commonFiles;
}

// ── Main service prompt ───────────────────────────────────────────────────────

function buildServicePrompt(spec, service) {
  const arch     = service.archetype || 'http';
  const sid      = service.id;
  const produces = (service.events || []).filter(e => e.direction === 'produces');
  const consumes  = (service.events || []).filter(e => e.direction === 'consumes');
  const apisText  = service.apis?.map(a => `  ${a.method} ${a.path} — ${a.description}`).join('\n') || '  (none)';
  const depText   = service.dependencies?.length ? service.dependencies.join(', ') : 'none';

  const archetypeDetail =
    arch === 'provider' && service.foreignApi
      ? `\nForeign API details:\n${JSON.stringify(service.foreignApi, null, 2)}\n`
      : arch === 'adaptor' && service.accepts
      ? `\nAccepts details:\n${JSON.stringify(service.accepts, null, 2)}\n`
      : '';

  return `You are scaffolding ONE service in the "${spec.projectName}" ecosystem.

Use the write_file tool for EVERY file. Do not explain — just write files.

## Full ecosystem context (for reference only)

${ecosystemSummary(spec)}

## Your task

Write ONLY the files for the "${sid}" service directory. Do not write files
for any other service or for the root level.

Service:   ${service.name} (id: ${sid})
Archetype: ${arch.toUpperCase()} — ${
    arch === 'http'      ? 'standard REST service with domain routes and business logic' :
    arch === 'messaging' ? 'event-driven service — Kafka consumer/producer, no domain HTTP routes' :
    arch === 'provider'  ? 'wraps external API — no business logic, translation only' :
    arch === 'adaptor'   ? 'bridges foreign protocol — no business logic, translation only' :
    arch
  }
Purpose:   ${service.purpose}
Tech:      ${service.tech || 'Node.js/Express'}
${archetypeDetail}
API endpoints:
${apisText}
Events produced:
${produces.map(e => `  ▶ ${e.topic} — ${e.description}`).join('\n') || '  (none)'}
Events consumed:
${consumes.map(e => `  ◀ ${e.topic} — ${e.description}`).join('\n') || '  (none)'}
Depends on: ${depText}

## Required files

${requiredFilesSection(spec, service)}

## Rules
- Every path must begin with "${sid}/" — no exceptions
- Write each file EXACTLY ONCE. Do not re-write a file you have already written.
- When every file listed above has been written, stop calling tools immediately.
- Write complete, production-quality file content — no truncation, no "TODO: implement" stubs
- Use real domain field names throughout — no foo/bar/baz placeholders
- Do not ask questions or explain anything. Just write files.
`;
}

function buildRootPrompt(spec) {
  const serviceTable = spec.services.map(s => {
    const arch = s.archetype || 'http';
    return `  - ${s.name} (${s.id}) [${arch}] — ${s.purpose}`;
  }).join('\n');

  const mockServices = spec.services.filter(s =>
    (s.archetype === 'provider' && s.foreignApi?.generateMock) ||
    (s.archetype === 'adaptor'  && s.accepts?.generateMock)
  );
  const mockDirNote = mockServices.length
    ? `\n  - Mock directories (dev/stage only — NOT production):\n` +
      mockServices.map(s => `      ${s.id}-mock/ — test mock for ${s.id}`).join('\n')
    : '';

  const archetypeGuide = `
Archetype legend:
  http      — standard REST service with domain routes and business logic
  messaging — event-driven service (Kafka consumer/producer, no HTTP domain routes)
  provider  — wraps a third-party API; publishes translated events; no business logic
  adaptor   — accepts inbound foreign-format webhooks; publishes translated events; no business logic`;

  return `You are writing the root-level files for the "${spec.projectName}" ecosystem.

Use the write_file tool for EVERY file. Do not explain — just write files.

## Full ecosystem

${ecosystemSummary(spec)}

## Required files (root level only — no service subdirectories)

ecosystem.json
  - Machine-readable registry: { project, generated, services: [...] }
  - Serialise the full spec above verbatim as pretty-printed JSON
  - Include archetype, foreignApi, and accepts fields exactly as they appear in the spec

CLAUDE.md
  - "# ${spec.projectName} — Platform Architecture Context"
  - Section "Services in this platform":
${serviceTable}
${archetypeGuide}
  - Section "Mono-repo layout":
      One directory per service, each with its own Dockerfile and CI workflow.
${mockDirNote}
      Directories ending in -mock are test scaffolding — never deploy them to production.
  - Section "Architecture principles":
      No shared databases. Cross-domain via Kafka. Same-domain via direct API.
      Provider and adaptor services contain NO business logic — they are translation layers only.
      Business logic lives exclusively in http and messaging services.
  - Section "Three AI operations":
      Forward — scaffold/implement a service from its spec
      Reverse — walk existing code, reconstruct spec, write back to spec.md
      Delta   — git diff HEAD~1 -- spec.md > spec.diff, implement only changed sections
  - Section "Adding a new service":
      1. Architect it in ArchitectAI → push updated spec and ecosystem.json
      2. In the service repo: claude "Scaffold this service per @../root/CLAUDE.md#<service-id>"
      3. Place the generated service CLAUDE.md at the repo root

README.md
  - "# ${spec.projectName}"
  - One-paragraph system overview
  - Table: Service | Archetype | Port | Health endpoint | Description
  - Quick-start section: how to run each service locally (node src/index.js, PORT env var, health URL)
  - For messaging/provider/adaptor services: note KAFKA_BROKERS env var must be set
  - For provider services: note FOREIGN_API_BASE_URL and auth env vars; mention -mock companion
  - For adaptor services: mention -mock companion and ADAPTOR_URL env var
  - Section "Mock services (dev/stage only)": for each -mock directory, explain its purpose and how to use it
  - Section "⚠️ Production deployment": state that -mock directories must never be deployed to production

${spec.services.map(s => `
.github/workflows/${s.id}.yml
  - name: "Build ${s.id}"
  - on: push branches [main], paths ["${s.id}/**"]
  - jobs.build: runs-on ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: docker/login-action@v3 (registry: ghcr.io, username: \${{ github.actor }}, password: \${{ secrets.GITHUB_TOKEN }})
        - uses: docker/build-push-action@v5 (context: ./${s.id}, push: true, tags: ghcr.io/rkamradt/${s.id}:main)
`).join('')}
## Rules
- Write only root-level files — no paths starting with a service id or mock id
- Write each .github/workflows/{service-id}.yml file exactly as specified above
- Write each file EXACTLY ONCE. Do not re-write a file you have already written.
- When every file listed above has been written, stop calling tools immediately.
- Do not ask questions or explain anything. Just write files.
`;
}

// ── Helm chart generation prompt (stub) ───────────────────────────────────────
//
// NOT YET ACTIVE — see the commented call site in runImplementationAgent.
//
// When activated, this runs as a single agent session after all service sessions
// and the root session. It generates helm/<service-id>/ chart directories for
// every service in the ecosystem, including companion mocks.
//
// The session writes to the "helm/" subtree only. It does not modify any
// service source directories or root files.
//
// Activation checklist:
//   1. Uncomment the helm session block in runImplementationAgent.
//   2. Emit a 'helm' progress event type in architect-ai.jsx (similar to 'mock').
//   3. Expand the file manifest in buildHelmPrompt to cover templates/,
//      _helpers.tpl, NOTES.txt, and any environment-specific values files.

function buildHelmPrompt(spec) {
  const conventions = getAllConventions(spec);
  const serviceIds  = Object.keys(conventions);

  // Build a per-service file requirements block from the convention objects
  const serviceBlocks = serviceIds.map(sid => {
    const c    = conventions[sid];
    const isMock = sid.endsWith('-mock');
    const arch = spec.services?.find(s => s.id === sid)?.archetype || (isMock ? 'mock' : 'http');

    // Archetype-specific env var notes for values.yaml
    const envVarNotes = (() => {
      if (isMock) {
        return `      enabled: ${c.mockConventions.defaultEnabled}   # set to false in production-values.yaml`;
      }
      if (arch === 'provider' && c.providerConventions) {
        const pc = c.providerConventions;
        return [
          `      FOREIGN_API_BASE_URL: "${pc.foreignApiBaseUrl.dev}"   ${pc.foreignApiUrlComment.split('\n')[0]}`,
          `      # Override in production-values.yaml: FOREIGN_API_BASE_URL: "${pc.foreignApiBaseUrl.production}"`,
          `      # Auth credential: secretKeyRef name=${pc.authSecretName} key=${pc.authEnvVar}`,
        ].join('\n');
      }
      if (arch === 'adaptor' && c.adaptorConventions) {
        const ac = c.adaptorConventions;
        return [
          `      WEBHOOK_PATH: "${ac.webhookPath.dev}"`,
          ac.webhookSecretName
            ? `      # Webhook secret: secretKeyRef name=${ac.webhookSecretName} key=${ac.webhookSecretEnvVar}`
            : `      # No webhook signature secret required`,
        ].join('\n');
      }
      if (arch === 'messaging' && c.messagingConventions) {
        const mc = c.messagingConventions;
        return `      # KAFKA_BROKERS: secretKeyRef name=${mc.kafkaBrokersSecretName} key=${mc.kafkaBrokersSecretKey}`;
      }
      return '';
    })();

    const productionValuesFile = isMock
      ? `\nhelm/${sid}/production-values.yaml\n  - enabled: false\n  - Comment: ${c.mockConventions.productionWarning}`
      : '';

    return `## helm/${sid}/

helm/${sid}/Chart.yaml
  - apiVersion: v2
  - name: ${sid}
  - version: 0.1.0
  - appVersion: "main"
  - description: Helm chart for ${sid}

helm/${sid}/values.yaml
  - image:
      repository: ${c.image.replace(':main', '')}
      tag: "main"
      pullPolicy: ${c.imagePullPolicy}
  - namespace: ${c.namespace}
  - replicaCount: 1
  - containerPort: ${c.containerPort}
  - service.port: ${c.servicePort}
  - resources:
      requests: { cpu: "${c.resources.requests.cpu}", memory: "${c.resources.requests.memory}" }
      limits:   { cpu: "${c.resources.limits.cpu}",   memory: "${c.resources.limits.memory}" }
  - livenessProbe / readinessProbe:
      httpGet: { path: "${c.healthCheck.path}", port: ${c.healthCheck.port} }
      initialDelaySeconds: ${c.healthCheck.initialDelaySeconds}
      periodSeconds: ${c.healthCheck.periodSeconds}
      failureThreshold: ${c.healthCheck.failureThreshold}
  - env:
${envVarNotes || '      {}   # no archetype-specific env vars'}
${productionValuesFile}
helm/${sid}/templates/deployment.yaml
  - Standard Kubernetes Deployment${isMock ? '\n  - Wrap entire document with {{ if .Values.enabled }} / {{ end }}' : ''}
  - namespace: {{ .Values.namespace }}
  - image: {{ .Values.image.repository }}:{{ .Values.image.tag }}
  - imagePullPolicy: {{ .Values.image.pullPolicy }}
  - containerPort: {{ .Values.containerPort }}
  - env: from .Values.env (use secretKeyRef for credentials, plain value for URLs)
  - livenessProbe and readinessProbe from .Values.livenessProbe / readinessProbe
  - resources from .Values.resources

helm/${sid}/templates/service.yaml
  - ClusterIP Service targeting containerPort {{ .Values.containerPort }}${isMock ? '\n  - Wrap with {{ if .Values.enabled }} / {{ end }}' : ''}`;
  }).join('\n\n');

  return `You are generating helm charts for the "${spec.projectName}" ecosystem.

Use the write_file tool for EVERY file. Do not explain — just write files.

## Your task

Write helm chart directories for ALL services listed below.
Every chart goes under helm/<service-id>/ — do not write files outside the helm/ directory.

Services to chart:
${serviceIds.map(sid => `  - ${sid}`).join('\n')}

## Helm conventions enforced by this platform

- Namespace: ${conventions[serviceIds[0]]?.namespace || 'rkamradt-platform'} (all services)
- Image registry: ghcr.io/rkamradt/<service-id>:main
- imagePullPolicy: Always
- Health check path: /health on containerPort 8080
- Services ending in -mock are dev/stage only — wrap Deployment and Service with {{ if .Values.enabled }}
  and include a production-values.yaml with enabled: false
- Provider services: FOREIGN_API_BASE_URL in values.yaml points at companion mock by default;
  production-values.yaml (or equivalent) overrides it to the real foreign API URL
- Adaptor services: WEBHOOK_PATH in values.yaml, overridable per environment
- Credentials (API keys, webhook secrets) come from Kubernetes Secrets via secretKeyRef —
  never hardcoded in values files

## Required files per service

${serviceBlocks}

## Rules
- Every path must begin with "helm/" — no exceptions
- Write complete YAML — no truncation, no placeholders
- values.yaml must be valid YAML with real default values, not empty stubs
- Do not ask questions or explain anything. Just write files.
`;
}

// ── Mock prompt builders ──────────────────────────────────────────────────────

function buildProviderMockPrompt(spec, service) {
  const sid    = service.id;
  const mockId = `${sid}-mock`;
  const fa     = service.foreignApi || {};
  const produces = (service.events || []).filter(e => e.direction === 'produces');
  const producesList = produces.map(e => `  ▶ ${e.topic} — ${e.description}`).join('\n') || '  (none)';

  return `You are generating a companion MOCK SERVICE for testing the "${sid}" provider service.

Use the write_file tool for EVERY file. Do not explain — just write files.

## Context

"${sid}" wraps the ${fa.name || 'foreign'} API (${fa.baseUrl || 'unknown base URL'}) and
publishes these internal events:
${producesList}

Auth method used by the provider: ${fa.authMethod || 'apiKey'}

In dev and stage environments, set the provider's FOREIGN_API_BASE_URL to
http://${mockId}:3000 so it calls this mock instead of the real ${fa.name || 'foreign'} API.

## Your task

Write ONLY files in the "${mockId}/" directory. Do not touch any other directory.

## Required files (every path MUST start with "${mockId}/")

${mockId}/package.json
  - name: "${mockId}", version: "1.0.0"
  - scripts: { "start": "node index.js", "dev": "nodemon index.js" }
  - engines: { "node": ">=20" }
  - dependencies: express, cors, morgan

${mockId}/responses.json
  - Default canned responses for each endpoint that ${sid}/src/client.js calls against ${fa.name || 'the foreign API'}
  - Shape: { "<METHOD> <path>": { "status": 200, "body": { ... } }, ... }
  - Populate with REALISTIC example data appropriate to the ${fa.name || 'foreign'} API domain
  - Include at least one response per endpoint needed to produce these events: ${produces.map(e => e.topic).join(', ') || 'none'}
  - Example keys: "GET /v1/resource", "POST /v1/resource", etc. — use real ${fa.name || 'foreign API'} path conventions

${mockId}/index.js
  - Standalone Express app; no Kafka, no external dependencies beyond express/cors/morgan
  - const responses = require('./responses.json')
  - In-memory state (module-level):
      let config = { failNext: false, statusCode: 500 }
      const callLog = []   // { timestamp, method, path, headers, body }
  - For EACH endpoint key in responses.json, register a matching Express route:
      - Push to callLog: { timestamp: new Date().toISOString(), method: req.method, path: req.path, headers: req.headers, body: req.body }
      - If config.failNext is true: set config.failNext = false, respond with config.statusCode and { error: 'simulated failure' }
      - Otherwise: respond with responses[key].status and responses[key].body
  - GET  /mock/calls  → res.json(callLog)
  - POST /mock/config → Object.assign(config, req.body); res.json({ ok: true, config })
  - DELETE /mock/calls → callLog.length = 0; res.json({ ok: true })
  - GET  /health      → { ok: true, service: "${mockId}" }
  - Listen on process.env.PORT || 3000

${mockId}/Dockerfile
  - Single-stage node:20-alpine
  - WORKDIR /app
  - COPY package*.json ./
  - RUN npm ci
  - COPY . .
  - EXPOSE 3000
  - CMD ["node", "index.js"]

${mockId}/CLAUDE.md
  - "# ${mockId} — Test Mock"
  - Opening warning block (use a markdown blockquote):
      ⚠️ This service exists ONLY for testing in dev and stage environments.
      It MUST NOT be deployed to production under any circumstances.
  - Section "Purpose": companion mock for ${sid}; simulates ${fa.name || 'the foreign API'} locally
  - Section "Usage":
      Set FOREIGN_API_BASE_URL=http://${mockId}:3000 in the ${sid} provider service
      Run: node index.js (or npm start)
      Default port: 3000 (override with PORT env var)
  - Section "Endpoints":
      GET  /health       — liveness check
      GET  /mock/calls   — returns array of all recorded inbound calls (for test assertions)
      POST /mock/config  — configure failure simulation: { "failNext": true, "statusCode": 503 }
      DELETE /mock/calls — clear the call log between tests
      + one entry per foreign API endpoint served
  - Section "Simulating failures":
      POST /mock/config { "failNext": true, "statusCode": 500 }
      The next request to any foreign API endpoint will return that status code.
      failNext resets to false after one failure.
  - Section "Customising responses":
      Edit responses.json and restart — or extend index.js to support runtime response overrides.

## Rules
- Every path must begin with "${mockId}/" — no exceptions
- NO .github/workflows/ directory — this mock is never independently published
- responses.json must contain realistic, domain-appropriate data — not "foo" / "bar" placeholders
- Write complete file content — no truncation
- Do not ask questions or explain anything. Just write files.
`;
}

function buildAdaptorMockPrompt(spec, service) {
  const sid    = service.id;
  const mockId = `${sid}-mock`;
  const ac     = service.accepts || {};
  const produces = (service.events || []).filter(e => e.direction === 'produces');
  const producesList = produces.map(e => `  ▶ ${e.topic} — ${e.description}`).join('\n') || '  (none)';

  return `You are generating a companion MOCK SERVICE for testing the "${sid}" adaptor service.

Use the write_file tool for EVERY file. Do not explain — just write files.

## Context

"${sid}" accepts inbound ${ac.protocol || 'foreign'}/${ac.format || 'unknown'} payloads from
${ac.foreignEntity || 'a foreign entity'} and publishes these internal events:
${producesList}

Specified mock behavior: ${ac.mockBehavior || `POST a sample ${ac.format || ''} payload to the adaptor's /webhook endpoint`}

The adaptor listens for webhooks at ADAPTOR_URL (default: http://${sid}:3000/webhook).
This mock sends payloads to that URL so the adaptor can be tested end-to-end locally.

## Your task

Write ONLY files in the "${mockId}/" directory. Do not touch any other directory.

## Required files (every path MUST start with "${mockId}/")

${mockId}/package.json
  - name: "${mockId}", version: "1.0.0"
  - scripts: { "start": "node index.js", "dev": "nodemon index.js" }
  - engines: { "node": ">=20" }
  - dependencies: express, cors, morgan, node-fetch

${mockId}/trigger-payload.json
  - Default payload to POST to the adaptor's /webhook endpoint
  - Must be a REALISTIC example of a ${ac.foreignEntity || 'foreign entity'} ${ac.format || ''} payload
  - Include all fields that ${sid}/src/validator.js expects to validate
  - Domain-appropriate field names and values — not placeholders

${mockId}/index.js
  - Standalone Express app
  - ADAPTOR_URL = process.env.ADAPTOR_URL || 'http://${sid}:3000/webhook'
  - const fetch = require('node-fetch')
  - const defaultPayload = require('./trigger-payload.json')
  - In-memory state (module-level):
      let config = { payload: { ...defaultPayload }, headers: {} }
  - POST /trigger:
      Merge config.headers into the fetch call headers (Content-Type: application/json always set)
      POST config.payload as JSON to ADAPTOR_URL
      const adaptorRes = await fetch(ADAPTOR_URL, { method: 'POST', headers, body: JSON.stringify(config.payload) })
      const adaptorBody = await adaptorRes.json().catch(() => null)
      res.json({ triggered: true, adaptorStatus: adaptorRes.status, adaptorBody })
  - POST /mock/config:
      If req.body.payload: deep-merge into config.payload (Object.assign(config.payload, req.body.payload))
      If req.body.headers: Object.assign(config.headers, req.body.headers)
      res.json({ ok: true, config })
  - GET  /mock/config → res.json(config)
  - GET  /health      → { ok: true, service: "${mockId}" }
  - Listen on process.env.PORT || 3001

${mockId}/Dockerfile
  - Single-stage node:20-alpine
  - WORKDIR /app
  - COPY package*.json ./
  - RUN npm ci
  - COPY . .
  - EXPOSE 3001
  - CMD ["node", "index.js"]

${mockId}/CLAUDE.md
  - "# ${mockId} — Test Mock"
  - Opening warning block (use a markdown blockquote):
      ⚠️ This service exists ONLY for testing in dev and stage environments.
      It MUST NOT be deployed to production under any circumstances.
  - Section "Purpose": companion mock for ${sid}; simulates ${ac.foreignEntity || 'the foreign entity'} sending payloads
  - Section "Usage":
      Set ADAPTOR_URL=http://${sid}:3000/webhook (or rely on the default)
      Run: node index.js (or npm start)
      Default port: 3001 (override with PORT env var)
      Trigger a test: POST http://localhost:3001/trigger
  - Section "Endpoints":
      GET  /health      — liveness check
      POST /trigger     — send current config.payload to ADAPTOR_URL, return adaptor's response
      POST /mock/config — change payload ({ "payload": {...} }) or add headers ({ "headers": {"X-Sig": "..."} })
      GET  /mock/config — inspect current trigger payload and headers
  - Section "Customising the payload":
      POST /mock/config { "payload": { "fieldName": "newValue" } } to override specific fields
      POST /mock/config { "headers": { "X-Webhook-Signature": "sha256=..." } } to add signature headers
      Edit trigger-payload.json and restart for a permanent default change.
  - Section "Testing signature verification":
      Use POST /mock/config { "headers": { "X-Signature": "..." } } to inject the header
      the adaptor's validator.js checks for.

## Rules
- Every path must begin with "${mockId}/" — no exceptions
- NO .github/workflows/ directory — this mock is never independently published
- trigger-payload.json must contain realistic, domain-appropriate data — not "foo" / "bar" placeholders
- Write complete file content — no truncation
- Do not ask questions or explain anything. Just write files.
`;
}

// ── History trimmer ───────────────────────────────────────────────────────────
// After Claude acknowledges a round of tool results, replace the full file
// content in write_file tool results with a short summary. The content is
// already in the workspace; keeping it in history only inflates input tokens.

function stripAcknowledgedWriteResults(messages) {
  const n = messages.length;
  // Need at least: prompt → assistant(tool_use) → user(tool_results) → assistant(ack)
  if (n < 4) return;

  const toolResultMsg = messages[n - 2]; // user message with tool results
  const toolUseMsg    = messages[n - 3]; // assistant message with tool_use blocks

  if (toolResultMsg.role !== 'user' || !Array.isArray(toolResultMsg.content)) return;
  if (toolUseMsg.role !== 'assistant') return;

  const writeFilePaths = {};
  for (const block of toolUseMsg.content) {
    if (block.type === 'tool_use' && block.name === 'write_file') {
      writeFilePaths[block.id] = block.input.path;
    }
  }
  if (Object.keys(writeFilePaths).length === 0) return;

  // Collapse tool_result content to just the path — the OK echo is tiny overhead
  // but keeping it short avoids accumulating large ack messages in history.
  // Do NOT touch the tool_use blocks — Claude needs to see what it wrote.
  toolResultMsg.content = toolResultMsg.content.map(block => {
    if (block.type === 'tool_result' && writeFilePaths[block.tool_use_id]) {
      return {
        ...block,
        content: [{ type: 'text', text: `OK: ${writeFilePaths[block.tool_use_id]}` }],
      };
    }
    return block;
  });
}

// ── Single session ────────────────────────────────────────────────────────────
// Runs one complete agentic loop from a fresh message history until Claude
// stops using tools. Writes files into workspace (and optionally to disk).

async function runSession(initialPrompt, apiKey, onProgress, outputDir, workspace, service, model = MODEL_SONNET) {
  // Cache the initial (large) prompt — all subsequent turns in this session
  // get a cache hit on it, paying only 10% of normal input-token cost.
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: initialPrompt, cache_control: { type: 'ephemeral' } }],
  }];

  while (true) {
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, tools: TOOLS, messages }),
    });

    // ── Rate-limit back-off ───────────────────────────────────────────────────
    // If the API tells us we're close to the per-minute input-token limit,
    // sleep until the reset timestamp before continuing (or retrying on 429).
    if (res.status === 429) {
      const resetAt = res.headers.get('anthropic-ratelimit-input-tokens-reset');
      const waitMs  = resetAt ? Math.max(0, new Date(resetAt).getTime() - Date.now()) + 2000 : 60000;
      console.warn(`[rate-limit] 429 on service=${service} — waiting ${Math.ceil(waitMs / 1000)}s until ${resetAt ?? 'unknown'}`);
      onProgress({ type: 'info', message: `Rate limited — waiting ${Math.ceil(waitMs / 1000)}s for reset`, service });
      await sleep(waitMs);
      continue; // retry the same request
    }

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error?.message || `Anthropic API error ${res.status}`);
    }

    // Warn and pause proactively if remaining input tokens are running low
    const remaining = parseInt(res.headers.get('anthropic-ratelimit-input-tokens-remaining') || '999999', 10);
    const resetAt   = res.headers.get('anthropic-ratelimit-input-tokens-reset');
    if (remaining < 8000 && resetAt) {
      const waitMs = Math.max(0, new Date(resetAt).getTime() - Date.now()) + 2000;
      console.warn(`[rate-limit] token budget low: ${remaining} remaining on service=${service} — waiting ${Math.ceil(waitMs / 1000)}s until ${resetAt}`);
      onProgress({ type: 'info', message: `Token budget low (${remaining} remaining) — waiting ${Math.ceil(waitMs / 1000)}s`, service });
      await sleep(waitMs);
    }

    onProgress({
      type: 'thinking',
      message: `Claude is working... (${data.usage?.input_tokens ?? '?'} input tokens)`,
      service,
    });

    if (data.stop_reason === 'max_tokens') {
      throw new Error(`Response truncated (max_tokens) while processing ${service}. Try a smaller spec.`);
    }

    messages.push({ role: 'assistant', content: data.content });
    stripAcknowledgedWriteResults(messages);

    const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    const toolResults = toolUseBlocks.map(block => {
      let resultText;

      if (block.name === 'write_file') {
        const { path, content } = block.input;
        workspace[path] = content;
        if (outputDir) {
          const abs = nodePath.join(outputDir, path);
          fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, 'utf-8');
        }
        onProgress({ type: 'file', message: `Writing ${path}`, path, content, service });
        resultText = `OK: wrote ${path} (${content.length} bytes)`;
      } else if (block.name === 'read_file') {
        const { path } = block.input;
        resultText = workspace[path] !== undefined
          ? workspace[path]
          : `ERROR: file not found: ${path}`;
      } else {
        resultText = `ERROR: unknown tool: ${block.name}`;
      }

      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: [{ type: 'text', text: resultText }],
      };
    });

    messages.push({ role: 'user', content: toolResults });
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

async function runImplementationAgent(spec, apiKey, onProgress, outputDir = null, isCancelled = async () => false) {
  const workspace = {};

  // Validate and correct archetype naming conventions before generating
  const correctedSpec = correctArchetypeNames(spec, onProgress);

  for (const service of correctedSpec.services) {
    if (await isCancelled()) {
      onProgress({ type: 'info', message: 'Implementation cancelled', service: 'root' });
      return workspace;
    }
    onProgress({ type: 'service', message: `Implementing ${service.id}`, service: service.id });
    await runSession(buildServicePrompt(correctedSpec, service), apiKey, onProgress, outputDir, workspace, service.id);

    // Generate companion mock service if applicable (Haiku — mechanical task)
    if (service.archetype === 'provider' && service.foreignApi?.generateMock) {
      if (await isCancelled()) { onProgress({ type: 'info', message: 'Implementation cancelled', service: 'root' }); return workspace; }
      const mockId = `${service.id}-mock`;
      onProgress({ type: 'mock', message: `Generating provider mock for ${service.id}`, service: mockId });
      await runSession(buildProviderMockPrompt(correctedSpec, service), apiKey, onProgress, outputDir, workspace, mockId, MODEL_HAIKU);
    } else if (service.archetype === 'adaptor' && service.accepts?.generateMock) {
      if (await isCancelled()) { onProgress({ type: 'info', message: 'Implementation cancelled', service: 'root' }); return workspace; }
      const mockId = `${service.id}-mock`;
      onProgress({ type: 'mock', message: `Generating adaptor mock for ${service.id}`, service: mockId });
      await runSession(buildAdaptorMockPrompt(correctedSpec, service), apiKey, onProgress, outputDir, workspace, mockId, MODEL_HAIKU);
    }
  }

  if (await isCancelled()) {
    onProgress({ type: 'info', message: 'Implementation cancelled', service: 'root' });
    return workspace;
  }
  onProgress({ type: 'service', message: 'Writing root files', service: 'root' });
  // Root session is template assembly — Haiku is sufficient and much cheaper
  await runSession(buildRootPrompt(correctedSpec), apiKey, onProgress, outputDir, workspace, 'root', MODEL_HAIKU);

  // ── HELM CHART GENERATION (not yet active) ─────────────────────────────────
  // Uncomment the block below to enable helm chart generation.
  // Before activating:
  //   1. Add 'helm' to the onProgress event types rendered in architect-ai.jsx
  //   2. Expand buildHelmPrompt() file manifest (templates/, _helpers.tpl, NOTES.txt)
  //   3. Decide whether helm/ is pushed to the same repo or a separate helm-charts repo
  //
  // const helmIds = Object.keys(getAllConventions(correctedSpec));
  // onProgress({ type: 'helm', message: `Generating helm charts for ${helmIds.length} services`, service: 'helm' });
  // await runSession(buildHelmPrompt(correctedSpec), apiKey, onProgress, outputDir, workspace, 'helm');

  return workspace;
}

module.exports = { runImplementationAgent, buildServicePrompt, buildRootPrompt };
