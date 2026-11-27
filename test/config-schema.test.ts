// Guards the shape of config.schema.json, which nothing else in the suite touches.
//
// The Homebridge verification bot rejected 2.1.0 for carrying draft-3 style
// `"required": true` on individual properties. It rendered correctly anyway — the UI runs
// convertSchemaToDraft6 first — so nothing failed and nothing caught it. In JSON Schema
// proper, `required` is an array of property names on the enclosing object.
//
// No ajv here on purpose: the file also carries Homebridge UI keywords (`placeholder`,
// `titleMap`, `condition`) that a strict JSON Schema validator rejects, so pulling one in
// would mean silencing it. These assertions target the mistake that actually happened.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface SchemaNode {
  type?: string;
  default?: unknown;
  additionalProperties?: unknown;
  required?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

const schemaPath = join(__dirname, '..', 'config.schema.json');
const raw = readFileSync(schemaPath, 'utf8');
const config = JSON.parse(raw) as {
  pluginAlias: string; pluginType: string; schema: SchemaNode; layout?: unknown[];
};

/** Every object node in the schema, at any depth. */
function walk(node: SchemaNode, path: string, out: Array<[string, SchemaNode]> = []) {
  out.push([path, node]);
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    walk(child, `${path}.${key}`, out);
  }
  if (node.items) {
    walk(node.items, `${path}[]`, out);
  }
  return out;
}

const nodes = walk(config.schema, 'schema');

test('config.schema.json is valid JSON', () => {
  assert.ok(config.schema, 'has a schema key');
  assert.strictEqual(config.pluginType, 'platform');
  assert.strictEqual(config.pluginAlias, 'KumoV3');
});

test('no node uses the draft-3 boolean form of required', () => {
  const offenders = nodes
    .filter(([, n]) => typeof n.required === 'boolean')
    .map(([p]) => p);
  assert.deepStrictEqual(offenders, [], 'required must be an array on the parent object');
});

test('every required entry is an array of strings naming real properties', () => {
  for (const [path, node] of nodes) {
    if (node.required === undefined) {
      continue;
    }
    assert.ok(Array.isArray(node.required), `${path}.required is an array`);
    for (const name of node.required as unknown[]) {
      assert.strictEqual(typeof name, 'string', `${path}.required entries are strings`);
      assert.ok(
        node.properties && name as string in node.properties,
        `${path}.required names "${name}", which is not a property of ${path}`,
      );
    }
  }
});

test('credentials and name are required by the schema', () => {
  assert.deepStrictEqual(config.schema.required, ['name', 'username', 'password']);
});

test('a mirror entry requires both ends', () => {
  const mirror = config.schema.properties?.mirror;
  assert.ok(mirror?.items, 'mirror is an array with items');
  assert.deepStrictEqual(mirror.items.required, ['source', 'target']);
});

/** Every property key the layout places, at any depth (plain strings and `{ key }` items). */
function layoutKeys(items: unknown[], out: string[] = []): string[] {
  for (const item of items) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (item && typeof item === 'object') {
      const { key, items: nested } = item as { key?: string; items?: unknown[] };
      if (key) {
        out.push(key);
      }
      if (Array.isArray(nested)) {
        layoutKeys(nested, out);
      }
    }
  }
  return out;
}

test('every top-level key the layout places is a property of the schema', () => {
  const props = Object.keys(config.schema.properties ?? {});
  const missing = layoutKeys(config.layout ?? [])
    .filter((k) => !k.includes('[]') && !k.includes('.'))
    .filter((k) => !props.includes(k));
  assert.deepStrictEqual(missing, []);
});

// The tile is on by default; the dropped switch options are gone from the UI,
// and a config that still carries them is not rejected for unknown keys.
test('fixedFanSpeed defaults to true and the dropped switch options are gone', () => {
  const props = config.schema.properties ?? {};
  assert.strictEqual(props.fixedFanSpeed?.type, 'boolean');
  assert.strictEqual(props.fixedFanSpeed?.default, true);
  assert.ok(!('fixedFanSpeedSwitch' in props));
  assert.ok(!('showFanAutoSwitch' in props));
  assert.ok(!('showVaneAutoSwitch' in props));
  assert.notStrictEqual(config.schema.additionalProperties, false);
});
