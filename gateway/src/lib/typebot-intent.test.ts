import assert from 'node:assert/strict'
import test from 'node:test'
import { intentFromChoice, isTypebotEmail, isTypebotGreeting, otpDigits } from './typebot-intent'

test('reads the published Typebot menu choices', () => {
  assert.equal(intentFromChoice('Sign in'), 'signin')
  assert.equal(intentFromChoice('My account'), 'account')
  assert.equal(intentFromChoice('Talk to support'), 'support')
  assert.equal(intentFromChoice('hello'), null)
})

test('accepts a greeting, an email, and a 6-digit code', () => {
  assert.equal(isTypebotGreeting('Menu'), true)
  assert.equal(isTypebotGreeting('hi there'), true)
  assert.equal(isTypebotGreeting('you@example.com'), false)
  assert.equal(isTypebotEmail('you@example.com'), true)
  assert.equal(isTypebotEmail('not an email'), false)
  assert.equal(otpDigits('123456'), '123456')
  assert.equal(otpDigits('12 34 56'), '123456')
  assert.equal(otpDigits('12345'), null)
})
