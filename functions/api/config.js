export async function onRequestGet(context) {
  const { env } = context;
  const raw = await env.RF_STORE.get("config");

  if (!raw) {
    return Response.json({ isSetup: false });
  }

  const config = JSON.parse(raw);
  return Response.json({
    isSetup: true,
    teamName: config.teamName,
    masterDesignId: config.masterDesignId,
  });
}

export async function onRequestPost(context) {
  const { env } = context;
  const body = await context.request.json();

  if (body.action === "verify") {
    const raw = await env.RF_STORE.get("config");
    const stored = raw ? JSON.parse(raw) : null;
    const pin = stored?.adminPin || env.ADMIN_PIN || "0000";
    return Response.json({ valid: body.pin === pin });
  }

  if (body.action === "save") {
    // If config already exists, require PIN
    const existing = await env.RF_STORE.get("config");
    if (existing) {
      const stored = JSON.parse(existing);
      const pin = stored.adminPin || env.ADMIN_PIN || "0000";
      if (body.pin !== pin) {
        return Response.json({ error: "Invalid PIN" }, { status: 403 });
      }
    }

    const config = {
      teamName: body.teamName,
      masterDesignId: body.masterDesignId,
      apiToken: body.apiToken,
      adminPin: body.adminPin,
      updatedAt: new Date().toISOString(),
    };

    await env.RF_STORE.put("config", JSON.stringify(config));

    // Clear page cache so next fetch pulls fresh data
    await env.RF_STORE.delete("pages_cache");

    return Response.json({ success: true, teamName: config.teamName });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}
