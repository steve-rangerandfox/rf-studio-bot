import { generateDeck } from "../../lib/deck/logic.js";

export async function onRequestPost(context) {
  const { env } = context;
  const body = await context.request.json();

  try {
    const result = await generateDeck(env, body);
    return Response.json(result);
  } catch (err) {
    const status = err.message.includes("Not configured") ? 400
      : err.message.includes("Missing API") ? 400
      : err.message.includes("Clone failed") ? 502
      : 500;
    return Response.json({ error: err.message }, { status });
  }
}
