import express from "express";
import {
  getGoogleAuthUrl,
  handleGoogleOAuthCallback,
  isGoogleOAuthConfigured,
} from "../services/googleCalendarService.js";

const router = express.Router();

router.get("/auth/google", (req, res) => {
  if (!isGoogleOAuthConfigured()) {
    return res.status(500).json({
      error:
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.",
    });
  }

  const authUrl = getGoogleAuthUrl();
  res.redirect(authUrl);
});

router.get("/auth/google/callback", async (req, res) => {
  try {
    if (!isGoogleOAuthConfigured()) {
      return res.status(500).json({
        error:
          "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.",
      });
    }

    const { code } = req.query;
    if (!code || typeof code !== "string") {
      return res.status(400).json({ error: "Missing OAuth code" });
    }

    await handleGoogleOAuthCallback(code);
    console.log("[google-oauth] Google account connected successfully");
    res.redirect("/");
  } catch (error) {
    console.error("[google-oauth] Callback error:", error);
    res.status(500).json({ error: "Failed to connect Google account" });
  }
});

export default router;
