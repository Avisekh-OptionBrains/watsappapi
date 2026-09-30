export function mapChoiceReply(
  text: string,
  choices: Array<{ id?: string; content?: string }>,
): string {
  const numeric = Number(text.trim())
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
    return choices[numeric - 1].content || choices[numeric - 1].id || text
  }

  const normalized = text.trim().toLowerCase()
  const matching = choices.find(
    (choice) =>
      choice.content?.toLowerCase() === normalized ||
      choice.id?.toLowerCase() === normalized ||
      (normalized.includes('kyc') && choice.content?.toLowerCase().includes('kyc')) ||
      (normalized.includes('plan') && choice.content?.toLowerCase().includes('plan')) ||
      (normalized.includes('status') && choice.content?.toLowerCase().includes('status')) ||
      (normalized.includes('sign') && choice.content?.toLowerCase().includes('sign')) ||
      (normalized.includes('subscri') && choice.content?.toLowerCase().includes('subscri')) ||
      (normalized.includes('support') && choice.content?.toLowerCase().includes('support')) ||
      (normalized.includes('menu') && choice.content?.toLowerCase().includes('menu')) ||
      (normalized.includes('back') && choice.content?.toLowerCase().includes('back')),
  )
  return matching?.content || matching?.id || text
}
