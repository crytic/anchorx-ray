import express from "express";
import fs from "fs";
import path from "path";
import open from "open";

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "../public")));

app.get("/data", (req, res) => {
  const dataPath = path.join(process.cwd(), "accounts.json");
  if (fs.existsSync(dataPath)) {
    res.sendFile(dataPath);
  } else {
    res.status(404).send({ error: "accounts.json not found" });
  }
});

export function startServer() {
  app.listen(PORT, async () => {
    console.log(`🌍 Visualization running at http://localhost:${PORT}`);
    await open(`http://localhost:${PORT}`);
  });
}