const express = require('express');
const router = express.Router();

const ERLC_BASE_URL = "https://api.policeroleplay.community/v1";

// Server configuration object (stores the active key for this session/instance)
const serverConfig = {
  apiKey: process.env.ERLC_API_KEY || null
};

/**
 * Route: Set or update the ER:LC API key dynamically
 * Owner can POST to /api/erlc/config when configuring/creating the CAD server instance
 */
router.post('/config', (req, res) => {
  const { apiKey } = req.body;

  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ error: "Invalid API key provided." });
  }

  serverConfig.apiKey = apiKey.trim();

  return res.json({
    success: true,
    message: "ER:LC API Key successfully configured!"
  });
});

/**
 * Route: Check if the API key has been configured
 */
router.get('/status', (req, res) => {
  res.json({
    configured: Boolean(serverConfig.apiKey && serverConfig.apiKey !== "YOUR_ERLC_API_KEY_HERE")
  });
});

/**
 * Route: Get Online Server Players
 */
router.get('/players', async (req, res) => {
  try {
    if (!serverConfig.apiKey || serverConfig.apiKey === "YOUR_ERLC_API_KEY_HERE") {
      // Mock Fallback Data if key hasn't been set by owner yet
      return res.json([
        { Name: "Officer_Jake", Permission: "Police", Team: "Police" },
        { Name: "John Doe", Permission: "Civilian", Team: "Civilian" },
        { Name: "SpeedyDriver22", Permission: "Civilian", Team: "Civilian" }
      ]);
    }

    const response = await fetch(`${ERLC_BASE_URL}/server/players`, {
      headers: { "Server-Key": serverConfig.apiKey }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "ER:LC API request failed. Verify your Server API Key." });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to connect to ER:LC API", details: err.message });
  }
});

/**
 * Route: Get Server Info
 */
router.get('/info', async (req, res) => {
  try {
    if (!serverConfig.apiKey || serverConfig.apiKey === "YOUR_ERLC_API_KEY_HERE") {
      return res.json({ Name: "Unconfigured Server (Demo Mode)", Players: 0, MaxPlayers: 30 });
    }

    const response = await fetch(`${ERLC_BASE_URL}/server`, {
      headers: { "Server-Key": serverConfig.apiKey }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "Failed to authenticate with ER:LC API." });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch ER:LC server stats" });
  }
});

module.exports = router;
