import assert from 'node:assert/strict'
import test from 'node:test'
import { toE164Phone, toWhatsAppRecipient } from './phone'

test('normalizes Indian WhatsApp recipients', () => {
  assert.equal(toWhatsAppRecipient('+91 98765 43210'), '919876543210')
  assert.equal(toE164Phone('9876543210'), '+919876543210')
})

test('rejects invalid Indian mobile numbers', () => {
  assert.equal(toWhatsAppRecipient('12345'), null)
  assert.equal(toWhatsAppRecipient('5123456789'), null)
})

