// Vercel API Route - imports and exports the main app from ../index.js
console.log("Loading API route at", new Date().toISOString());
const app = require("../index.js");
console.log("Main app imported successfully");
module.exports = app;
