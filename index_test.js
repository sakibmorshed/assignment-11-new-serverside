const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.json({ message: "Hello from Vercel" });
});

app.get("/test", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

module.exports = app;
