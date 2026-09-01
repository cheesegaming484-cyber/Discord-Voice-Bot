import { Router, type IRouter } from "express";

const router: IRouter = Router();
const REQUIRED_PERMISSIONS =
  2_048 /* Send Messages */ +
  1_048_576 /* Connect */ +
  2_097_152 /* Speak */;

router.get("/invite", (_req, res) => {
  const clientId = process.env["CLIENT_ID"];

  if (!clientId) {
    res.status(503).json({ error: "CLIENT_ID is not configured." });
    return;
  }

  const inviteUrl = new URL("https://discord.com/oauth2/authorize");
  inviteUrl.searchParams.set("client_id", clientId);
  inviteUrl.searchParams.set("scope", "bot applications.commands");
  inviteUrl.searchParams.set(
    "permissions",
    String(REQUIRED_PERMISSIONS),
  );

  res.redirect(inviteUrl.toString());
});

export default router;