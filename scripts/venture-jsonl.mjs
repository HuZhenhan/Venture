#!/usr/bin/env node

import readline from 'node:readline';

const DEFAULT_BASE_URL = 'http://127.0.0.1:49527';
const baseUrl = (process.env.VENTURE_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');

function respond(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function toError(id, code, message, trace) {
  return { id, ok: false, error: { code, message, trace } };
}

async function request(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload ? payload.error : null;
    throw {
      status: response.status,
      code: error?.code || `HTTP_${response.status}`,
      message: error?.message || response.statusText,
      trace: payload,
    };
  }
  return payload;
}

async function dispatch(message) {
  switch (message.method) {
    case 'health':
      return request('GET', '/api/health');
    case 'providers.list':
      return request('GET', '/api/providers');
    case 'skills.list':
      return request('GET', '/api/skills');
    case 'tools.execute':
      return request('POST', '/api/tools/execute', message.params || {});
    case 'files.changes': {
      const params = message.params && typeof message.params === 'object' ? message.params : {};
      const query = new URLSearchParams();
      if (typeof params.turnId === 'string') query.set('turnId', params.turnId);
      if (typeof params.path === 'string') query.set('path', params.path);
      const suffix = query.toString() ? `?${query.toString()}` : '';
      return request('GET', `/api/files/changes${suffix}`);
    }
    default:
      throw { status: null, code: 'METHOD_NOT_FOUND', message: `Unsupported method: ${message.method}` };
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
      respond(toError(null, 'INVALID_REQUEST', 'JSONL message must include a string method.'));
      return;
    }
    const result = await dispatch(message);
    respond({ id: message.id ?? null, ok: true, result });
  } catch (error) {
    const err = error && typeof error === 'object' ? error : {};
    respond(toError(message?.id ?? null, err.code || 'INTERNAL_ERROR', err.message || String(error), err.trace));
  }
});

