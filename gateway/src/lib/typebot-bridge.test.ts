import assert from 'node:assert/strict'
import test from 'node:test'
import { mapChoiceReply } from './choice-map'
import { formatChoiceLines, stripChoiceNumberPrefix } from '../clients/typebot'

const choices = [
  { id: 'opt_signin', content: 'Sign in / Subscribe' },
  { id: 'opt_status', content: 'My status' },
  { id: 'opt_support', content: 'Talk to support' },
]

test('maps numeric WhatsApp replies to Typebot choice content', () => {
  assert.equal(mapChoiceReply('1', choices), 'Sign in / Subscribe')
  assert.equal(mapChoiceReply('2', choices), 'My status')
  assert.equal(mapChoiceReply('3', choices), 'Talk to support')
})

test('maps common natural-language choice replies', () => {
  assert.equal(mapChoiceReply('I need support help', choices), 'Talk to support')
  assert.equal(mapChoiceReply('status please', choices), 'My status')
})

test('strips duplicate numbering from choice labels', () => {
  assert.equal(stripChoiceNumberPrefix('1. Sign in / Subscribe'), 'Sign in / Subscribe')
  assert.equal(
    formatChoiceLines([
      { content: '1. Sign in / Subscribe' },
      { content: 'My status' },
      { content: '3) Talk to support' },
    ]),
    '1. Sign in / Subscribe\n2. My status\n3. Talk to support',
  )
})
