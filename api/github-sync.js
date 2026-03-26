// api/github-sync.js
// API Vercel — processa lotes do Supabase e salva no GitHub

import { Octokit } from "@octokit/rest";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO  = process.env.GITHUB_REPO;
const GITHUB_FILE  = "messages_db.json";

const SB_HDR = {
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json",
};

// ═══════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action;

  try {
    if (req.method === "GET" && action === "messages") {
      const db = await loadMessagesDb();
      return res.status(200).json(db);
    }

    if (req.method === "GET" && action === "pending") {
      const batches = await fetchPendingBatches(100);
      return res.status(200).json({ count: batches.length, batches: batches.map(b => b.batch_token) });
    }

    if (req.method === "GET" && action === "status") {
      const status = await fetchStatus();
      return res.status(200).json(status);
    }

    if (req.method === "POST" && action === "process") {
      const result = await processAllBatches();
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: "Ação inválida. Use: messages, pending, status, process" });

  } catch (err) {
    console.error("Erro na API:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════
//  BUSCA LOTES PENDENTES
// ═══════════════════════════════════════════════════

async function fetchPendingBatches(limit = 20) {
  const url = `${SUPABASE_URL}/rest/v1/batches?select=batch_token,data,created_at&order=created_at.asc&limit=${limit}`;
  const r = await fetch(url, { headers: SB_HDR });
  if (!r.ok) throw new Error(`Supabase fetchBatches: ${r.status}`);
  return await r.json();
}

// ═══════════════════════════════════════════════════
//  APAGA VÁRIOS LOTES DE UMA VEZ
// ═══════════════════════════════════════════════════

async function deleteBatches(tokens) {
  if (!tokens.length) return;
  const inClause = tokens.map(t => encodeURIComponent(t)).join(",");
  const url = `${SUPABASE_URL}/rest/v1/batches?batch_token=in.(${inClause})`;
  const r = await fetch(url, { method: "DELETE", headers: SB_HDR });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Supabase deleteBatches: ${r.status} — ${text}`);
  }
  console.log(`🗑️ ${tokens.length} lote(s) deletados do Supabase`);
}

// ═══════════════════════════════════════════════════
//  CARREGA messages_db.json DO GITHUB
//  usa download_url (raw) para não truncar arquivos grandes
// ═══════════════════════════════════════════════════

async function loadMessagesDb() {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo:  GITHUB_REPO,
      path:  GITHUB_FILE,
    });
    const r = await fetch(data.download_url);
    if (!r.ok) throw new Error(`GitHub raw fetch: ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e.status === 404) return {};
    throw e;
  }
}

// ═══════════════════════════════════════════════════
//  SALVA messages_db.json NO GITHUB (1x por chamada)
// ═══════════════════════════════════════════════════

async function saveMessagesDb(db) {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  let sha = undefined;
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo:  GITHUB_REPO,
      path:  GITHUB_FILE,
    });
    sha = data.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  const content = Buffer.from(JSON.stringify(db), "utf-8").toString("base64");
  const payload = {
    owner:   GITHUB_OWNER,
    repo:    GITHUB_REPO,
    path:    GITHUB_FILE,
    message: `bot: atualiza mensagens — ${new Date().toISOString()}`,
    content,
    branch:  "main",
  };
  if (sha) payload.sha = sha;

  await octokit.repos.createOrUpdateFileContents(payload);
}

// ═══════════════════════════════════════════════════
//  PROCESSA LOTES
//  - Pega no máx 20 lotes por vez (evita timeout Vercel)
//  - Mescla TUDO na memória primeiro
//  - Salva no GitHub UMA única vez
//  - Deleta todos do Supabase UMA única vez
// ═══════════════════════════════════════════════════

async function processAllBatches() {
  const batches = await fetchPendingBatches(20);

  if (batches.length === 0) {
    return { processed: 0, added: 0, message: "Nenhum lote pendente" };
  }

  const db = await loadMessagesDb();
  let totalAdded = 0;

  // Mescla todos na memória sem salvar ainda
  for (const batch of batches) {
    const msgs = Array.isArray(batch.data) ? batch.data : [];

    for (const msg of msgs) {
      const key = `${msg.guild_id}:${msg.channel_id}`;
      if (!db[key]) db[key] = [];

      const ids = new Set(db[key].map(m => m.message_id));
      if (!ids.has(msg.message_id)) {
        db[key].push(msg);
        totalAdded++;
      } else {
        const idx = db[key].findIndex(m => m.message_id === msg.message_id);
        if (idx !== -1) db[key][idx] = msg;
      }
    }
  }

  // Ordena uma vez só
  for (const key of Object.keys(db)) {
    db[key].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  // Salva no GitHub UMA vez
  await saveMessagesDb(db);

  // Deleta todos do Supabase de uma vez
  const tokens = batches.map(b => b.batch_token);
  await deleteBatches(tokens);

  console.log(`✅ ${batches.length} lote(s) processados — ${totalAdded} msgs novas`);

  return {
    processed: batches.length,
    added:     totalAdded,
    message:   `${batches.length} lote(s) processado(s), ${totalAdded} mensagens novas`,
  };
}

// ═══════════════════════════════════════════════════
//  STATUS — MÉTRICAS PARA O PAINEL WEB
// ═══════════════════════════════════════════════════

async function fetchStatus() {
  const [batches, db] = await Promise.all([
    fetchPendingBatches(100).catch(() => []),
    loadMessagesDb().catch(() => ({})),
  ]);

  let totalMsgs     = 0;
  let totalChannels = 0;
  const totalGuilds = new Set();
  const channelStats = [];

  for (const [key, msgs] of Object.entries(db)) {
    if (!Array.isArray(msgs) || msgs.length === 0) continue;
    totalMsgs += msgs.length;
    totalChannels++;
    const [gid] = key.split(":");
    totalGuilds.add(gid);

    const first = msgs[0];
    const last  = msgs[msgs.length - 1];
    channelStats.push({
      key,
      guild_name:   first.guild_name   || gid,
      channel_name: first.channel_name || key,
      count:        msgs.length,
      first_msg:    first.timestamp,
      last_msg:     last.timestamp,
    });
  }

  const pendingMsgs = batches.reduce((acc, b) => {
    return acc + (Array.isArray(b.data) ? b.data.length : 0);
  }, 0);

  let oldestBatchAge = null;
  if (batches.length > 0 && batches[0].created_at) {
    const diffMs = Date.now() - new Date(batches[0].created_at).getTime();
    oldestBatchAge = Math.round(diffMs / 1000);
  }

  const topChannels = [...channelStats]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    summary: {
      total_messages:      totalMsgs,
      total_channels:      totalChannels,
      total_guilds:        totalGuilds.size,
      pending_batches:     batches.length,
      pending_msgs:        pendingMsgs,
      oldest_batch_age_s:  oldestBatchAge,
    },
    top_channels: topChannels,
    recent_batches: batches.slice(0, 5).map(b => ({
      token:      b.batch_token,
      msgs:       Array.isArray(b.data) ? b.data.length : 0,
      created_at: b.created_at,
    })),
    generated_at: new Date().toISOString(),
  };
}
