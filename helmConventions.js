/**
 * helmConventions.js
 *
 * Documents the deployment rules ArchitectAI enforces when generating helm
 * charts for an ecosystem. This module is imported by the helm chart generation
 * session in agent.js.
 *
 * ─── How this is used ────────────────────────────────────────────────────────
 *
 * When helm chart generation is active, agent.js runs one additional agent
 * session at the end of runImplementationAgent (after all service sessions and
 * the root session complete). That session:
 *
 *   1. Receives a prompt built by buildHelmPrompt(spec) in agent.js.
 *   2. buildHelmPrompt calls getAllConventions(spec) from this module to get
 *      a per-service convention object for every service (and companion mock).
 *   3. The session prompt renders those conventions as explicit file requirements
 *      for each helm/<service-id>/ directory.
 *   4. Claude writes Chart.yaml, values.yaml, templates/, and (for mocks) a
 *      production-values.yaml per the rules below.
 *
 * ─── Conventions enforced ────────────────────────────────────────────────────
 *
 * 1. Every service gets its own helm chart directory:  helm/<service-id>/
 *
 * 2. Mock services (id ends in -mock) are only deployed in dev and stage:
 *    - values.yaml          → enabled: true
 *    - production-values.yaml → enabled: false
 *    Charts must guard the Deployment with {{ if .Values.enabled }}.
 *
 * 3. Provider services must expose FOREIGN_API_BASE_URL per environment:
 *    - dev/stage: http://<service-id>-mock:3000  (companion mock)
 *    - production: the real foreign API base URL from the spec
 *
 * 4. Adaptor services must expose WEBHOOK_PATH per environment so the inbound
 *    path can be overridden without rebuilding the image.
 *
 * 5. All services, regardless of archetype, get:
 *    - Health check on GET /health (port 8080)
 *    - Resource requests and limits appropriate to the archetype
 *    - Standard namespace: rkamradt-platform
 *    - imagePullPolicy: Always
 *    - Image: ghcr.io/rkamradt/<service-id>:main
 */

'use strict';

// ── Platform-wide constants ───────────────────────────────────────────────────

const PLATFORM = {
  namespace:       'rkamradt-platform',
  imageRegistry:   'ghcr.io/rkamradt',
  imagePullPolicy: 'Always',
  healthPath:      '/health',
  containerPort:   8080,
  servicePort:     80,
};

// ── Resource limits per archetype ─────────────────────────────────────────────
//
// These are deliberately conservative. Real tuning should happen after
// load-testing. The goal is safe defaults that prevent a single misbehaving
// pod from saturating the node.

const RESOURCE_LIMITS = {
  http: {
    requests: { cpu: '50m',  memory: '128Mi' },
    limits:   { cpu: '200m', memory: '256Mi' },
  },
  messaging: {
    // Slightly higher than http — kafkajs consumer keeps an open TCP connection
    // and may buffer messages in memory.
    requests: { cpu: '50m',  memory: '128Mi' },
    limits:   { cpu: '300m', memory: '512Mi' },
  },
  provider: {
    // Lightweight: polling loop + translation. No in-memory domain data.
    requests: { cpu: '25m', memory: '64Mi' },
    limits:   { cpu: '100m', memory: '128Mi' },
  },
  adaptor: {
    // Lightweight: webhook handler + translation. No in-memory domain data.
    requests: { cpu: '25m', memory: '64Mi' },
    limits:   { cpu: '100m', memory: '128Mi' },
  },
  mock: {
    // Minimal — mocks run only in dev/stage and see low traffic.
    requests: { cpu: '10m', memory: '32Mi' },
    limits:   { cpu: '50m', memory: '64Mi' },
  },
};

// ── Health check defaults ─────────────────────────────────────────────────────

const HEALTH_CHECK = {
  path:                 PLATFORM.healthPath,
  port:                 PLATFORM.containerPort,
  initialDelaySeconds:  10,
  periodSeconds:        15,
  failureThreshold:     3,
  successThreshold:     1,
};

// ── getConventions(service, spec) ─────────────────────────────────────────────
//
// Returns the full set of helm configuration rules for a single service.
// The helm generation session uses this for every service (and every mock)
// to determine what Chart.yaml, values.yaml, and templates/ should contain.
//
// Parameters:
//   service  — a service object from spec.services (with id, archetype, etc.)
//   spec     — the full ecosystem spec (used for cross-service references)
//
// Returns an object with:
//   chartDir          — where to write the chart: "helm/<service-id>"
//   image             — full image reference
//   imagePullPolicy   — always "Always" on this platform
//   namespace         — always "rkamradt-platform"
//   containerPort     — always 8080
//   servicePort       — always 80
//   healthCheck       — liveness/readiness probe config
//   resources         — cpu/memory requests and limits
//   hasPublishWorkflow — whether the service has its own CI workflow
//   <archetype>Conventions — archetype-specific extra config (see below)

function getConventions(service, spec = {}) {
  const arch   = service.archetype || 'http';
  const sid    = service.id;
  const isMock = sid.endsWith('-mock');

  // Base conventions apply to every service and every mock
  const base = {
    chartDir:        `helm/${sid}`,
    image:           `${PLATFORM.imageRegistry}/${sid}:main`,
    imagePullPolicy: PLATFORM.imagePullPolicy,
    namespace:       PLATFORM.namespace,
    containerPort:   PLATFORM.containerPort,
    servicePort:     PLATFORM.servicePort,
    healthCheck:     { ...HEALTH_CHECK },
    resources:       isMock ? RESOURCE_LIMITS.mock : (RESOURCE_LIMITS[arch] || RESOURCE_LIMITS.http),
  };

  // ── Mock services ──────────────────────────────────────────────────────────
  if (isMock) {
    return {
      ...base,
      hasPublishWorkflow: false,   // mocks are never independently published to ghcr.io
      mockConventions: {
        // values.yaml: enabled: true  (deployed in dev and stage)
        // production-values.yaml: enabled: false  (must never reach production)
        defaultEnabled:    true,
        productionEnabled: false,
        // The Deployment template must be wrapped:
        //   {{ if .Values.enabled }}
        //   apiVersion: apps/v1
        //   kind: Deployment
        //   ...
        //   {{ end }}
        deploymentGuard:   '{{ if .Values.enabled }}',
        productionWarning: [
          'This helm chart is for dev and stage environments ONLY.',
          'The production-values.yaml explicitly sets enabled: false.',
          'Do NOT include this chart in any production Argo CD Application or Flux Kustomization.',
        ].join(' '),
      },
    };
  }

  // ── Provider services ──────────────────────────────────────────────────────
  if (arch === 'provider') {
    const fa      = service.foreignApi || {};
    const mockId  = `${sid}-mock`;
    const hasMock = !!fa.generateMock;

    // Auth secret: the operator must pre-create this Kubernetes Secret before
    // the chart is deployed. The helm chart references it; it never stores
    // the actual credential value.
    const authEnvVar =
      fa.authMethod === 'oauth2' ? 'OAUTH2_TOKEN_URL' :
      fa.authMethod === 'basic'  ? 'FOREIGN_API_PASSWORD' :
                                   'FOREIGN_API_KEY';

    return {
      ...base,
      hasPublishWorkflow: true,
      providerConventions: {
        // FOREIGN_API_BASE_URL is set differently per environment.
        // The helm chart should expose this as a values key so each
        // environment's values file can override it.
        foreignApiBaseUrl: {
          dev:        hasMock ? `http://${mockId}:3000` : (fa.baseUrl || ''),
          stage:      hasMock ? `http://${mockId}:3000` : (fa.baseUrl || ''),
          production: fa.baseUrl || '',   // real foreign API — never the mock
        },
        // Kubernetes Secret that holds auth credentials.
        // The chart should mount this as an env var from secretKeyRef.
        authSecretName: `${sid}-auth`,
        authEnvVar,
        // Comment to emit in the chart's values.yaml next to foreignApiBaseUrl:
        foreignApiUrlComment:
          hasMock
            ? `# dev/stage: http://${mockId}:3000 (companion mock)\n# production: ${fa.baseUrl || 'FILL IN'}`
            : `# Production: ${fa.baseUrl || 'FILL IN'}`,
      },
    };
  }

  // ── Adaptor services ───────────────────────────────────────────────────────
  if (arch === 'adaptor') {
    const ac = service.accepts || {};

    return {
      ...base,
      hasPublishWorkflow: true,
      adaptorConventions: {
        // WEBHOOK_PATH is the path the adaptor's Express app listens on.
        // Exposed as a values key so it can be overridden per environment if
        // the ingress or external entity uses a different path in each env.
        webhookPath: {
          dev:        '/webhook',
          stage:      '/webhook',
          production: '/webhook',
        },
        // If a HMAC or signature secret is needed, the operator creates this
        // Kubernetes Secret and the chart mounts it as WEBHOOK_SECRET.
        webhookSecretName: ac.foreignEntity ? `${sid}-webhook-secret` : null,
        webhookSecretEnvVar: 'WEBHOOK_SECRET',
      },
    };
  }

  // ── Messaging services ─────────────────────────────────────────────────────
  if (arch === 'messaging') {
    return {
      ...base,
      hasPublishWorkflow: true,
      messagingConventions: {
        // KAFKA_BROKERS is injected from a platform-wide Kubernetes Secret
        // created once per cluster. The chart references it by secretKeyRef.
        kafkaBrokersSecretName: 'kafka-brokers',
        kafkaBrokersSecretKey:  'KAFKA_BROKERS',
      },
    };
  }

  // ── HTTP services (default) ────────────────────────────────────────────────
  return {
    ...base,
    hasPublishWorkflow: true,
  };
}

// ── getAllConventions(spec) ────────────────────────────────────────────────────
//
// Returns a { [serviceId]: conventions } map for every service in the spec,
// including companion mock entries derived from generateMock flags.
//
// This is the primary entry point for the helm generation session prompt.
// buildHelmPrompt(spec) in agent.js calls this and renders each entry into
// explicit file requirements for that service's helm/<service-id>/ directory.
//
// The session receives the full map so it can:
//   - Cross-reference a provider's FOREIGN_API_BASE_URL with its mock's service name
//   - Ensure production-values.yaml disables mocks but not production services
//   - Emit consistent resource/health config across all charts

function getAllConventions(spec) {
  const result = {};

  for (const service of (spec.services || [])) {
    result[service.id] = getConventions(service, spec);

    // Add conventions entry for companion mock if one will be generated
    const needsMock =
      (service.archetype === 'provider' && service.foreignApi?.generateMock) ||
      (service.archetype === 'adaptor'  && service.accepts?.generateMock);

    if (needsMock) {
      const mockId = `${service.id}-mock`;
      // Represent the mock as a synthetic service object for convention lookup
      const mockService = {
        id:        mockId,
        name:      `${service.name}Mock`,
        archetype: 'mock',   // synthetic — triggers mock branch in getConventions
      };
      result[mockId] = getConventions(mockService, spec);
    }
  }

  return result;
}

module.exports = { getConventions, getAllConventions, PLATFORM, RESOURCE_LIMITS, HEALTH_CHECK };
