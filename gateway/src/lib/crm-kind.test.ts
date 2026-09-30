import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyWhatsAppCrmKind } from './crm-kind'

test('classifies WhatsApp consent and normal messages', () => {
  assert.equal(classifyWhatsAppCrmKind('STOP'), 'opt_out')
  assert.equal(classifyWhatsAppCrmKind('unsubscribe please'), 'opt_out')
  assert.equal(classifyWhatsAppCrmKind('START'), 'opt_in')
  assert.equal(classifyWhatsAppCrmKind('opt-in'), 'opt_in')
  assert.equal(classifyWhatsAppCrmKind('subscribe'), 'message')
  assert.equal(classifyWhatsAppCrmKind('Hi, I want the cash plan'), 'message')
})
