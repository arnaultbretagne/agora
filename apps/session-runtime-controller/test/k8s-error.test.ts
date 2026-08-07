import assert from 'node:assert/strict'
import test from 'node:test'
import { describeK8sError } from '../src/k8s-client.js'

/**
 * Real body, copied verbatim from what the cluster actually answered on 2026-08-07 when a Session
 * could not be provisioned. The controller reported only "-> 403", so the investigation went
 * through RBAC and admission policy before a hand-built dry-run surfaced the quota — the API had
 * been saying so in this exact field the whole time.
 */
const REAL_QUOTA_REFUSAL = {
  kind: 'Status',
  apiVersion: 'v1',
  status: 'Failure',
  message:
    'pods "sr-1" is forbidden: exceeded quota: agora-runs-quota, requested: requests.cpu=270m,requests.memory=320Mi, used: requests.cpu=810m,requests.memory=960Mi, limited: requests.cpu=1,requests.memory=1Gi',
  reason: 'Forbidden',
  code: 403,
}

test('required: an API refusal carries the reason the API gave, not just its status code', () => {
  const message = describeK8sError('POST', '/api/v1/namespaces/agora-runs/pods', 403, REAL_QUOTA_REFUSAL)
  assert.match(message, /exceeded quota: agora-runs-quota/, 'the operator must be able to read the cause without reproducing it')
  assert.match(message, /-> 403/, 'the status code stays — it classifies the failure')
})

test('a body with no message degrades to the status code rather than inventing one', () => {
  assert.equal(describeK8sError('GET', '/api/v1/pods', 500, undefined), 'k8s API GET /api/v1/pods -> 500')
  assert.equal(describeK8sError('GET', '/api/v1/pods', 500, 'plain text body'), 'k8s API GET /api/v1/pods -> 500')
  assert.equal(describeK8sError('GET', '/api/v1/pods', 500, { message: 42 }), 'k8s API GET /api/v1/pods -> 500')
})
