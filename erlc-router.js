const express = require('express');
const router = express.Router();

const ERLC_BASE_URL = "https://api.policeroleplay.community/v1";

// Server configuration object
const serverConfig = {
  apiKey: process.env.ERLC_API_KEY || null
};

/**
 * Dynamic configuration endpoint for server owners
 */
router.post('/config', (req, res) => {
  const { apiKey } = req.body;

  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ error: "Invalid API key provided." });
  }

  serverConfig.apiKey = apiKey.trim();
  return res.json({ success: true, message: "ER:LC API Key configured." });
});

/**
 * Check configuration status
 */
router.get('/status', (req, res) => {
  res.json({ configured: Boolean(serverConfig.apiKey) });
});

/**
 * Fetch connected player roster
 */
router.get('/players', async (req, res) => {
  try {
    if (!serverConfig.apiKey) {
      // Mock Fallback Data when key is not set
      return res.json([
        { Name: "Officer_Jake", Permission: "Police", Team: "Police" },
        { Name: "John Doe", Permission: "Civilian", Team: "Civilian" }
      ]);
    }

    const response = await fetch(`${ERLC_BASE_URL}/server/players`, {
      headers: { "Server-Key": serverConfig.apiKey }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "ER:LC API request failed." });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to connect to ER:LC API", details: err.message });
  }
});

module.exports = router;
