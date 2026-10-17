// OpenAI chat completions with tool calling, for the SMS conversation.

export async function chat(ctx, messages, tools) {
  const base = ctx.env.OPENAI_BASE_URL ?? "https://api.openai.com";
  const res = await ctx.http({
    method: "POST",
    url: `${base}/v1/chat/completions`,
    headers: { authorization: `Bearer ${ctx.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: ctx.env.FIRSTRING_SMS_MODEL ?? "gpt-4.1-mini", temperature: 0.3, messages, tools, tool_choice: "auto" }),
    timeoutMs: 20_000,
  });
  if (res.status !== 200) throw new Error(`openai ${res.status}: ${String(res.text).slice(0, 200)}`);
  return res.data.choices[0].message;
}
