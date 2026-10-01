/** 简单寒暄不适合作为会话标题；等用户提出实际问题后再生成。 */
export function isSmallTalkQuestion(question: string): boolean {
  const normalized = question
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");

  return /^(你好|你好呀|你好啊|您好|嗨|嗨嗨|哈喽|在吗|你在吗|有人吗|早|早上好|上午好|中午好|下午好|晚上好|早安|晚安|你好吗|最近怎么样|谢谢|感谢|hello|hi|hey|hithere|goodmorning|goodevening|goodafternoon|thankyou|thx|thanks)$/.test(normalized);
}
