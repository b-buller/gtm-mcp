// src/gtm.js
//
// GTM MCP engine. Builds ~18 resource-grouped tools from the live Google Tag
// Manager v2 discovery doc, then dispatches tool calls to the REST API. No
// hand-written per-endpoint code: the discovery doc is the source of truth for
// paths, verbs, query params, body presence, and scopes.
//
// The engine has exactly two external dependencies:
//   1. global `fetch` — pulls the discovery doc + calls the GTM REST API.
//   2. an injected `getAccessToken(email) -> string|null` — resolves a Google
//      OAuth access token. See src/auth.js for the default implementation.

const DISCOVERY_URL = 'https://tagmanager.googleapis.com/$discovery/rest?version=v2';

// registry cached for process lifetime; restart to pick up GTM API changes
// (v2 is stable). Add a vendored fallback only if offline boot matters.
let _registryPromise;

/** Fetch + flatten the discovery doc into { baseUrl, methods: { id -> meta } }. */
async function getRegistry() {
  return (_registryPromise ??= (async () => {
    const res = await fetch(DISCOVERY_URL);
    if (!res.ok) throw new Error(`GTM discovery fetch failed: ${res.status}`);
    const doc = await res.json();
    const methods = {};
    const walk = (node) => {
      for (const rb of Object.values(node.resources || {})) {
        for (const m of Object.values(rb.methods || {})) {
          const parts = m.id.split('.').slice(1); // drop "tagmanager"
          const op = parts.pop();
          const segments = parts; // e.g. [accounts, containers, workspaces, tags]
          const params = m.parameters || {};
          methods[m.id] = {
            id: m.id,
            op,
            segments,
            lastSeg: segments[segments.length - 1] || 'accounts',
            http: m.httpMethod,
            path: m.path,
            queryParams: Object.keys(params).filter((k) => params[k].location === 'query'),
            hasBody: !!m.request,
            scopes: m.scopes || [],
          };
        }
        walk(rb);
      }
    };
    walk(doc);
    return { baseUrl: doc.baseUrl, methods };
  })());
}

// Map a resource segment to its id argument name. Most are `<singular>Id`;
// a few are irregular, and built_in_variables / version_headers have no path id.
const ID_OVERRIDES = {
  versions: 'containerVersionId',
  user_permissions: 'userPermissionId',
  gtag_config: 'gtagConfigId',
  built_in_variables: null,
  version_headers: null,
};
function idArg(seg) {
  if (seg in ID_OVERRIDES) return ID_OVERRIDES[seg];
  const singular = seg.replace(/s$/, '');
  const camel = singular.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return camel + 'Id';
}

// Short per-id hints so the model knows where each id sits in the path hierarchy.
const ID_HINT = {
  accountId: 'GTM account id (top level; list via gtm_accounts).',
  containerId: 'GTM container id (under an account; list via gtm_containers).',
  workspaceId: 'GTM workspace id (under a container; list via gtm_workspaces).',
};
const idDesc = (a) => ID_HINT[a] || `Id of the ${a.replace(/Id$/, '')} being targeted (the deepest path id is the resource itself).`;

/** Build a GTM resource name like "accounts/6/containers/9/workspaces/2/tags/3". */
function buildName(segments, args, includeLast) {
  const segs = includeLast ? segments : segments.slice(0, -1);
  return segs
    .map((seg) => {
      const a = idArg(seg);
      if (a === null) throw new Error(`No id mapping for segment '${seg}'`);
      const v = args[a];
      if (v === undefined || v === null || v === '') throw new Error(`Missing required '${a}'`);
      return `${seg}/${v}`;
    })
    .join('/');
}

const COMMON_QUERY = ['pageToken', 'fingerprint', 'includeDeleted', 'includeGoogleTags', 'type'];

/** Resolve the full request URL (path substitution + querystring) for a method. */
function buildUrl(reg, m, args) {
  let tmpl = m.path;
  if (tmpl.includes('{+parent}')) tmpl = tmpl.replace('{+parent}', buildName(m.segments, args, false));
  else if (tmpl.includes('{+path}')) tmpl = tmpl.replace('{+path}', buildName(m.segments, args, true));

  const declared = new Set(m.queryParams);
  const qp = new URLSearchParams();
  const append = (k, v) => (Array.isArray(v) ? v.forEach((x) => qp.append(k, String(x))) : qp.append(k, String(v)));

  // Long-tail / special-verb params via a free-form `query` object (e.g. combine,
  // move_tag_id) — sidesteps name clashes with structured path ids.
  if (args.query && typeof args.query === 'object') {
    for (const [k, v] of Object.entries(args.query)) if (declared.has(k) && v != null) append(k, v);
  }
  for (const k of COMMON_QUERY) {
    if (args[k] != null && declared.has(k)) {
      qp.delete(k);
      append(k, args[k]);
    }
  }
  const qs = qp.toString();
  return reg.baseUrl + tmpl + (qs ? `?${qs}` : '');
}

const PUBLISH_SCOPE = 'https://www.googleapis.com/auth/tagmanager.publish';
const HIGH_IMPACT = new Set(['set_latest', 'undelete', 'combine', 'move_tag_id', 'reauthorize', 'resolve_conflict']);
// category -> config.gtm boolean flag, plus the env var that feeds it (for error text).
const CAT_FLAG = { write: 'enableWrites', delete: 'enableDeletes', publish: 'enablePublish' };
const CAT_ENV = { write: 'GTM_MCP_ENABLE_WRITES', delete: 'GTM_MCP_ENABLE_DELETES', publish: 'GTM_MCP_ENABLE_PUBLISH' };

function category(m) {
  if (m.http === 'DELETE') return 'delete';
  if (m.scopes.includes(PUBLISH_SCOPE)) return 'publish';
  if (['POST', 'PUT', 'PATCH'].includes(m.http)) return 'write';
  return 'read';
}
// read is always allowed; write/delete/publish require their flag to be true.
function enabled(cat, gtm) {
  if (cat === 'read') return true;
  return gtm?.[CAT_FLAG[cat]] === true;
}

const err = (text) => ({ content: [{ type: 'text', text }], isError: true });

/** Dispatch a single discovery method. Handles auth, guardrails, fetch, response. */
async function callMethod(getAccessToken, methodId, args, gtm = {}) {
  const reg = await getRegistry();
  const m = reg.methods[methodId];
  if (!m) return err(`Unknown method '${methodId}'.`);

  const cat = category(m);
  if (!enabled(cat, gtm)) return err(`Operation '${m.op}' is disabled. Enable it by setting ${CAT_ENV[cat]}=true.`);

  const needConfirm = cat === 'delete' || cat === 'publish' || HIGH_IMPACT.has(m.op);
  if (needConfirm && args.confirm !== true) {
    return err(`Operation '${m.op}' is high-impact/irreversible. Pass confirm:true to proceed.`);
  }

  const email = String(args.email || gtm.defaultEmail || '').trim().toLowerCase();
  let token;
  try {
    token = await getAccessToken(email);
  } catch (e) {
    return err(`Failed to obtain a Google access token: ${e.message}`);
  }
  if (!token) {
    return err(
      `No Google access token available${email ? ` for ${email}` : ''}. ` +
        `Set GTM_ACCESS_TOKEN, or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN.`
    );
  }

  let url;
  try {
    url = buildUrl(reg, m, args);
  } catch (e) {
    return err(e.message);
  }

  const opts = { method: m.http, headers: { Authorization: `Bearer ${token}` } };
  if (m.hasBody && args.body != null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(args.body);
  }

  const resp = await fetch(url, opts);
  const ct = resp.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await resp.json() : await resp.text();
  const payload = { status: resp.status, ok: resp.ok, data };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: !resp.ok };
}

function descFor(seg, ops) {
  const label = seg.replace(/_/g, ' ');
  return `Google Tag Manager: ${label}. operation = one of [${ops.join(', ')}]. ` +
    `'email' is OPTIONAL — omit it to act as the server's default Google account, or pass one to override. ` +
    `GTM nests accounts > containers > workspaces > {tags,triggers,variables,...}: pass every path id down ` +
    `to the level you target (e.g. a tag needs accountId+containerId+workspaceId+tagId), and use the list ` +
    `operations top-down to discover ids you don't have. 'body' carries the GTM resource JSON for ` +
    `create/update; delete/publish/high-impact ops need confirm:true.`;
}

/** Build the ~18 resource-grouped MCP tool definitions (plain JSON Schema). */
async function buildTools() {
  const reg = await getRegistry();
  const groups = {};
  for (const m of Object.values(reg.methods)) (groups[m.lastSeg] ??= []).push(m);

  const tools = [];
  for (const [seg, ms] of Object.entries(groups)) {
    const ops = [...new Set(ms.map((m) => m.op))].sort();
    const longest = ms.reduce((a, b) => (b.segments.length > a.segments.length ? b : a)).segments;
    const idArgs = longest.map(idArg).filter(Boolean);

    const props = {
      operation: { type: 'string', enum: ops, description: 'Which operation to perform.' },
      email: { type: 'string', description: 'Optional. Email of the connected Google account to act as; omit to use the server default. Its OAuth token is used.' },
    };
    for (const a of idArgs) props[a] = { type: 'string', description: idDesc(a) };
    if (ms.some((m) => m.hasBody)) props.body = { type: 'object', description: 'GTM resource JSON (create/update/etc.).' };

    const allQ = new Set(ms.flatMap((m) => m.queryParams));
    if (allQ.has('pageToken')) props.pageToken = { type: 'string' };
    if (allQ.has('fingerprint')) props.fingerprint = { type: 'string' };
    if (allQ.has('includeDeleted')) props.includeDeleted = { type: 'boolean' };
    if (allQ.has('includeGoogleTags')) props.includeGoogleTags = { type: 'boolean' };
    if (allQ.has('type')) props.type = { description: 'Built-in variable type(s).', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] };
    props.query = { type: 'object', description: 'Extra query params for special ops, e.g. combine: {containerId}, move_tag_id: {tagId, tagName}.' };

    if (ms.some((m) => category(m) === 'delete' || category(m) === 'publish' || HIGH_IMPACT.has(m.op))) {
      props.confirm = { type: 'boolean', description: 'Required (true) for delete/publish/high-impact operations.' };
    }

    tools.push({
      name: `gtm_${seg}`,
      description: descFor(seg, ops),
      inputSchema: { type: 'object', properties: props, required: ['operation'] },
    });
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

/** Route a tool call (gtm_<seg> + operation) to the matching discovery method. */
async function callTool(getAccessToken, name, args = {}, gtm = {}) {
  const reg = await getRegistry();
  const seg = name.replace(/^gtm_/, '');
  const op = args.operation;
  if (!op) return err(`'operation' is required.`);
  const m = Object.values(reg.methods).find((x) => x.lastSeg === seg && x.op === op);
  if (!m) return err(`Unknown operation '${op}' for tool '${name}'.`);
  return callMethod(getAccessToken, m.id, args, gtm);
}

export { buildTools, callTool, getRegistry };
