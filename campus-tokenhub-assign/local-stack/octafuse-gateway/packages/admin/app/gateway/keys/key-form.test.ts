/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyCreatePayload, buildKeyEditPayload, type KeyCreateDraft } from './key-form';

const draft: KeyCreateDraft = {
  user_id: ' user-1 ',
  email: '',
  external_system: '',
  external_user_id: '',
  name: ' agent ',
  metadata: '',
};
test('existing-user key creation trims fields and never sends external identity', () => {
  assert.deepEqual(
    buildKeyCreatePayload('existingUser', { ...draft, email: 'ignored@example.com' }),
    { user_id: 'user-1', name: 'agent', metadata: null, reason: 'gwui:new' }
  );
  assert.throws(
    () => buildKeyCreatePayload('existingUser', { ...draft, user_id: ' ' }),
    /userRequired/
  );
});
test('external identity creation requires a pair and valid email, never sends user_id', () => {
  const external = {
    ...draft,
    external_system: ' portal ',
    external_user_id: ' external-1 ',
    email: ' test@example.com ',
  };
  assert.deepEqual(buildKeyCreatePayload('externalIdentity', external), {
    external_system: 'portal',
    external_user_id: 'external-1',
    email: 'test@example.com',
    name: 'agent',
    metadata: null,
    reason: 'gwui:new',
  });
  assert.throws(
    () => buildKeyCreatePayload('externalIdentity', { ...external, external_user_id: '' }),
    /externalRequired/
  );
  assert.throws(
    () => buildKeyCreatePayload('externalIdentity', { ...external, email: '' }),
    /emailRequired/
  );
  assert.throws(
    () => buildKeyCreatePayload('externalIdentity', { ...external, email: 'broken' }),
    /emailInvalid/
  );
});
test('edit keeps zero distinct from unlimited and never submits user quotas or status', () => {
  const base = { name: ' ', metadata: '', rateLimitRpm: '' };
  assert.deepEqual(buildKeyEditPayload(base), {
    name: null,
    metadata: null,
    rate_limit: null,
    reason: 'gwui:edit',
  });
  assert.deepEqual(buildKeyEditPayload({ ...base, rateLimitRpm: '0' }).rate_limit, { rpm: 0 });
  for (const rateLimitRpm of ['-1', '1.5', 'Infinity', 'NaN', '4oops'])
    assert.throws(() => buildKeyEditPayload({ ...base, rateLimitRpm }), /rpm/);
});
test('edit submits rpm and tpm independently and omits the blank dimension', () => {
  const base = { name: '', metadata: '', rateLimitRpm: '', rateLimitTpm: '' };
  assert.deepEqual(buildKeyEditPayload({ ...base, rateLimitRpm: '60', rateLimitTpm: '200000' }).rate_limit, {
    rpm: 60,
    tpm: 200000,
  });
  assert.deepEqual(buildKeyEditPayload({ ...base, rateLimitRpm: '60' }).rate_limit, { rpm: 60 });
  assert.deepEqual(buildKeyEditPayload({ ...base, rateLimitTpm: '200000' }).rate_limit, {
    tpm: 200000,
  });
  assert.deepEqual(buildKeyEditPayload({ ...base, rateLimitTpm: '0' }).rate_limit, { tpm: 0 });
  assert.equal(buildKeyEditPayload(base).rate_limit, null);
  // 空白字符等同于留空
  assert.deepEqual(buildKeyEditPayload({ ...base, rateLimitTpm: '  ' }).rate_limit, null);
});

test('edit rejects invalid tpm with the tpm error code', () => {
  const base = { name: '', metadata: '', rateLimitRpm: '', rateLimitTpm: '' };
  for (const rateLimitTpm of ['-1', '1.5', 'Infinity', 'NaN', '4oops'])
    assert.throws(() => buildKeyEditPayload({ ...base, rateLimitTpm }), /tpm/);
});

test('metadata validation preserves existing JSON value contract and rejects invalid JSON', () => {
  assert.equal(
    buildKeyCreatePayload('existingUser', { ...draft, metadata: '{ "plan": "pro" }' }).metadata,
    '{"plan":"pro"}'
  );
  assert.equal(buildKeyCreatePayload('existingUser', { ...draft, metadata: '[]' }).metadata, '[]');
  assert.throws(
    () => buildKeyCreatePayload('existingUser', { ...draft, metadata: '{' }),
    /metadata/
  );
  assert.throws(
    () => buildKeyEditPayload({ name: '', rateLimitRpm: '', metadata: '{' }),
    /metadata/
  );
});
